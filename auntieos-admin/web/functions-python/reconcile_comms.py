"""Auntie OS — Comms reconcile pipeline.

Watches the four comms log collections for docs with reconcileStatus=pending,
matches each to a Kinfolk by phone or email, and folds the message into the
matched Kinfolk's Dossier via Claude Sonnet (claude_merge). The stub path
(--use-stub) appends a literal trail entry for plumbing tests without LLM cost.

Fail-loud: LLM errors mark reconcileStatus=error with a note; no silent fallback.

Run:
    python3 reconcile_comms.py                          # one pass, Claude merge
    python3 reconcile_comms.py --use-stub               # one pass, stub merge
    python3 reconcile_comms.py --dry-run                # print diffs, no writes
    python3 reconcile_comms.py --kinfolk-id <id>        # only that kinfolk
    python3 reconcile_comms.py --watch                  # loop every --interval seconds

Cloud Function: main.py calls init_firebase() + reconcile_pass() directly.
  Service account JSON is NOT needed in Cloud Function context — ADC is used.
  ANTHROPIC_API_KEY is bound as an env var via Secret Manager (secrets=[...]).
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT     = Path(__file__).resolve().parent.parent.parent  # AuntieOS root when running locally
SERVICE_ACCOUNT  = PROJECT_ROOT / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"

# Firestore collection name -> short channel label used in trail entries and
# matching logic. Must stay in sync with the four data classes in
# AuntieOS/android/.../data/model/Models.kt and AuntieOS/web/.../FirestoreClient.kt.
LOG_COLLECTIONS = {
    "voicemails":      "voicemail",
    "calls_log":       "call",
    "sms_messages":    "sms",
    "emails":          "email",
    "kin_care_reports": "kintale",
    # Tribal Intel (Phase 12 / spec 23): admin-authored notes targeting a
    # Kinfolk (household) or a single Kin (pet). Resolved by targetKinfolkId.
    "training_documents": "note",
}

# Maximum number of pending logs to process in one pass — keeps each invocation
# bounded so a backlog doesn't take the whole worker down on an exception.
DEFAULT_MAX_PER_RUN = 25


# ---------- helpers ----------

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_phone(raw: str) -> str:
    """Last-10-digit normalization. Cheap and tolerant of formatting differences."""
    digits = "".join(c for c in (raw or "") if c.isdigit())
    return digits[-10:] if len(digits) >= 10 else digits


def init_firebase():
    """Initialize Firebase Admin SDK.

    Cloud Function context: initialize_app() is already called in main.py with
    default credentials (ADC / service account attached to the Cloud Function).
    The _apps guard ensures we do not double-initialize.

    CLI / local context: if the service account JSON exists on disk (one level up
    from AuntieOS root), use it explicitly. Otherwise fall back to ADC.
    """
    if not firebase_admin._apps:
        if SERVICE_ACCOUNT.exists():
            firebase_admin.initialize_app(credentials.Certificate(str(SERVICE_ACCOUNT)))
        else:
            # ADC fallback — used in Cloud Function (already initialized by main.py)
            # or when running locally with gcloud application-default credentials.
            firebase_admin.initialize_app()
    return firestore.client()


# ---------- kinfolk resolution ----------

# Sentinel: returned when a log matches MORE THAN ONE distinct kinfolk (e.g. two
# kinfolk share the same last-10 phone digits). The caller must mark the source
# log reconcileStatus="error" (ambiguous) rather than silently folding the
# message into the wrong kinfolk's profile (WARNING-30).
AMBIGUOUS_MATCH = object()


def build_kinfolk_contact_index(db) -> dict:
    """Stream the kinfolk collection ONCE and build an in-memory contact index.

    WARNING-29: find_kinfolk_by_contact previously streamed the ENTIRE kinfolk
    collection for every phone/email log. On a nightly pass over many pending
    logs that is O(logs × kinfolk) reads. We stream kinfolk once per pass and
    reuse the result.

    Returns a dict:
        {
          "by_phone": { normalized_last10 -> {kinfolk_id, ...} },
          "by_email": { lowercased_email   -> {kinfolk_id, ...} },
          "docs":     { kinfolk_id -> kinfolk_dict },
        }

    A single contact value can map to MORE THAN ONE kinfolk (duplicate phone /
    email across households). We keep the full set so the matcher can surface
    that as AMBIGUOUS_MATCH instead of silently first-winning (WARNING-30
    parity).
    """
    by_phone: dict[str, set[str]] = {}
    by_email: dict[str, set[str]] = {}
    docs: dict[str, dict] = {}
    for snap in db.collection("kinfolk").stream():
        d = snap.to_dict() or {}
        docs[snap.id] = d
        for field in ("phoneNumber", "secondaryPhone"):
            key = normalize_phone(d.get(field) or "")
            if len(key) >= 10:
                by_phone.setdefault(key, set()).add(snap.id)
        for field in ("email", "secondaryEmail"):
            val = (d.get(field) or "").strip().lower()
            if val:
                by_email.setdefault(val, set()).add(snap.id)
    return {"by_phone": by_phone, "by_email": by_email, "docs": docs}


def _candidate_email_addresses(log: dict) -> list[str]:
    """Pick the COUNTERPARTY email address(es) to match a kinfolk against.

    WARNING-31: matching only fromAddress (or toAddresses[0]) silently fails for
    OUTBOUND business->kinfolk emails — the kinfolk is the recipient there, so
    we'd match the business's own from-address (never a kinfolk) and skip forever.

    Direction resolution:
      - direction == "inbound"  -> match fromAddress (kinfolk is the sender)
      - direction == "outbound" -> match ALL toAddresses (kinfolk is a recipient)
      - unknown/absent          -> defensive: try fromAddress AND all toAddresses
    """
    direction = (log.get("direction") or "").strip().lower()
    from_addr = (log.get("fromAddress") or "").strip().lower()
    to_addrs = [
        (a or "").strip().lower()
        for a in (log.get("toAddresses") or [])
        if (a or "").strip()
    ]
    if direction == "inbound":
        candidates = [from_addr]
    elif direction == "outbound":
        candidates = list(to_addrs)
    else:
        # Direction unknown — be defensive and consider both ends.
        candidates = ([from_addr] if from_addr else []) + to_addrs
    # De-dupe, preserve order, drop blanks.
    seen: set[str] = set()
    out: list[str] = []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def find_kinfolk_by_contact(db, channel: str, log: dict, index: dict | None = None):
    """Match a log entry to a Kinfolk record.

    Args:
        index: optional pre-built contact index from build_kinfolk_contact_index.
            When supplied, phone/email lookups resolve from memory instead of
            streaming the whole kinfolk collection per log (WARNING-29). When
            None, falls back to a live full-collection stream (behavior parity
            with the pre-index matcher).

    Returns:
        (kinfolkId, kinfolkDict) on a single unambiguous hit;
        AMBIGUOUS_MATCH if >1 DISTINCT kinfolk match (caller marks 'error');
        None on miss (caller marks 'skipped' — no fabricated data lands).
    """
    if channel == "kintale":
        kfid = (log.get("kinfolkId") or "").strip()
        if not kfid:
            return None
        snap = db.collection("kinfolk").document(kfid).get()
        if not snap.exists:
            return None
        return kfid, snap.to_dict() or {}

    if channel == "note":
        # Tribal Intel note: resolve directly by the admin-chosen targetKinfolkId.
        kfid = (log.get("targetKinfolkId") or log.get("kinfolkRef") or "").strip()
        if not kfid:
            return None
        snap = db.collection("kinfolk").document(kfid).get()
        if not snap.exists:
            return None
        return kfid, snap.to_dict() or {}

    if channel == "email":
        candidates = _candidate_email_addresses(log)
        if not candidates:
            return None
        candidate_set = set(candidates)
        # Collect ALL distinct kinfolk whose primary/secondary email is one of the
        # counterparty addresses, so a duplicate-email collision surfaces as
        # ambiguous instead of first-wins (WARNING-30 parity for email).
        hits: dict[str, dict] = {}
        if index is not None:
            # WARNING-29: resolve from the pre-built index — no per-log stream.
            for addr in candidate_set:
                for kfid in index["by_email"].get(addr, ()):
                    hits[kfid] = index["docs"].get(kfid, {})
        else:
            for snap in db.collection("kinfolk").stream():
                d = snap.to_dict() or {}
                emails = {
                    (d.get("email") or "").lower(),
                    (d.get("secondaryEmail") or "").lower(),
                }
                if emails & candidate_set:
                    hits[snap.id] = d
        if not hits:
            return None
        if len(hits) > 1:
            return AMBIGUOUS_MATCH
        kfid = next(iter(hits))
        return kfid, hits[kfid]

    # voicemail / call / sms — match by phone
    raw_number = (log.get("callerNumber")
                  or log.get("counterpartNumber")
                  or "")
    needle = normalize_phone(raw_number)
    # Reject short needles: a <10-digit needle would let normalize_phone's
    # suffix match collide across unrelated numbers. Require a full 10-digit key.
    if len(needle) < 10:
        return None
    # Collect ALL distinct kinfolk whose phone matches; >1 is ambiguous, never
    # first-wins into the wrong profile (WARNING-30).
    hits: dict[str, dict] = {}
    if index is not None:
        # WARNING-29: resolve from the pre-built index — no per-log stream.
        for kfid in index["by_phone"].get(needle, ()):
            hits[kfid] = index["docs"].get(kfid, {})
    else:
        for snap in db.collection("kinfolk").stream():
            d = snap.to_dict() or {}
            for field in ("phoneNumber", "secondaryPhone"):
                if normalize_phone(d.get(field) or "") == needle:
                    hits[snap.id] = d
                    break
    if not hits:
        return None
    if len(hits) > 1:
        return AMBIGUOUS_MATCH
    kfid = next(iter(hits))
    return kfid, hits[kfid]


# ---------- body extraction ----------

def extract_log_body(log: dict) -> str:
    """Pull the human-readable text out of a log doc across all channels.

    Tribal Intel notes carry title/content/notes (no transcript/body). We fold
    those in. Attachments are cited as provenance ONLY: the LLM cannot read
    image/file bytes, so we append a synthesized provenance line listing the
    file names + URLs and never claim to have analyzed them.
    """
    parts = []
    # Notes (Tribal Intel) fields first so they take effect for the note channel.
    for key in ("title", "content", "notes"):
        val = (log.get(key) or "").strip()
        if val:
            parts.append(val)
    # Standard comms fields.
    transcript = (log.get("transcript") or "").strip()
    if transcript:
        parts.append(transcript)
    body = (log.get("body") or log.get("bodyCopy") or "").strip()
    if body:
        parts.append(body)
    subject = (log.get("subject") or "").strip()
    if subject and subject not in parts:
        parts.insert(0, subject)

    text = "\n".join(p for p in parts if p).strip()

    attachments = log.get("attachments") or []
    if attachments:
        cited = []
        for a in attachments:
            if isinstance(a, dict):
                name = (a.get("fileName") or "file").strip()
                url = (a.get("storageUrl") or "").strip()
                cited.append(f"{name} ({url})" if url else name)
        if cited:
            text = (text + "\n" if text else "") + (
                f"Attachments ({len(cited)} file(s), provenance only, not analyzed): "
                + "; ".join(cited)
            )

    return text or "(no content)"


# ---------- recent-comms recap (admin callable: recap_recent_comms) ----------

RECAP_COLLECTIONS = {
    "sms_messages": "sms",
    "emails":       "email",
    "calls_log":    "call",
    "voicemails":   "voicemail",
}


def collect_recent_comms(db, kinfolk_id: str, per_collection_limit: int = 10, total_limit: int = 15) -> list[dict]:
    """Read recent sms/email/call/voicemail docs where kinfolkId == kinfolk_id.

    Returns a list of {channel, timestamp, text} sorted newest-first (lexicographic
    on the ISO timestamp string), capped at total_limit. Empty list if none.
    No order_by in the query (avoids a composite index requirement) — recency is
    resolved by the in-memory sort.
    """
    out: list[dict] = []
    for coll, channel in RECAP_COLLECTIONS.items():
        try:
            snaps = (db.collection(coll)
                       .where("kinfolkId", "==", kinfolk_id)
                       .limit(per_collection_limit)
                       .stream())
        except Exception:
            snaps = iter(())
        for snap in snaps:
            d = snap.to_dict() or {}
            ts = (d.get("timestamp") or d.get("sentAt") or "").strip()
            out.append({"channel": channel, "timestamp": ts, "text": extract_log_body(d)})
    out.sort(key=lambda e: e["timestamp"], reverse=True)
    return out[:total_limit]


def claude_recap(entries: list[dict]) -> str:
    """1-2 sentence factual recap of where recent comms last left off. Fail-loud.

    API key priority mirrors claude_merge: os.environ (Secret Manager) > .env file.
    """
    import os
    from anthropic import Anthropic
    from dotenv import dotenv_values

    env_file = Path(__file__).resolve().parent / ".env"
    dot_env = dotenv_values(env_file) if env_file.exists() else {}
    env = {**dot_env, **os.environ}
    api_key = env.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY missing from env / Secret Manager (fail-loud)")
    model = env.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")

    lines = "\n".join(f"[{e['channel']} | {e['timestamp']}] {e['text']}" for e in entries)
    system = (
        "You write a 1-2 sentence factual recap of where a pet-care client's recent "
        "communications last left off, for an admin about to message them. No greeting, "
        "no preamble, no invented facts — only what the messages state. Plain language."
    )
    user = f"Recent communications (newest first):\n\n{lines}\n\nWrite the 1-2 sentence recap."
    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=model, max_tokens=200, temperature=0.2,
        system=system, messages=[{"role": "user", "content": user}],
    )
    return (resp.content[0].text if resp.content else "").strip()


# ---------- merge step ----------

def claude_merge(kinfolk_name: str, existing_summary: str, channel: str, log_id: str, log: dict, ts: str) -> tuple[str, dict, str]:
    """LLM merge: call Claude Sonnet to weave new log fact into rolling summary.

    Fail-loud: any Claude error raises (caller decides retry/skip).
    Reuses reconcile_prompts.build_dossier_prompt + extract_summary + extract_fields.

    Returns:
        (summary, fields, tldr) where fields is a dict of structured Dossier
        fields that Claude confidently extracted (empty dict if none extracted)
        and tldr is a fresh <=2-sentence plain-language recap, regenerated each
        run (NOT byte-frozen like rawSummary); empty string if Claude emitted none.

    API key priority: os.environ["ANTHROPIC_API_KEY"] (Secret Manager binding in
    Cloud Function) > .env file on disk (local CLI runs).
    """
    import os
    from anthropic import Anthropic
    from dotenv import dotenv_values
    from reconcile_prompts import build_dossier_prompt, extract_summary, extract_fields, extract_tldr

    env_file = Path(__file__).resolve().parent / ".env"
    # Guard: dotenv_values raises on missing file in some versions.
    dot_env = dotenv_values(env_file) if env_file.exists() else {}
    # os.environ takes priority — Secret Manager binds ANTHROPIC_API_KEY here.
    env = {**dot_env, **os.environ}
    api_key = env.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY missing from env / Secret Manager (fail-loud)")
    model = env.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")

    body = extract_log_body(log)
    new_entry = {
        "channel":   channel,
        "timestamp": log.get("timestamp") or log.get("visitDate") or log.get("sentAt") or ts,
        "id":        log_id,
        "body":      body,
    }
    system_prompt, user_prompt = build_dossier_prompt(kinfolk_name, existing_summary, [new_entry])

    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=model,
        max_tokens=1500,
        temperature=0.2,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = resp.content[0].text if resp.content else ""
    summary = extract_summary(text).strip()
    if not summary:
        raise RuntimeError(f"Claude returned empty summary for {channel}/{log_id}")
    fields = extract_fields(text, doc_type="dossier")
    tldr = extract_tldr(text)
    return summary, fields, tldr


def stub_merge(existing_summary: str, channel: str, log_id: str, log: dict, ts: str) -> str:
    """STUB MERGE — appends a literal trail entry. Replace with Claude later.

    Real merge will: (1) extract intent + facts via LLM, (2) preserve the
    [[source: …]] citations and {{date, msgId}} supersession markers from
    project_auntieos_architecture.md, (3) update structured fields when
    operationally relevant.
    """
    raw = extract_log_body(log)
    snippet = raw[:240] + ("…" if len(raw) > 240 else "")
    # NOTE-60: emit a real [[source: ...]] citation so count_sources() sees the
    # stub-folded source. Without it every stub-built doc had zero citations and
    # was permanently flagged needsMoreSamples even after many merges. The marker
    # is keyed by channel/log_id so distinct source logs count as distinct
    # sources (the Claude path's citation format is unchanged).
    trail = (
        f"\n\n[reconcile-stub @ {ts}, source={channel}/{log_id}]\n"
        f"Raw: {snippet} [[source: stub {channel}/{log_id}]]"
    )
    return (existing_summary or "").rstrip() + trail


def upsert_dossier(db, kinfolk_id: str, new_summary: str, ts: str, source_id: str, needs_more_samples: bool = False, new_fields: dict | None = None, tldr: str = ""):
    """Find or create the Kinfolk's Dossier doc, write the new rawSummary +
    provenance. Keeps the most recent 10 source IDs in lastReconcileSourceLogIds.

    new_fields: structured Dossier fields extracted by Claude. Only keys whose
    current value is missing, empty, or "Not yet documented." will be written —
    operator-edited values are never overwritten.
    """
    from reconcile_prompts import merge_structured_fields
    q = db.collection("dossiers").where("kinfolkId", "==", kinfolk_id).limit(1).stream()
    existing = next(q, None)
    if existing is not None:
        ref = db.collection("dossiers").document(existing.id)
        prev = existing.to_dict() or {}
    else:
        # Deterministic doc-id == kinfolkId so the generator's point-read
        # (generate.js: dossiers.doc(kinfolkId)) finds a freshly-created dossier.
        # Was .document() (auto-id), which left auto-generated dossiers invisible
        # to the generator. the_411 already aligns (queried by the kinId field).
        ref  = db.collection("dossiers").document(kinfolk_id)
        prev = {"kinfolkId": kinfolk_id}
    ids = ([source_id] + (prev.get("lastReconcileSourceLogIds") or []))[:10]
    safe_fields = merge_structured_fields(prev, new_fields or {})
    ref.set({
        **prev,
        **safe_fields,
        "kinfolkId":                  kinfolk_id,
        "rawSummary":                 new_summary,
        "lastReconciledAt":           ts,
        "lastReconcileSourceLogIds":  ids,
        "needsMoreSamples":           needs_more_samples,
        **({"tldr": tldr} if tldr else {}),
    }, merge=True)
    return ref.id


def clear_dossier_household_notes_doc(db, kinfolk_id: str) -> bool:
    """Set householdNotes="" on the kinfolk's dossier doc, locating it the same way
    upsert_dossier does (query by kinfolkId, which handles legacy auto-id docs).

    Does NOT create a dossier if none exists (nothing to clear). Returns True if a
    doc was found and cleared, False if there was no dossier.
    """
    q = db.collection("dossiers").where("kinfolkId", "==", kinfolk_id).limit(1).stream()
    existing = next(q, None)
    if existing is None:
        return False
    db.collection("dossiers").document(existing.id).set({"householdNotes": ""}, merge=True)
    return True


def claude_merge_411(kin_name: str, kin_species: str, existing_summary: str, channel: str, log_id: str, log: dict, ts: str) -> tuple[str, dict, str]:
    """LLM merge for per-kin 411. Same fail-loud semantics as claude_merge.

    Calls build_411_prompt (kin name + species context) instead of build_dossier_prompt.
    Fail-loud: any Claude error raises (caller decides retry/skip).

    Returns:
        (summary, fields, tldr) where fields is a dict of structured Kin411
        fields that Claude confidently extracted (empty dict if none extracted)
        and tldr is a fresh <=2-sentence plain-language recap, regenerated each
        run (NOT byte-frozen like rawSummary); empty string if Claude emitted none.

    API key priority: os.environ["ANTHROPIC_API_KEY"] (Secret Manager binding in
    Cloud Function) > .env file on disk (local CLI runs).
    """
    import os
    from anthropic import Anthropic
    from dotenv import dotenv_values
    from reconcile_prompts import build_411_prompt, extract_summary, extract_fields, extract_tldr

    env_file = Path(__file__).resolve().parent / ".env"
    # Guard: dotenv_values raises on missing file in some versions.
    dot_env = dotenv_values(env_file) if env_file.exists() else {}
    # os.environ takes priority — Secret Manager binds ANTHROPIC_API_KEY here.
    env = {**dot_env, **os.environ}
    api_key = env.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY missing from env / Secret Manager (fail-loud)")
    model = env.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")

    body = extract_log_body(log)
    new_entry = {
        "channel":   channel,
        "timestamp": log.get("timestamp") or log.get("visitDate") or log.get("sentAt") or ts,
        "id":        log_id,
        "body":      body,
    }
    system_prompt, user_prompt = build_411_prompt(kin_name, kin_species, existing_summary, [new_entry])
    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=model,
        max_tokens=1500,
        temperature=0.2,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = resp.content[0].text if resp.content else ""
    summary = extract_summary(text).strip()
    if not summary:
        raise RuntimeError(f"Claude returned empty 411 summary for {channel}/{log_id}")
    fields = extract_fields(text, doc_type="kin411")
    tldr = extract_tldr(text)
    return summary, fields, tldr


def upsert_kin411(db, kin_id: str, new_summary: str, ts: str, source_id: str, needs_more_samples: bool = False, new_fields: dict | None = None, tldr: str = "") -> str:
    """Find or create the_411 for this kin; write new rawSummary + provenance.

    Keeps the most recent 10 source IDs in lastReconcileSourceLogIds.
    Doc ID: preserved if existing; otherwise deterministic f'411_{kin_id}'.

    new_fields: structured Kin411 fields extracted by Claude. Only keys whose
    current value is missing, empty, or "Not yet documented." will be written —
    operator-edited values are never overwritten.
    """
    from reconcile_prompts import merge_structured_fields
    q = db.collection("the_411").where("kinId", "==", kin_id).limit(1).stream()
    existing = next(q, None)
    if existing is not None:
        ref = db.collection("the_411").document(existing.id)
        prev = existing.to_dict() or {}
    else:
        ref  = db.collection("the_411").document(f"411_{kin_id}")
        prev = {"kinId": kin_id}
    ids = ([source_id] + (prev.get("lastReconcileSourceLogIds") or []))[:10]
    safe_fields = merge_structured_fields(prev, new_fields or {})
    ref.set({
        **prev,
        **safe_fields,
        "kinId":                      kin_id,
        "rawSummary":                 new_summary,
        "lastUpdated":                ts,
        "lastReconciledAt":           ts,
        "lastReconcileSourceLogIds":  ids,
        "needsMoreSamples":           needs_more_samples,
        **({"tldr": tldr} if tldr else {}),
    }, merge=True)
    return ref.id


def kin_ids_for_household(db, kinfolk_id: str, log: dict, channel: str) -> list[str]:
    """Derive kin IDs to fan out a 411 update to.

    Source order: (1) note channel targeting a single KIN -> [targetKinId],
                  (2) log.kinIds[] if non-empty (kintale w/ kinIds populated),
                  (3) query kin.where('kinfolkId','==',kinfolk_id), actual linkage direction.

    A Tribal Intel note targeting a KINFOLK (household) falls through to (3) and
    fans out to every kin in the household; a note targeting a single KIN folds
    only into that one pet's 411.
    """
    if channel == "note" and (log.get("targetType") or "").upper() == "KIN":
        single = (log.get("targetKinId") or "").strip()
        if single:
            return [single]
    explicit = list(log.get("kinIds") or [])
    if explicit:
        return explicit
    snaps = db.collection("kin").where("kinfolkId", "==", kinfolk_id).stream()
    return [s.id for s in snaps]


# ---------- claim-first helpers ----------

def claim_log_atomic(db, coll: str, log_id: str, ts: str) -> bool:
    """Atomically claim a log doc for processing.

    Reads the doc inside a Firestore transaction. If reconcileStatus != 'pending',
    aborts and returns False (already claimed, applied, skipped, or errored). If
    pending, sets reconcileStatus='in_progress' and reconcileClaimedAt=ts, then
    returns True.

    A crash AFTER this returns True but BEFORE the caller marks 'applied' is the
    SAFE failure mode: the doc stays 'in_progress', not 'pending', so the next
    pass's 'pending' query skips it rather than re-merging.  The lease timestamp
    lets a future reclaim sweep recover orphaned in_progress docs.

    Falls back to a non-transactional check-and-set when db.transaction() is not
    available (e.g. the in-memory fake used in unit tests).  The fake is
    single-threaded so the race cannot occur there.

    Fail-loud: any transaction error propagates to the caller.
    """
    doc_ref = db.collection(coll).document(log_id)

    # Real Firestore path: use a transaction for atomicity.
    if hasattr(db, "transaction"):
        from firebase_admin import firestore as _fs

        @_fs.transactional
        def _claim(transaction):
            snap = doc_ref.get(transaction=transaction)
            if not snap.exists:
                return False
            data = snap.to_dict() or {}
            status = (data.get("reconcileStatus") or "pending").strip().lower()
            if status != "pending":
                return False
            transaction.update(doc_ref, {
                "reconcileStatus":    "in_progress",
                "reconcileClaimedAt": ts,
            })
            return True

        txn = db.transaction()
        return _claim(txn)

    # Fallback for unit-test FakeDb (no transaction() method):
    # synchronous check-and-set — safe because tests are single-threaded.
    snap = doc_ref.get()
    if not snap.exists:
        return False
    data = snap.to_dict() or {}
    status = (data.get("reconcileStatus") or "pending").strip().lower()
    if status != "pending":
        return False
    doc_ref.update({
        "reconcileStatus":    "in_progress",
        "reconcileClaimedAt": ts,
    })
    return True


# ---------- main loop ----------

def reconcile_pass(
    db,
    max_per_run: int = DEFAULT_MAX_PER_RUN,
    use_stub: bool = False,
    kinfolk_id_filter: str | None = None,
    dry_run: bool = False,
) -> int:
    processed = 0
    # WARNING-29: stream the kinfolk collection ONCE per pass and reuse the
    # in-memory contact index across every log, instead of a full-collection
    # stream per phone/email log.
    contact_index = build_kinfolk_contact_index(db)
    for coll, channel in LOG_COLLECTIONS.items():
        if processed >= max_per_run:
            break
        budget = max_per_run - processed

        # WARNING-32: query kin_care_reports with the same reconcileStatus==pending
        # filter as the other collections so already-applied/skipped docs don't
        # consume the .limit(budget) and starve genuinely-pending docs. Legacy
        # docs missing the field are backfilled to 'pending' by the one-off
        # backfill_kincare_reconcile_status.py migration (operator-run).
        q_iter = (db.collection(coll)
                    .where("reconcileStatus", "==", "pending")
                    .limit(budget)
                    .stream())

        # Drain stream into memory before per-doc Claude calls — long LLM latency
        # would otherwise time out the Firestore stream cursor.
        snaps = list(q_iter)
        for snap in snaps:
            log    = snap.to_dict() or {}
            log_id = snap.id
            ts     = utc_now_iso()
            source_id = f"{coll}/{log_id}"

            match = find_kinfolk_by_contact(db, channel, log, index=contact_index)
            contact = (log.get("callerNumber")
                       or log.get("counterpartNumber")
                       or log.get("fromAddress")
                       or log.get("kinfolkId")
                       or "unknown")

            # AMBIGUOUS: >1 distinct kinfolk matched (e.g. shared last-10 phone or
            # duplicate email). Mark 'error' (not 'skipped', not 'applied') so the
            # log is retried/triaged rather than folded into the WRONG profile
            # (WARNING-30). Never guess a winner.
            if match is AMBIGUOUS_MATCH:
                if not dry_run:
                    claim_log_atomic(db, coll, log_id, ts)
                    db.collection(coll).document(log_id).update({
                        "reconcileStatus": "error",
                        "reconciledAt":    ts,
                        "reconcileNotes":  f"ambiguous match: multiple kinfolk share contact {contact}",
                    })
                print(f"[{ts}] {source_id} → ERROR (ambiguous: multiple kinfolk for {contact})"
                      + (" [DRY-RUN: reconcileStatus write skipped]" if dry_run else ""))
                processed += 1
                continue

            if match is None:
                if not dry_run:
                    # claim before marking skipped so a concurrent worker can't
                    # race to also mark it (idempotent: skipped is the right outcome).
                    claim_log_atomic(db, coll, log_id, ts)
                    db.collection(coll).document(log_id).update({
                        "reconcileStatus": "skipped",
                        "reconciledAt":    ts,
                        "reconcileNotes":  f"no kinfolk match for {contact}",
                    })
                print(f"[{ts}] {source_id} → SKIP (no kinfolk for {contact})"
                      + (" [DRY-RUN: reconcileStatus write skipped]" if dry_run else ""))
                processed += 1
                continue

            kinfolk_id, kf = match

            # NOTE-59: kinfolk_id_filter is applied as early as possible — right
            # after the cheap in-memory match and BEFORE the expensive Claude
            # merge — so a filtered run never burns an LLM call on a non-matching
            # log. We DO count filtered-out logs against `processed` so max_per_run
            # actually bounds a filtered run (otherwise a filter that skips most
            # logs would scan unbounded entries). We do NOT claim them — they stay
            # pending so the next unfiltered pass can pick them up normally.
            if kinfolk_id_filter and kinfolk_id != kinfolk_id_filter:
                processed += 1
                continue

            # ---- claim-first -------------------------------------------------------
            # Atomically flip reconcileStatus pending -> in_progress BEFORE any
            # expensive work (Claude calls, dossier writes).  If the claim fails it
            # means another worker beat us to it (or the doc was already applied /
            # skipped / in_progress from a previous crashed run) — skip silently.
            # dry_run never mutates, so skip claiming entirely there.
            if not dry_run:
                claimed = claim_log_atomic(db, coll, log_id, ts)
                if not claimed:
                    print(f"[{ts}] {source_id} → SKIP (claim failed — already in_progress/applied/skipped)")
                    continue
            # ------------------------------------------------------------------------

            kinfolk_name = f"{kf.get('firstName', '')} {kf.get('lastName', '')}".strip() or kinfolk_id

            existing_q = db.collection("dossiers").where("kinfolkId", "==", kinfolk_id).limit(1).stream()
            existing   = next(existing_q, None)
            prev_summary = (existing.to_dict() or {}).get("rawSummary", "") if existing else ""

            if use_stub:
                new_summary = stub_merge(prev_summary, channel, log_id, log, ts)
                new_dossier_fields: dict = {}
                new_dossier_tldr = ""
                merge_label = "stub-append"
            else:
                try:
                    new_summary, new_dossier_fields, new_dossier_tldr = claude_merge(kinfolk_name, prev_summary, channel, log_id, log, ts)
                    merge_label = "claude-merge"
                except Exception as e:
                    print(f"[{ts}] {source_id} → CLAUDE_ERROR: {e}")
                    if not dry_run:
                        db.collection(coll).document(log_id).update({
                            "reconcileStatus": "error",
                            "reconciledAt":    ts,
                            "reconcileNotes":  f"claude_merge failed: {str(e)[:200]}",
                        })
                    else:
                        print(f"  [DRY-RUN: would set reconcileStatus=error on {source_id}]")
                    processed += 1
                    continue

            # ---------- Kin411 fan-out ----------
            # Derive kin IDs: priority (1) log.kinIds[] if non-empty,
            # (2) query kin.where('kinfolkId','==',kinfolk_id) for actual linkage.
            fan_kin_ids = kin_ids_for_household(db, kinfolk_id, log, channel)

            # Fail-loud: kintale reports with no kin IDs is unusual.
            if channel == "kintale" and not fan_kin_ids:
                print(f"[{ts}] {source_id} → WARNING: kintale for kinfolk/{kinfolk_id} "
                      f"has no kin IDs; skipping 411 fan-out (dossier-only update)")

            touched_411_ids: list[str] = []
            # WARNING-33: track whether ANY 411 fan-out failed. A failed 411 must
            # NOT let the source log be marked 'applied' (which would retire it
            # forever, silently dropping the 411 update). On failure we mark the
            # log 'partial' so a later pass re-attempts the fan-out.
            kin411_had_error = False
            for kin_id in fan_kin_ids:
                kin_snap = db.collection("kin").document(kin_id).get()
                if not kin_snap.exists:
                    print(f"[{ts}] {source_id} → WARNING: kin/{kin_id} not found; skipping 411 update")
                    continue
                kin_doc = kin_snap.to_dict() or {}
                kin_name    = (kin_doc.get("name") or kin_id)
                kin_species = (kin_doc.get("species") or "")

                # Fetch existing 411 rawSummary for this kin
                prev_411_q   = db.collection("the_411").where("kinId", "==", kin_id).limit(1).stream()
                prev_411_doc = next(prev_411_q, None)
                prev_411     = (prev_411_doc.to_dict() or {}).get("rawSummary", "") if prev_411_doc else ""

                if use_stub:
                    new_411 = stub_merge(prev_411, channel, log_id, log, ts)
                    new_411_fields: dict = {}
                    new_411_tldr = ""
                else:
                    try:
                        new_411, new_411_fields, new_411_tldr = claude_merge_411(kin_name, kin_species, prev_411, channel, log_id, log, ts)
                    except Exception as e:
                        print(f"[{ts}] {source_id} → KIN411_CLAUDE_ERROR kin/{kin_id}: {e}")
                        # Fail-loud: record the failure and continue to other kin in
                        # the fan-out; the log will be marked 'partial' (not 'applied')
                        # so this kin's 411 is retried on a later pass (WARNING-33).
                        touched_411_ids.append(f"ERROR(kin/{kin_id})")
                        kin411_had_error = True
                        continue

                if dry_run:
                    print(f"  [DRY-RUN] kin/{kin_id} ({kin_name}, {kin_species}) 411 fan-out:")
                    print(f"    PREV_411: {(prev_411 or '(empty)')[:300]}")
                    print(f"    NEW_411:  {new_411[:300]}")
                    if new_411_fields:
                        print(f"    NEW_411_FIELDS: {new_411_fields}")
                else:
                    from reconcile_prompts import count_sources
                    needs_more_411 = count_sources(new_411) < 3
                    doc_id = upsert_kin411(db, kin_id, new_411, ts, source_id, needs_more_411, new_fields=new_411_fields, tldr=new_411_tldr)
                    touched_411_ids.append(f"the_411/{doc_id}")
                    print(f"[{ts}] {source_id} → kin/{kin_id} ({kin_name}) → the_411/{doc_id}")

            # ---------- Dossier write + source log mark ----------
            reconcile_note_parts = [f"{merge_label} → dossiers/{{dossier_id}}"]
            if touched_411_ids:
                reconcile_note_parts.append("411s: " + ", ".join(touched_411_ids))

            if dry_run:
                print(f"[{ts}] {source_id} → kinfolk/{kinfolk_id} ({kinfolk_name}) [DRY-RUN]")
                print(f"  PREV_SUMMARY: {(prev_summary or '(empty)')[:300]}")
                print(f"  NEW_SUMMARY:  {new_summary[:300]}")
                if new_dossier_fields:
                    print(f"  NEW_DOSSIER_FIELDS: {new_dossier_fields}")
                print(f"  [DRY-RUN: would upsert dossiers for kinfolk/{kinfolk_id} and mark {source_id} applied]")
            else:
                from reconcile_prompts import count_sources
                needs_more_dossier = count_sources(new_summary) < 3
                dossier_id = upsert_dossier(db, kinfolk_id, new_summary, ts, source_id, needs_more_dossier, new_fields=new_dossier_fields, tldr=new_dossier_tldr)
                reconcile_note = "; ".join(reconcile_note_parts).replace("{dossier_id}", dossier_id)
                # WARNING-33: if any 411 fan-out failed, the dossier write succeeded
                # but the slice is incomplete. Mark 'partial' (a non-terminal status
                # the 'pending' query also ignores) rather than 'applied', so an
                # operator/retry can re-attempt the failed 411(s) without re-merging
                # the dossier blindly. Detect failure via the flag AND any lingering
                # ERROR(...) marker (defensive).
                fan_failed = kin411_had_error or any(
                    isinstance(x, str) and x.startswith("ERROR(") for x in touched_411_ids
                )
                final_status = "partial" if fan_failed else "applied"
                db.collection(coll).document(log_id).update({
                    "reconcileStatus": final_status,
                    "reconciledAt":    ts,
                    "reconcileNotes":  reconcile_note,
                })
                print(f"[{ts}] {source_id} → kinfolk/{kinfolk_id} ({kinfolk_name})"
                      + ("  [PARTIAL: 411 fan-out had errors — will retry]" if fan_failed else ""))

            processed += 1
    return processed


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--watch",        action="store_true", help="poll forever")
    p.add_argument("--interval",     type=int, default=60, help="seconds between polls when --watch")
    p.add_argument("--max-per-run",  type=int, default=DEFAULT_MAX_PER_RUN,
                   help=f"max logs to process per pass (default: {DEFAULT_MAX_PER_RUN})")
    p.add_argument("--use-stub",     action="store_true",
                   help="use stub_merge (literal trail append) instead of Claude; zero LLM cost")
    p.add_argument("--kinfolk-id",   metavar="ID",
                   help="only reconcile entries that resolve to this kinfolk ID")
    p.add_argument("--dry-run",      action="store_true",
                   help="print intended writes (prev + new summary) but skip all Firestore writes")
    args = p.parse_args()

    db = init_firebase()
    if not SERVICE_ACCOUNT.exists():
        print(f"[reconcile] connected via ADC (no service account JSON at {SERVICE_ACCOUNT})")
    else:
        print(f"[reconcile] connected via {SERVICE_ACCOUNT.name}")
    if args.dry_run:
        print("[reconcile] DRY-RUN mode: no Firestore writes will occur.")
    if args.use_stub:
        print("[reconcile] STUB mode: using stub_merge (no LLM calls).")
    if args.kinfolk_id:
        print(f"[reconcile] kinfolk filter: {args.kinfolk_id}")

    pass_kwargs = dict(
        use_stub=args.use_stub,
        kinfolk_id_filter=args.kinfolk_id,
        dry_run=args.dry_run,
    )

    if args.watch:
        print(f"[reconcile] watching every {args.interval}s. Ctrl-C to stop.")
        try:
            while True:
                n = reconcile_pass(db, args.max_per_run, **pass_kwargs)
                if n == 0:
                    print(f"[{utc_now_iso()}] (no pending)")
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\n[reconcile] stopped.")
    else:
        n = reconcile_pass(db, args.max_per_run, **pass_kwargs)
        print(f"[reconcile] processed {n} log(s).")


if __name__ == "__main__":
    main()
