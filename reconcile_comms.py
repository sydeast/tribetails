"""Auntie OS — Comms reconcile pipeline.

==============================================================================
!! DEPRECATED / STALE COPY — DO NOT EDIT, DO NOT DEPLOY !!

The CANONICAL reconcile module is:
    web/functions-python/reconcile_comms.py

That copy is the one Firebase deploys (firebase.json -> functions "source":
"functions-python", codebase "reconcile") and the one that receives all bug
fixes. THIS root-level file has diverged from it (WARNING-34) and is retained
only because the sibling root test (test_reconcile_docid.py) still imports it.
Any new work — matching, budgeting, kin_care_reports handling, stub citations —
must go in web/functions-python/reconcile_comms.py, not here.
==============================================================================

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
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT     = Path(__file__).resolve().parent.parent
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
    if not SERVICE_ACCOUNT.exists():
        sys.exit(
            f"[reconcile] Service account JSON not found at {SERVICE_ACCOUNT}.\n"
            f"  Set the path in this script if your service account lives elsewhere."
        )
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(str(SERVICE_ACCOUNT)))
    return firestore.client()


# ---------- kinfolk resolution ----------

def find_kinfolk_by_contact(db, channel: str, log: dict):
    """Match a log entry to a Kinfolk record.

    Returns (kinfolkId, kinfolkDict) on hit, or None on miss. The miss path is
    handled upstream by marking the source log reconcileStatus="skipped" with a
    note — no fabricated data lands in any profile.
    """
    if channel == "kintale":
        kfid = (log.get("kinfolkId") or "").strip()
        if not kfid:
            return None
        snap = db.collection("kinfolk").document(kfid).get()
        if not snap.exists:
            return None
        return kfid, snap.to_dict() or {}

    if channel == "email":
        addr = (log.get("fromAddress")
                or (log.get("toAddresses") or [""])[0]
                or "").strip().lower()
        if not addr:
            return None
        for snap in db.collection("kinfolk").stream():
            d = snap.to_dict() or {}
            if (d.get("email") or "").lower() == addr or \
               (d.get("secondaryEmail") or "").lower() == addr:
                return snap.id, d
        return None

    # voicemail / call / sms — match by phone
    raw_number = (log.get("callerNumber")
                  or log.get("counterpartNumber")
                  or "")
    needle = normalize_phone(raw_number)
    if not needle:
        return None
    for snap in db.collection("kinfolk").stream():
        d = snap.to_dict() or {}
        for field in ("phoneNumber", "secondaryPhone"):
            if normalize_phone(d.get(field) or "") == needle:
                return snap.id, d
    return None


# ---------- merge step ----------

def claude_merge(kinfolk_name: str, existing_summary: str, channel: str, log_id: str, log: dict, ts: str) -> tuple[str, dict]:
    """LLM merge: call Claude Sonnet to weave new log fact into rolling summary.

    Fail-loud: any Claude error raises (caller decides retry/skip).
    Reuses reconcile_prompts.build_dossier_prompt + extract_summary + extract_fields.

    Returns:
        (summary, fields) where fields is a dict of structured Dossier fields
        that Claude confidently extracted (empty dict if none extracted).
    """
    import os
    from anthropic import Anthropic
    from dotenv import dotenv_values
    from reconcile_prompts import build_dossier_prompt, extract_summary, extract_fields

    env_file = Path(__file__).resolve().parent / ".env"
    env = {**dotenv_values(env_file), **os.environ}
    api_key = env.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY missing from .env (fail-loud)")
    model = env.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")

    body = (log.get("transcript") or log.get("body") or log.get("bodyCopy") or
            " ".join(filter(None, [log.get("subject", ""), log.get("body", "")])).strip() or
            "(no content)")
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
    fields = extract_fields(text)
    return summary, fields


def stub_merge(existing_summary: str, channel: str, log_id: str, log: dict, ts: str) -> str:
    """STUB MERGE — appends a literal trail entry. Replace with Claude later.

    Real merge will: (1) extract intent + facts via LLM, (2) preserve the
    [[source: …]] citations and {{date, msgId}} supersession markers from
    project_auntieos_architecture.md, (3) update structured fields when
    operationally relevant.
    """
    raw = (
        log.get("transcript")
        or log.get("body")
        or " ".join(filter(None, [log.get("subject", ""), log.get("body", "")])).strip()
        or "(no content)"
    )
    snippet = raw[:240] + ("…" if len(raw) > 240 else "")
    trail = (
        f"\n\n[reconcile-stub @ {ts}, source={channel}/{log_id}]\n"
        f"Raw: {snippet}"
    )
    return (existing_summary or "").rstrip() + trail


def upsert_dossier(db, kinfolk_id: str, new_summary: str, ts: str, source_id: str, needs_more_samples: bool = False, new_fields: dict | None = None):
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
    }, merge=True)
    return ref.id


def claude_merge_411(kin_name: str, kin_species: str, existing_summary: str, channel: str, log_id: str, log: dict, ts: str) -> tuple[str, dict]:
    """LLM merge for per-kin 411. Same fail-loud semantics as claude_merge.

    Calls build_411_prompt (kin name + species context) instead of build_dossier_prompt.
    Fail-loud: any Claude error raises (caller decides retry/skip).

    Returns:
        (summary, fields) where fields is a dict of structured Kin411 fields
        that Claude confidently extracted (empty dict if none extracted).
    """
    import os
    from anthropic import Anthropic
    from dotenv import dotenv_values
    from reconcile_prompts import build_411_prompt, extract_summary, extract_fields

    env = {**dotenv_values(Path(__file__).resolve().parent / ".env"), **os.environ}
    api_key = env.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY missing from .env (fail-loud)")
    model = env.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")

    body = (log.get("transcript") or log.get("body") or log.get("bodyCopy") or
            " ".join(filter(None, [log.get("subject", ""), log.get("body", "")])).strip() or
            "(no content)")
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
    fields = extract_fields(text)
    return summary, fields


def upsert_kin411(db, kin_id: str, new_summary: str, ts: str, source_id: str, needs_more_samples: bool = False, new_fields: dict | None = None) -> str:
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
    }, merge=True)
    return ref.id


def kin_ids_for_household(db, kinfolk_id: str, log: dict, channel: str) -> list[str]:
    """Derive kin IDs to fan out a 411 update to.

    Source order: (1) log.kinIds[] if non-empty (kintale w/ kinIds populated),
                  (2) query kin.where('kinfolkId','==',kinfolk_id) — actual linkage direction.
    """
    explicit = list(log.get("kinIds") or [])
    if explicit:
        return explicit
    snaps = db.collection("kin").where("kinfolkId", "==", kinfolk_id).stream()
    return [s.id for s in snaps]


# ---------- main loop ----------

def reconcile_pass(
    db,
    max_per_run: int = DEFAULT_MAX_PER_RUN,
    use_stub: bool = False,
    kinfolk_id_filter: str | None = None,
    dry_run: bool = False,
) -> int:
    processed = 0
    for coll, channel in LOG_COLLECTIONS.items():
        if processed >= max_per_run:
            break
        budget = max_per_run - processed

        # kin_care_reports may lack reconcileStatus field on legacy docs — query all,
        # filter in-memory so we don't miss them due to missing field.
        if coll == "kin_care_reports":
            q_iter = db.collection(coll).limit(budget).stream()
        else:
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

            # In-memory status gate for kin_care_reports (field may be absent)
            if coll == "kin_care_reports":
                status = (log.get("reconcileStatus") or "pending").strip().lower()
                if status != "pending":
                    continue

            match = find_kinfolk_by_contact(db, channel, log)
            if match is None:
                contact = (log.get("callerNumber")
                           or log.get("counterpartNumber")
                           or log.get("fromAddress")
                           or log.get("kinfolkId")
                           or "unknown")
                if not dry_run:
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

            # kinfolk_id_filter: skip entries not matching the requested kinfolk
            if kinfolk_id_filter and kinfolk_id != kinfolk_id_filter:
                continue

            kinfolk_name = f"{kf.get('firstName', '')} {kf.get('lastName', '')}".strip() or kinfolk_id

            existing_q = db.collection("dossiers").where("kinfolkId", "==", kinfolk_id).limit(1).stream()
            existing   = next(existing_q, None)
            prev_summary = (existing.to_dict() or {}).get("rawSummary", "") if existing else ""

            if use_stub:
                new_summary = stub_merge(prev_summary, channel, log_id, log, ts)
                new_dossier_fields: dict = {}
                merge_label = "stub-append"
            else:
                try:
                    new_summary, new_dossier_fields = claude_merge(kinfolk_name, prev_summary, channel, log_id, log, ts)
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
                else:
                    try:
                        new_411, new_411_fields = claude_merge_411(kin_name, kin_species, prev_411, channel, log_id, log, ts)
                    except Exception as e:
                        print(f"[{ts}] {source_id} → KIN411_CLAUDE_ERROR kin/{kin_id}: {e}")
                        # Fail-loud: mark the source log with error note but continue
                        # to other kin in the fan-out before surfacing the error.
                        touched_411_ids.append(f"ERROR(kin/{kin_id})")
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
                    doc_id = upsert_kin411(db, kin_id, new_411, ts, source_id, needs_more_411, new_fields=new_411_fields)
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
                dossier_id = upsert_dossier(db, kinfolk_id, new_summary, ts, source_id, needs_more_dossier, new_fields=new_dossier_fields)
                reconcile_note = "; ".join(reconcile_note_parts).replace("{dossier_id}", dossier_id)
                db.collection(coll).document(log_id).update({
                    "reconcileStatus": "applied",
                    "reconciledAt":    ts,
                    "reconcileNotes":  reconcile_note,
                })
                print(f"[{ts}] {source_id} → kinfolk/{kinfolk_id} ({kinfolk_name})")

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
