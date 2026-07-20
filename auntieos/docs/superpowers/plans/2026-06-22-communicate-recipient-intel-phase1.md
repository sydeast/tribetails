# Communicate Recipient Intelligence — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Communicate recipient-context panel a useful read — short AI summaries (dossier `tldr` + per-kin 411 `tldr`) instead of full text, a disclosed "where things last left off" last-communication box, an "Admin only / internal" marker — and remove the misplaced Refresh-intelligence button (relocated in Phase 3).

**Architecture:** Backend `web/functions-python` (codebase `reconcile`, Anthropic) gains a `<tldr>` block in the existing synthesis LLM call (no extra call) plus a new admin-gated `recap_recent_comms` callable. Shared pure Kotlin helpers (duplicated verbatim across web `commonMain` and android — separate codebases, no shared module) drive the UI via TDD. A new flag `communicate.commsRecap` (default OFF) gates the AI recap, with a disclosed raw-latest fallback. All three platforms (web Wasm, desktop JVM, android) ship the reshaped panel.

**Tech Stack:** Python 3 + Firebase Functions (`https_fn.on_call`) + Anthropic SDK + pytest; Kotlin Multiplatform / Compose (web `commonMain`, `kotlin.test`); Kotlin / Compose android (`org.junit` + MockK); Firestore.

**Deploy:** operator-gated — NO deploy steps here. No git in any tree — NO commit steps. The `git add`/`git commit` step from the writing-plans template is intentionally omitted from every task.

---

## Deviations from the spec (decided during codebase mapping — read before starting)

1. **MyTribe flag registry = no code change.** Spec says add the flag to "MyTribe `getFeatureFlags` defaults." Mapping found MyTribe `functions/src/portal/getFeatureFlags.ts` has **no compile-time defaults catalog** — it is a pass-through merger of `business_settings/feature_flags.flags` (global) + `clients/{uid}.featureFlags` (per-user) and explicitly delegates the catalog to the client (`FeatureFlags.fromOverrides` ignores unknown keys). So parity is satisfied by the web + android registries alone; MyTribe already accepts any dotted key with zero change. Task 4 records this verification. This is honest, not a skipped requirement.
2. **Desktop (JVM) data is stubbed** — same as every existing feature. The reshaped panel + comms box compile and run on desktop; Firestore reads return stub/empty there (pre-existing limitation, not introduced here). Build gate for web is compile + `jvmTest`, which is unaffected.
3. **Web comms reads reuse the existing global streams** (`smsStream()`/`callsStream()`/`emailsStream()`/`voicemailsStream()` already wired in `FirestoreClient`/`InboxScreen`), filtered client-side by `kinfolkId`. This avoids new wasmJs/jvm interop actuals. Android adds one-shot `whereEqualTo("kinfolkId", …)` reads (cheap, native SDK).
4. **`missingHouseholdFields` helper is NOT in Phase 1.** Spec lists it under shared pure helpers, but it is only used by Phase 2 (household-notes migration). Phase 1 ships `summaryLine`, `latestCommunication`, `commsBoxState`. `clear_dossier_household_notes` callable is likewise Phase 2.
5. **Refresh button:** Phase 1 removes it from Communicate (per spec). The underlying `synthesizeProfile` client/VM method stays in place; Phase 3 adds the trigger to the profile screens.

---

## File Structure

**Backend — `web/functions-python/`**
- `reconcile_prompts.py` (modify) — add `extract_tldr` parser + `<tldr>` instructions in both system prompts + both user prompts.
- `reconcile_comms.py` (modify) — `claude_merge`/`claude_merge_411` return 3-tuple incl. tldr; `upsert_dossier`/`upsert_kin411` write `tldr`; `reconcile_pass` threads it; new `collect_recent_comms` + `claude_recap`.
- `main.py` (modify) — new `_recap_recent_comms` + decorated `recap_recent_comms` callable.
- `test_reconcile_prompts.py` (modify) — tests for `extract_tldr`.
- `test_reconcile_idempotency.py` (modify) — update `UpsertSpy` signature for the new `tldr` param.
- `test_recap_recent_comms.py` (create) — recap callable input-shaping + fallback + auth tests.

**Flags**
- `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/config/FeatureFlags.kt` (modify) + `…/commonTest/…/config/FeatureFlagsTest.kt` (modify).
- `android/app/src/main/java/com/tribetails/auntieos/config/FeatureFlags.kt` (modify) + `android/app/src/test/java/com/tribetails/auntieos/config/FeatureFlagsTest.kt` (modify).

**Pure helpers (net-new, duplicated)**
- `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/communicate/CommunicationHelpers.kt` (create) + `…/commonTest/…/screens/communicate/CommunicationHelpersTest.kt` (create).
- `android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicationHelpers.kt` (create) + `android/app/src/test/java/com/tribetails/auntieos/ui/communicate/CommunicationHelpersTest.kt` (create).

**Models**
- `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt` (modify) — add `tldr` to `Dossier` + `Kin411`; add `recapRecentComms` + `CommsRecap`.
- `android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt` (modify) — add `tldr` to `Dossier` + `Kin411`.

**UI / wiring**
- `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/communicate/CommunicateScreen.kt` (modify) — reshape panel + comms box + drop Refresh.
- `android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt` (modify) — comms reads + `recapRecentComms`.
- `android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicateViewModel.kt` (modify) — comms-box state + load.
- `android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicateScreen.kt` (modify) — reshape panel + comms box + drop Refresh.
- `android/app/src/test/java/com/tribetails/auntieos/ui/communicate/CommunicateViewModelTest.kt` (modify) — comms-box state test.

---

## Task 1: Backend — `extract_tldr` parser (TDD)

**Files:**
- Modify: `web/functions-python/reconcile_prompts.py` (regex near line 17–18; new fn after `extract_fields` ~line 211)
- Test: `web/functions-python/test_reconcile_prompts.py`

All commands run from `web/functions-python/` using its venv:
`PY=./venv/bin/python` (i.e. `/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web/functions-python/venv/bin/python`).

- [ ] **Step 1: Write the failing test.** Append to `test_reconcile_prompts.py`:

```python
from reconcile_prompts import extract_tldr


def test_extract_tldr_returns_inner_text_stripped():
    text = "<summary>x</summary>\n<fields>{}</fields>\n<tldr>  Two grandkids. Prefers SMS.  </tldr>"
    assert extract_tldr(text) == "Two grandkids. Prefers SMS."


def test_extract_tldr_missing_tag_returns_empty():
    # Unlike extract_summary, a missing <tldr> must NOT echo the whole response.
    assert extract_tldr("<summary>x</summary>") == ""


def test_extract_tldr_empty_input_returns_empty():
    assert extract_tldr("") == ""
    assert extract_tldr("   ") == ""


def test_extract_tldr_first_match_only():
    assert extract_tldr("<tldr>one</tldr><tldr>two</tldr>") == "one"
```

- [ ] **Step 2: Run the test to verify it fails.**
Run: `./venv/bin/python -m pytest test_reconcile_prompts.py -k tldr -v`
Expected: FAIL — `ImportError: cannot import name 'extract_tldr'`.

- [ ] **Step 3: Add the regex.** In `reconcile_prompts.py`, after line 18 (`_FIELDS_TAG_PATTERN = …`), add:

```python
_TLDR_TAG_PATTERN = re.compile(r"<tldr>(.*?)</tldr>", re.DOTALL)
```

- [ ] **Step 4: Implement `extract_tldr`.** In `reconcile_prompts.py`, after `extract_fields` (after line 210), add:

```python
def extract_tldr(claude_response_text: str) -> str:
    """Extract the text between the first <tldr>...</tldr> tags.

    Unlike extract_summary, a MISSING tag returns "" (never echoes the whole
    response) — tldr is optional/regenerated and a blank value is the correct
    zero-regression fallback signal (client falls back to truncated rawSummary).
    """
    if not claude_response_text or not claude_response_text.strip():
        return ""
    match = _TLDR_TAG_PATTERN.search(claude_response_text)
    if match:
        return match.group(1).strip()
    return ""
```

- [ ] **Step 5: Run the test to verify it passes.**
Run: `./venv/bin/python -m pytest test_reconcile_prompts.py -k tldr -v`
Expected: PASS (4 passed).

- [ ] **Step 6: Run the full prompts test file (no regression).**
Run: `./venv/bin/python -m pytest test_reconcile_prompts.py -v`
Expected: PASS (all green).

---

## Task 2: Backend — emit + persist `tldr` in synthesis

**Files:**
- Modify: `web/functions-python/reconcile_prompts.py` (`_DOSSIER_SYSTEM`, `_411_SYSTEM`, both user prompts)
- Modify: `web/functions-python/reconcile_comms.py` (`claude_merge`, `claude_merge_411`, `upsert_dossier`, `upsert_kin411`, `reconcile_pass`)
- Modify: `web/functions-python/test_reconcile_idempotency.py` (`UpsertSpy`)

- [ ] **Step 1: Add the `<tldr>` rule to `_DOSSIER_SYSTEM`.** In `reconcile_prompts.py`, replace the existing rule-10 line (line 37) with rule 10 + new rule 11:

```python
10. After the </summary> tag, on a new line, emit a <fields>...</fields> block containing a JSON object with structured fields you can confidently extract or update. Use null for fields you cannot determine. Do NOT invent values. Only fill from log evidence. Null = unknown.
11. After the </fields> tag, on a new line, emit a <tldr>...</tldr> block: at most 2 sentences, plain language, NO citation markers, summarizing the CURRENT overall picture of this household for an admin about to write to them. This is a fresh write each run (not frozen). If there is nothing meaningful yet, emit an empty <tldr></tldr>.
```

- [ ] **Step 2: Add the `<tldr>` rule to `_411_SYSTEM`.** In `reconcile_prompts.py`, replace the existing rule-10 line (line 66) with rule 10 + new rule 11:

```python
10. After the </summary> tag, on a new line, emit a <fields>...</fields> block containing a JSON object with structured fields you can confidently extract or update. Use null for fields you cannot determine. Do NOT invent values. Only fill from log evidence. Null = unknown.
11. After the </fields> tag, on a new line, emit a <tldr>...</tldr> block: at most 2 sentences, plain language, NO citation markers, summarizing THIS pet's current picture for an admin about to write to the household. Fresh write each run (not frozen). If nothing meaningful yet, emit an empty <tldr></tldr>.
```

- [ ] **Step 3: Update both user-prompt instruction lines.** In `reconcile_prompts.py`, in `build_dossier_prompt` (line 134) and `build_411_prompt` (line 168), replace the identical instruction line:

```
Update the summary following the system rules.  Return the <summary>...</summary> block, then the <fields>...</fields> block.
```
with:
```
Update the summary following the system rules.  Return the <summary>...</summary> block, then the <fields>...</fields> block, then the <tldr>...</tldr> block.
```

- [ ] **Step 4: Make `claude_merge` return tldr.** In `reconcile_comms.py`:
  - Change the import on line 206 to include `extract_tldr`:
    ```python
    from reconcile_prompts import build_dossier_prompt, extract_summary, extract_fields, extract_tldr
    ```
  - Change the return type hint on line 190 from `-> tuple[str, dict]` to `-> tuple[str, dict, str]`.
  - Replace lines 239–240 (`fields = extract_fields(text)` / `return summary, fields`) with:
    ```python
    fields = extract_fields(text)
    tldr = extract_tldr(text)
    return summary, fields, tldr
    ```

- [ ] **Step 5: Make `claude_merge_411` return tldr.** In `reconcile_comms.py`:
  - Change the import on line 311 to include `extract_tldr`:
    ```python
    from reconcile_prompts import build_411_prompt, extract_summary, extract_fields, extract_tldr
    ```
  - Change the return type hint on line 295 from `-> tuple[str, dict]` to `-> tuple[str, dict, str]`.
  - Replace lines 343–344 (`fields = extract_fields(text)` / `return summary, fields`) with:
    ```python
    fields = extract_fields(text)
    tldr = extract_tldr(text)
    return summary, fields, tldr
    ```

- [ ] **Step 6: Persist `tldr` in `upsert_dossier`.** In `reconcile_comms.py`:
  - Change the signature (line 260) to add a trailing `tldr` param:
    ```python
    def upsert_dossier(db, kinfolk_id: str, new_summary: str, ts: str, source_id: str, needs_more_samples: bool = False, new_fields: dict | None = None, tldr: str = ""):
    ```
  - In the `ref.set({...}, merge=True)` block (lines 283–291), add a conditional `tldr` write so an empty value (stub/no-LLM path) never clobbers an existing tldr. Replace the dict with:
    ```python
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
    ```

- [ ] **Step 7: Persist `tldr` in `upsert_kin411`.** In `reconcile_comms.py`:
  - Change the signature (line 347) to add a trailing `tldr` param:
    ```python
    def upsert_kin411(db, kin_id: str, new_summary: str, ts: str, source_id: str, needs_more_samples: bool = False, new_fields: dict | None = None, tldr: str = "") -> str:
    ```
  - Replace the `ref.set({...}, merge=True)` block (lines 368–377) with:
    ```python
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
    ```

- [ ] **Step 8: Thread tldr through `reconcile_pass` (dossier path).** In `reconcile_comms.py`:
  - Stub branch (lines 553–556): add a tldr var. Replace:
    ```python
            if use_stub:
                new_summary = stub_merge(prev_summary, channel, log_id, log, ts)
                new_dossier_fields: dict = {}
                merge_label = "stub-append"
    ```
    with:
    ```python
            if use_stub:
                new_summary = stub_merge(prev_summary, channel, log_id, log, ts)
                new_dossier_fields: dict = {}
                new_dossier_tldr = ""
                merge_label = "stub-append"
    ```
  - Claude branch (line 559): replace
    ```python
                    new_summary, new_dossier_fields = claude_merge(kinfolk_name, prev_summary, channel, log_id, log, ts)
    ```
    with
    ```python
                    new_summary, new_dossier_fields, new_dossier_tldr = claude_merge(kinfolk_name, prev_summary, channel, log_id, log, ts)
    ```
  - Upsert call (line 640): replace
    ```python
                dossier_id = upsert_dossier(db, kinfolk_id, new_summary, ts, source_id, needs_more_dossier, new_fields=new_dossier_fields)
    ```
    with
    ```python
                dossier_id = upsert_dossier(db, kinfolk_id, new_summary, ts, source_id, needs_more_dossier, new_fields=new_dossier_fields, tldr=new_dossier_tldr)
    ```

- [ ] **Step 9: Thread tldr through `reconcile_pass` (411 path).** In `reconcile_comms.py`:
  - Stub branch (lines 599–601): replace
    ```python
                if use_stub:
                    new_411 = stub_merge(prev_411, channel, log_id, log, ts)
                    new_411_fields: dict = {}
    ```
    with
    ```python
                if use_stub:
                    new_411 = stub_merge(prev_411, channel, log_id, log, ts)
                    new_411_fields: dict = {}
                    new_411_tldr = ""
    ```
  - Claude branch (line 604): replace
    ```python
                        new_411, new_411_fields = claude_merge_411(kin_name, kin_species, prev_411, channel, log_id, log, ts)
    ```
    with
    ```python
                        new_411, new_411_fields, new_411_tldr = claude_merge_411(kin_name, kin_species, prev_411, channel, log_id, log, ts)
    ```
  - Upsert call (line 621): replace
    ```python
                    doc_id = upsert_kin411(db, kin_id, new_411, ts, source_id, needs_more_411, new_fields=new_411_fields)
    ```
    with
    ```python
                    doc_id = upsert_kin411(db, kin_id, new_411, ts, source_id, needs_more_411, new_fields=new_411_fields, tldr=new_411_tldr)
    ```

- [ ] **Step 10: Update `UpsertSpy` for the new param.** In `test_reconcile_idempotency.py`, replace `UpsertSpy.__call__` (lines 137–139) with:

```python
    def __call__(self, db, kinfolk_id, new_summary, ts, source_id, needs_more, new_fields=None, tldr=""):
        self.call_count += 1
        return self._real(db, kinfolk_id, new_summary, ts, source_id, needs_more, new_fields, tldr)
```

- [ ] **Step 11: Run the full backend test suite (no regression).**
Run: `./venv/bin/python -m pytest -v`
Expected: PASS — all existing tests (`test_reconcile_prompts.py`, `test_reconcile_note.py`, `test_reconcile_idempotency.py`, `test_reconcile_note.py`, `test_synthesize_kinfolk_profile.py`) green. The stub-path reconcile tests exercise the new tldr threading (tldr="" => no clobber).

---

## Task 3: Backend — `recap_recent_comms` callable (TDD)

**Files:**
- Modify: `web/functions-python/reconcile_comms.py` (add `RECAP_COLLECTIONS`, `collect_recent_comms`, `claude_recap`)
- Modify: `web/functions-python/main.py` (add `_recap_recent_comms` + decorated `recap_recent_comms`)
- Test: `web/functions-python/test_recap_recent_comms.py` (create)

- [ ] **Step 1: Write the failing test.** Create `test_recap_recent_comms.py`:

```python
"""Tests for recap_recent_comms: collect_recent_comms shaping + _recap_recent_comms
auth/validation/fallback contract. No live LLM — the summarizer is injected.
"""
import pytest
from unittest.mock import MagicMock

from firebase_functions.https_fn import CallableRequest, FunctionsErrorCode, HttpsError
from firebase_functions.https_fn import AuthData

import reconcile_comms as rc
from main import _recap_recent_comms


# ---------- minimal in-memory fake db (collection().where().limit().stream()) ----------
class FakeSnap:
    def __init__(self, _id, data):
        self.id = _id
        self._data = data
    def to_dict(self):
        return dict(self._data)

class FakeQuery:
    def __init__(self, docs):
        self._docs = docs
    def where(self, field, op, value):
        return FakeQuery([d for d in self._docs if (d._data.get(field) == value)])
    def limit(self, n):
        return FakeQuery(self._docs[:n])
    def stream(self):
        return iter(self._docs)

class FakeCollection(FakeQuery):
    pass

class FakeDb:
    def __init__(self):
        self.data = {}
    def collection(self, name):
        docs = [FakeSnap(k, v) for k, v in self.data.get(name, {}).items()]
        return FakeCollection(docs)

FAKE_DB = FakeDb()


def _make_req(data, auth):
    return CallableRequest(data=data, raw_request=MagicMock(), auth=auth)

def _admin():
    return AuthData(uid="admin-uid", token={"uid": "admin-uid", "admin": True})

def _non_admin():
    return AuthData(uid="u", token={"uid": "u"})


# ---------- collect_recent_comms ----------
def test_collect_orders_newest_first_and_filters_by_kinfolk():
    db = FakeDb()
    db.data["sms_messages"] = {
        "s1": {"kinfolkId": "kf1", "timestamp": "2026-06-01T10:00:00Z", "body": "older sms"},
        "s2": {"kinfolkId": "kf1", "timestamp": "2026-06-10T10:00:00Z", "body": "newest sms"},
        "sX": {"kinfolkId": "OTHER", "timestamp": "2026-06-20T10:00:00Z", "body": "not mine"},
    }
    db.data["emails"] = {
        "e1": {"kinfolkId": "kf1", "timestamp": "2026-06-05T10:00:00Z", "subject": "Re: visit"},
    }
    out = rc.collect_recent_comms(db, "kf1")
    assert [e["channel"] for e in out] == ["sms", "email", "sms"]
    assert out[0]["timestamp"] == "2026-06-10T10:00:00Z"
    assert "not mine" not in " ".join(e["text"] for e in out)


def test_collect_empty_when_no_match():
    db = FakeDb()
    db.data["sms_messages"] = {"s1": {"kinfolkId": "OTHER", "timestamp": "2026-06-01T10:00:00Z", "body": "x"}}
    assert rc.collect_recent_comms(db, "kf1") == []


# ---------- _recap_recent_comms ----------
def test_non_admin_rejected():
    with pytest.raises(HttpsError) as ei:
        _recap_recent_comms(_make_req({"kinfolkId": "kf1"}, _non_admin()), FAKE_DB)
    assert ei.value.code == FunctionsErrorCode.PERMISSION_DENIED


def test_missing_kinfolk_id_rejected():
    with pytest.raises(HttpsError) as ei:
        _recap_recent_comms(_make_req({}, _admin()), FAKE_DB)
    assert ei.value.code == FunctionsErrorCode.INVALID_ARGUMENT


def test_no_comms_returns_empty_recap_without_calling_llm():
    db = FakeDb()  # nothing seeded
    called = {"n": 0}
    def fake_summarize(entries):
        called["n"] += 1
        return "should not run"
    res = _recap_recent_comms(_make_req({"kinfolkId": "kf1"}, _admin()), db, summarize=fake_summarize)
    assert res == {"recap": "", "lastAt": "", "sourceCount": 0}
    assert called["n"] == 0


def test_happy_path_uses_injected_summarizer():
    db = FakeDb()
    db.data["sms_messages"] = {
        "s2": {"kinfolkId": "kf1", "timestamp": "2026-06-10T10:00:00Z", "body": "see you Tuesday"},
        "s1": {"kinfolkId": "kf1", "timestamp": "2026-06-01T10:00:00Z", "body": "older"},
    }
    res = _recap_recent_comms(
        _make_req({"kinfolkId": "kf1"}, _admin()), db,
        summarize=lambda entries: f"recap of {len(entries)}",
    )
    assert res["recap"] == "recap of 2"
    assert res["lastAt"] == "2026-06-10T10:00:00Z"
    assert res["sourceCount"] == 2
```

- [ ] **Step 2: Run the test to verify it fails.**
Run: `./venv/bin/python -m pytest test_recap_recent_comms.py -v`
Expected: FAIL — `ImportError` / `AttributeError: module 'reconcile_comms' has no attribute 'collect_recent_comms'` and `cannot import name '_recap_recent_comms' from 'main'`.

- [ ] **Step 3: Add `collect_recent_comms` + `claude_recap`.** In `reconcile_comms.py`, after `extract_log_body` (after line 185), add:

```python
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
```

- [ ] **Step 4: Add the callable to `main.py`.** In `main.py`, after the `synthesize_kinfolk_profile` callable (after line 94), add:

```python
def _recap_recent_comms(req: https_fn.CallableRequest, db_handle, summarize=None) -> dict:
    from reconcile_comms import collect_recent_comms, claude_recap

    if req.auth is None or not req.auth.token.get("admin"):
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            message="Admin only",
        )
    kinfolk_id = (req.data.get("kinfolkId") or "").strip()
    if not kinfolk_id:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="kinfolkId required",
        )

    entries = collect_recent_comms(db_handle, kinfolk_id)
    if not entries:
        return {"recap": "", "lastAt": "", "sourceCount": 0}

    summarizer = summarize or claude_recap
    recap = (summarizer(entries) or "").strip()
    return {"recap": recap, "lastAt": entries[0]["timestamp"], "sourceCount": len(entries)}


@https_fn.on_call(
    region=_REGION,
    memory=_MEMORY,
    timeout_sec=120,
    secrets=_SECRETS,
)
def recap_recent_comms(req: https_fn.CallableRequest) -> dict:
    from reconcile_comms import init_firebase
    db = init_firebase()
    return _recap_recent_comms(req, db)
```

- [ ] **Step 5: Run the recap tests to verify they pass.**
Run: `./venv/bin/python -m pytest test_recap_recent_comms.py -v`
Expected: PASS (6 passed).

- [ ] **Step 6: Run the full backend suite again.**
Run: `./venv/bin/python -m pytest -v`
Expected: PASS — everything green.

---

## Task 4: Flag — web `communicate.commsRecap` (default OFF)

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/config/FeatureFlags.kt`
- Test: `web/composeApp/src/commonTest/kotlin/com/tribetails/auntieos/web/config/FeatureFlagsTest.kt`

All web gradle commands run from `web/` (`cd web && ./gradlew …`).

- [ ] **Step 1: Read the file first.** Open `FeatureFlags.kt` and confirm the four edit points: the data-class property list (~24–33), the `toMap()` body (~52–62), the companion key constants (~64–74), and the `fromMap()` body (~101–115).

- [ ] **Step 2: Write the failing test.** In `FeatureFlagsTest.kt`, add:

```kotlin
@Test
fun commsRecap_defaults_off_and_round_trips() {
    assertFalse(FeatureFlags().communicateCommsRecap)
    assertTrue(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP in FeatureFlags.KEYS)
    // not ALWAYS_ON — operator can flip it on remotely
    assertFalse(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP in FeatureFlags.ALWAYS_ON)
    val on = FeatureFlags.fromOverrides(mapOf(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP to true))
    assertTrue(on.communicateCommsRecap)
}
```

- [ ] **Step 3: Run the test to verify it fails.**
Run: `cd web && ./gradlew :composeApp:jvmTest --tests "*FeatureFlagsTest*"`
Expected: FAIL — unresolved reference `communicateCommsRecap` / `KEY_COMMUNICATE_COMMS_RECAP`.

- [ ] **Step 4: Add the property.** In the `FeatureFlags` data class, after `val communicateGenerateViaFunction: Boolean = true,` add:

```kotlin
    val communicateCommsRecap: Boolean = false,
```

- [ ] **Step 5: Add to `toMap()`.** In `toMap()`, after `KEY_COMMUNICATE_GENERATE_VIA_FUNCTION to communicateGenerateViaFunction,` add:

```kotlin
        KEY_COMMUNICATE_COMMS_RECAP to communicateCommsRecap,
```

- [ ] **Step 6: Add the key constant.** In the companion object, after `const val KEY_COMMUNICATE_GENERATE_VIA_FUNCTION = "auntieos.communicate.generateViaFunction"` add:

```kotlin
        const val KEY_COMMUNICATE_COMMS_RECAP = "auntieos.communicate.commsRecap"
```

- [ ] **Step 7: Add to `fromMap()`.** In `fromMap()`, mirror the existing per-key line pattern (`x = v(KEY_X, d.x)`), adding:

```kotlin
            communicateCommsRecap = v(KEY_COMMUNICATE_COMMS_RECAP, d.communicateCommsRecap),
```
(Do NOT add it to `ALWAYS_ON`.)

- [ ] **Step 8: Run the test to verify it passes.**
Run: `cd web && ./gradlew :composeApp:jvmTest --tests "*FeatureFlagsTest*"`
Expected: PASS.

- [ ] **Step 9: Verify MyTribe parity (no-op, documented).** Confirm `/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions/src/portal/getFeatureFlags.ts` has no compile-time defaults catalog (it merges Firestore overrides only). No code change. Record in the task notes that parity is satisfied by the web + android registries (this matches the "Deviations" note #1).

---

## Task 5: Flag — android `communicate.commsRecap` (default OFF)

**Files:**
- Modify: `android/app/src/main/java/com/tribetails/auntieos/config/FeatureFlags.kt`
- Test: `android/app/src/test/java/com/tribetails/auntieos/config/FeatureFlagsTest.kt`

All android gradle commands run from `android/` (`cd android && ./gradlew …`).

- [ ] **Step 1: Read the file first.** Confirm the same four edit points as web (data-class props, `toMap()`, companion keys, `fromMap()`). The android registry mirrors web exactly.

- [ ] **Step 2: Write the failing test.** In android `FeatureFlagsTest.kt` (note: android uses `org.junit.Assert.*`), add:

```kotlin
@Test
fun commsRecap_defaults_off_and_round_trips() {
    assertFalse(FeatureFlags().communicateCommsRecap)
    assertTrue(FeatureFlags.KEYS.contains(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP))
    assertFalse(FeatureFlags.ALWAYS_ON.contains(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP))
    val on = FeatureFlags.fromOverrides(mapOf(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP to true))
    assertTrue(on.communicateCommsRecap)
}
```

- [ ] **Step 3: Run the test to verify it fails.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*config.FeatureFlagsTest"`
Expected: FAIL — unresolved reference.

- [ ] **Step 4: Apply the same four edits as Task 4 (Steps 4–7)** — identical property, `toMap()` entry, key constant `"auntieos.communicate.commsRecap"`, and `fromMap()` line. Match the android file's exact `fromMap()` style. Do NOT add to `ALWAYS_ON`.

- [ ] **Step 5: Run the test to verify it passes.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*config.FeatureFlagsTest"`
Expected: PASS.

---

## Task 6: Web pure helpers (TDD) — `CommunicationHelpers.kt`

**Files:**
- Create: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/communicate/CommunicationHelpers.kt`
- Create: `web/composeApp/src/commonTest/kotlin/com/tribetails/auntieos/web/screens/communicate/CommunicationHelpersTest.kt`

Models referenced (`SmsMessage`, `EmailMessage`, `CallLog`, `VoicemailLog`) live in `FirestoreClient.kt`, package `com.tribetails.auntieos.web.data`.

- [ ] **Step 1: Write the failing tests.** Create `CommunicationHelpersTest.kt`:

```kotlin
package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.CallLog
import com.tribetails.auntieos.web.data.EmailMessage
import com.tribetails.auntieos.web.data.SmsMessage
import com.tribetails.auntieos.web.data.VoicemailLog
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CommunicationHelpersTest {

    // ---- summaryLine ----
    @Test fun summaryLine_prefers_tldr() {
        assertEquals("Short.", summaryLine("  Short.  ", "long raw summary", 100))
    }

    @Test fun summaryLine_falls_back_to_truncated_raw() {
        val raw = "x".repeat(50)
        assertEquals("x".repeat(20) + "…", summaryLine("", raw, 20))
    }

    @Test fun summaryLine_short_raw_not_truncated() {
        assertEquals("hello", summaryLine("   ", "hello", 20))
    }

    @Test fun summaryLine_both_blank_is_empty() {
        assertEquals("", summaryLine("", "   ", 20))
    }

    // ---- latestCommunication ----
    @Test fun latest_picks_newest_across_channels() {
        val sms = listOf(SmsMessage(_id = "s1", timestamp = "2026-06-01T00:00:00Z", body = "old sms"))
        val emails = listOf(EmailMessage(_id = "e1", timestamp = "2026-06-10T00:00:00Z", subject = "newest"))
        val calls = listOf(CallLog(_id = "c1", timestamp = "2026-06-05T00:00:00Z", transcript = "call"))
        val vms = listOf(VoicemailLog(_id = "v1", timestamp = "", transcript = "no ts ignored"))
        val latest = latestCommunication(sms, emails, calls, vms)
        assertEquals("email", latest?.channel)
        assertEquals("2026-06-10T00:00:00Z", latest?.timestamp)
        assertEquals("newest", latest?.snippet)
    }

    @Test fun latest_null_when_all_empty() {
        assertNull(latestCommunication(emptyList(), emptyList(), emptyList(), emptyList()))
    }

    @Test fun latest_ignores_blank_timestamps() {
        val sms = listOf(SmsMessage(_id = "s1", timestamp = "", body = "ignored"))
        assertNull(latestCommunication(sms, emptyList(), emptyList(), emptyList()))
    }

    // ---- commsBoxState ----
    @Test fun box_ai_recap_when_flag_on_and_recap_present() {
        val s = commsBoxState(flagOn = true, recap = "where things left off", latest = null)
        assertTrue(s is CommsBoxState.AiRecap && s.recap == "where things left off")
    }

    @Test fun box_raw_disclosed_when_flag_on_but_recap_blank() {
        val latest = LatestComm("sms", "2026-06-10T00:00:00Z", "hi")
        val s = commsBoxState(flagOn = true, recap = "   ", latest = latest)
        assertTrue(s is CommsBoxState.RawLatest && s.disclosedFallback)
    }

    @Test fun box_raw_not_disclosed_when_flag_off() {
        val latest = LatestComm("sms", "2026-06-10T00:00:00Z", "hi")
        val s = commsBoxState(flagOn = false, recap = null, latest = latest)
        assertTrue(s is CommsBoxState.RawLatest && !s.disclosedFallback)
    }

    @Test fun box_empty_when_nothing() {
        assertTrue(commsBoxState(flagOn = true, recap = null, latest = null) is CommsBoxState.Empty)
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail.**
Run: `cd web && ./gradlew :composeApp:jvmTest --tests "*CommunicationHelpersTest*"`
Expected: FAIL — unresolved references (`summaryLine`, `LatestComm`, etc.).

- [ ] **Step 3: Implement the helpers.** Create `CommunicationHelpers.kt`:

```kotlin
package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.CallLog
import com.tribetails.auntieos.web.data.EmailMessage
import com.tribetails.auntieos.web.data.SmsMessage
import com.tribetails.auntieos.web.data.VoicemailLog

/**
 * Pure helpers for the Communicate recipient-context panel. No Compose, no IO —
 * unit-tested in commonTest. Duplicated verbatim on android (separate codebase).
 */

/** tldr if non-blank; else rawSummary truncated to [max] with an ellipsis; else "". */
fun summaryLine(tldr: String, rawSummary: String, max: Int): String {
    val t = tldr.trim()
    if (t.isNotEmpty()) return t
    val r = rawSummary.trim()
    if (r.isEmpty()) return ""
    if (max <= 0 || r.length <= max) return r
    return r.take(max).trimEnd() + "…"
}

data class LatestComm(
    val channel: String,   // "sms" | "email" | "call" | "voicemail"
    val timestamp: String, // ISO-8601 UTC string
    val snippet: String,
)

private fun commSnippet(text: String, max: Int = 140): String {
    val t = text.trim()
    return if (t.length <= max) t else t.take(max).trimEnd() + "…"
}

/**
 * The single most recent record across the four comms lists, by ISO timestamp
 * (lexicographic compare — same UTC format sorts correctly). Entries with a
 * blank timestamp are ignored. null if nothing qualifies.
 */
fun latestCommunication(
    sms: List<SmsMessage>,
    emails: List<EmailMessage>,
    calls: List<CallLog>,
    voicemails: List<VoicemailLog>,
): LatestComm? {
    val candidates = buildList {
        sms.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("sms", it.timestamp, commSnippet(it.body))) }
        emails.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("email", it.timestamp, commSnippet(it.subject.ifBlank { it.body }))) }
        calls.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("call", it.timestamp, commSnippet(it.transcript.ifBlank { it.status }))) }
        voicemails.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("voicemail", it.timestamp, commSnippet(it.transcript))) }
    }
    return candidates.maxByOrNull { it.timestamp }
}

sealed class CommsBoxState {
    data class AiRecap(val recap: String) : CommsBoxState()
    data class RawLatest(val latest: LatestComm, val disclosedFallback: Boolean) : CommsBoxState()
    object Empty : CommsBoxState()
}

/**
 * Which comms-box variant to render. Encodes the disclosed-fallback rule:
 * - flag on + non-blank recap -> AiRecap
 * - else if a latest record exists -> RawLatest (disclosedFallback = flagOn: a
 *   note is shown only when the flag is on but we fell back to raw)
 * - else -> Empty
 */
fun commsBoxState(flagOn: Boolean, recap: String?, latest: LatestComm?): CommsBoxState {
    val r = recap?.trim().orEmpty()
    if (flagOn && r.isNotEmpty()) return CommsBoxState.AiRecap(r)
    if (latest != null) return CommsBoxState.RawLatest(latest, disclosedFallback = flagOn)
    return CommsBoxState.Empty
}
```

- [ ] **Step 4: Run the tests to verify they pass.**
Run: `cd web && ./gradlew :composeApp:jvmTest --tests "*CommunicationHelpersTest*"`
Expected: PASS (11 passed).

- [ ] **Step 5: Wasm compile gate.**
Run: `cd web && ./gradlew :composeApp:compileKotlinWasmJs`
Expected: PASS (no platform-specific code in the helpers).

---

## Task 7: Android pure helpers (TDD) — `CommunicationHelpers.kt`

**Files:**
- Create: `android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicationHelpers.kt`
- Create: `android/app/src/test/java/com/tribetails/auntieos/ui/communicate/CommunicationHelpersTest.kt`

- [ ] **Step 1: Confirm android comms model field names.** Read `android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt` for `SmsMessage`, `EmailMessage`, `CallLog`, `VoicemailLog`. Expected fields mirroring web: `timestamp`, `body` (sms), `subject`/`body` (email), `transcript`/`status` (call), `transcript` (voicemail). If a field name differs, adjust the helper + test accordingly (the logic is identical to web; only the model field accessors may rename).

- [ ] **Step 2: Write the failing tests.** Create `CommunicationHelpersTest.kt` (android uses `org.junit`):

```kotlin
package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.data.model.CallLog
import com.tribetails.auntieos.data.model.EmailMessage
import com.tribetails.auntieos.data.model.SmsMessage
import com.tribetails.auntieos.data.model.VoicemailLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommunicationHelpersTest {

    @Test fun summaryLine_prefers_tldr() {
        assertEquals("Short.", summaryLine("  Short.  ", "long raw summary", 100))
    }

    @Test fun summaryLine_falls_back_to_truncated_raw() {
        val raw = "x".repeat(50)
        assertEquals("x".repeat(20) + "…", summaryLine("", raw, 20))
    }

    @Test fun summaryLine_short_raw_not_truncated() {
        assertEquals("hello", summaryLine("   ", "hello", 20))
    }

    @Test fun summaryLine_both_blank_is_empty() {
        assertEquals("", summaryLine("", "   ", 20))
    }

    @Test fun latest_picks_newest_across_channels() {
        val sms = listOf(SmsMessage(id = "s1", timestamp = "2026-06-01T00:00:00Z", body = "old sms"))
        val emails = listOf(EmailMessage(id = "e1", timestamp = "2026-06-10T00:00:00Z", subject = "newest"))
        val calls = listOf(CallLog(id = "c1", timestamp = "2026-06-05T00:00:00Z", transcript = "call"))
        val vms = listOf(VoicemailLog(id = "v1", timestamp = "", transcript = "ignored"))
        val latest = latestCommunication(sms, emails, calls, vms)
        assertEquals("email", latest?.channel)
        assertEquals("2026-06-10T00:00:00Z", latest?.timestamp)
        assertEquals("newest", latest?.snippet)
    }

    @Test fun latest_null_when_all_empty() {
        assertNull(latestCommunication(emptyList(), emptyList(), emptyList(), emptyList()))
    }

    @Test fun box_ai_recap_when_flag_on_and_recap_present() {
        val s = commsBoxState(flagOn = true, recap = "left off", latest = null)
        assertTrue(s is CommsBoxState.AiRecap && (s as CommsBoxState.AiRecap).recap == "left off")
    }

    @Test fun box_raw_disclosed_when_flag_on_but_recap_blank() {
        val latest = LatestComm("sms", "2026-06-10T00:00:00Z", "hi")
        val s = commsBoxState(flagOn = true, recap = "   ", latest = latest)
        assertTrue(s is CommsBoxState.RawLatest && (s as CommsBoxState.RawLatest).disclosedFallback)
    }

    @Test fun box_raw_not_disclosed_when_flag_off() {
        val latest = LatestComm("sms", "2026-06-10T00:00:00Z", "hi")
        val s = commsBoxState(flagOn = false, recap = null, latest = latest)
        assertTrue(s is CommsBoxState.RawLatest && !(s as CommsBoxState.RawLatest).disclosedFallback)
    }

    @Test fun box_empty_when_nothing() {
        assertTrue(commsBoxState(flagOn = true, recap = null, latest = null) is CommsBoxState.Empty)
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*communicate.CommunicationHelpersTest"`
Expected: FAIL — unresolved references.

- [ ] **Step 4: Implement the helpers.** Create `CommunicationHelpers.kt` — the SAME body as web Task 6 Step 3, with android package + imports (and android model field accessors confirmed in Step 1):

```kotlin
package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.data.model.CallLog
import com.tribetails.auntieos.data.model.EmailMessage
import com.tribetails.auntieos.data.model.SmsMessage
import com.tribetails.auntieos.data.model.VoicemailLog

fun summaryLine(tldr: String, rawSummary: String, max: Int): String {
    val t = tldr.trim()
    if (t.isNotEmpty()) return t
    val r = rawSummary.trim()
    if (r.isEmpty()) return ""
    if (max <= 0 || r.length <= max) return r
    return r.take(max).trimEnd() + "…"
}

data class LatestComm(
    val channel: String,
    val timestamp: String,
    val snippet: String,
)

private fun commSnippet(text: String, max: Int = 140): String {
    val t = text.trim()
    return if (t.length <= max) t else t.take(max).trimEnd() + "…"
}

fun latestCommunication(
    sms: List<SmsMessage>,
    emails: List<EmailMessage>,
    calls: List<CallLog>,
    voicemails: List<VoicemailLog>,
): LatestComm? {
    val candidates = buildList {
        sms.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("sms", it.timestamp, commSnippet(it.body))) }
        emails.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("email", it.timestamp, commSnippet(it.subject.ifBlank { it.body }))) }
        calls.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("call", it.timestamp, commSnippet(it.transcript.ifBlank { it.status }))) }
        voicemails.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("voicemail", it.timestamp, commSnippet(it.transcript))) }
    }
    return candidates.maxByOrNull { it.timestamp }
}

sealed class CommsBoxState {
    data class AiRecap(val recap: String) : CommsBoxState()
    data class RawLatest(val latest: LatestComm, val disclosedFallback: Boolean) : CommsBoxState()
    object Empty : CommsBoxState()
}

fun commsBoxState(flagOn: Boolean, recap: String?, latest: LatestComm?): CommsBoxState {
    val r = recap?.trim().orEmpty()
    if (flagOn && r.isNotEmpty()) return CommsBoxState.AiRecap(r)
    if (latest != null) return CommsBoxState.RawLatest(latest, disclosedFallback = flagOn)
    return CommsBoxState.Empty
}
```

- [ ] **Step 5: Run the tests to verify they pass.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*communicate.CommunicationHelpersTest"`
Expected: PASS (10 passed).

---

## Task 8: Models — add `tldr` to `Dossier` + `Kin411` (web + android)

No tests (data-class field with default; covered by build gates). These fields are read by the UI tasks.

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt` (`Dossier` ~1983–1995, `Kin411` ~2058–2076)
- Modify: `android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt` (`Dossier` ~103–119, `Kin411` ~155–178)

- [ ] **Step 1: Web `Dossier`.** Add a `tldr` field. After `val rawSummary: String = "",` in `Dossier`, add:
```kotlin
    val tldr: String = "",
```

- [ ] **Step 2: Web `Kin411`.** After `val rawSummary: String = "",` in `Kin411`, add:
```kotlin
    val tldr: String = "",
```

- [ ] **Step 3: Android `Dossier`.** After `var rawSummary: String = "",` in `Dossier`, add:
```kotlin
    var tldr: String = "",
```

- [ ] **Step 4: Android `Kin411`.** After `var rawSummary: String = "",` in `Kin411`, add:
```kotlin
    var tldr: String = "",
```

- [ ] **Step 5: Compile gate (web).**
Run: `cd web && ./gradlew :composeApp:compileKotlinWasmJs`
Expected: PASS.

> Note: web models are `@Serializable` with `kotlinx.serialization`. A blank default makes the new field tolerant of docs that lack `tldr` (zero-regression). Android uses Firestore POJO mapping; a default also makes it tolerant. No serializer config change needed.

---

## Task 9: Web — `recapRecentComms` client method + `CommsRecap`

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt`

- [ ] **Step 1: Read the template.** Open `FirestoreClient.kt` and read `synthesizeProfile` (~293–304) and `listRecentSends` (~254–273) — `recapRecentComms` mirrors `synthesizeProfile`'s invoke + `listRecentSends`'s `data`-JSON parse. The bridge delivers a callable's `res.data` as a stringified JSON in `WriteResult.Ok(value)` (confirmed in `firebase-bridge.js:158`).

- [ ] **Step 2: Add `CommsRecap` + `recapRecentComms`.** Near the other callable methods (e.g. right after `synthesizeProfile`), add:

```kotlin
data class CommsRecap(
    val recap: String = "",
    val lastAt: String = "",
    val sourceCount: Int = 0,
)

/**
 * Admin-gated AI recap of recent comms ("where things last left off"). Routes
 * through platformInvokeCallable so it works on wasmJs + jvm. Fail-loud: any
 * error returns WriteResult.Err and the caller falls back to raw-latest.
 */
suspend fun recapRecentComms(kinfolkId: String): WriteResult<CommsRecap> {
    val payload = buildJsonObject { put("kinfolkId", JsonPrimitive(kinfolkId)) }
    return when (val r = platformInvokeCallable("recap_recent_comms", callableJson.encodeToString(JsonObject.serializer(), payload))) {
        is WriteResult.Err -> WriteResult.Err(r.message)
        is WriteResult.Ok -> runCatching {
            val obj = callableJson.parseToJsonElement(r.value).jsonObject
            WriteResult.Ok(
                CommsRecap(
                    recap = obj["recap"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    lastAt = obj["lastAt"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    sourceCount = obj["sourceCount"]?.jsonPrimitive?.intOrNull ?: 0,
                )
            )
        }.getOrElse { WriteResult.Err(it.message ?: "recap decode failed") }
    }
}
```
(If `intOrNull`/`contentOrNull`/`jsonObject` imports are missing, add `import kotlinx.serialization.json.intOrNull`, `import kotlinx.serialization.json.contentOrNull`, `import kotlinx.serialization.json.jsonObject`, `import kotlinx.serialization.json.jsonPrimitive`, `import kotlinx.serialization.json.buildJsonObject`, `import kotlinx.serialization.json.put` — most are already present from `synthesizeProfile`/`listRecentSends`.)

- [ ] **Step 3: Compile gates.**
Run: `cd web && ./gradlew :composeApp:jvmTest :composeApp:compileKotlinWasmJs`
Expected: PASS.

---

## Task 10: Web — reshape `CommunicateScreen` recipient context + comms box

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/communicate/CommunicateScreen.kt`

This task is UI; verified by compile + `jvmTest` gates (pure logic already TDD'd in Task 6). Make focused edits at the mapped locations.

- [ ] **Step 1: Read the screen.** Open `CommunicateScreen.kt`. Locate: `ComposePanel` (~458–657) and the `RecipientPicker` call within it; `RecipientContextPanel` (~1071–1102); `RecipientContextBody` (~1117–1166); `DossierPanel` (~1174–1217); `KinCard` (~1226–1299); the local `synthesizeProfile()` fn (~280–298) and `isSynthesizing` state (~182). Confirm `LocalFeatureFlags` is imported (used elsewhere on the screen).

- [ ] **Step 2: Replace dossier full-text render with the short summary + admin marker.** In `DossierPanel` (the expanded content ~1208–1213), replace the `ContextField(...)` block:

```kotlin
ContextField("Communication Style", dossier.communicationStyle)
ContextField("Household Notes", dossier.householdNotes)
ContextField("Relationship with Auntie", dossier.relationshipWithAuntie)
ContextField("Life Context", dossier.importantLifeContext)
ContextField("Preferred Contact", preferredContactSummary(dossier.preferredContactMethod))
ContextField("Summary", dossier.rawSummary)
```
with a single short summary line:
```kotlin
ContextField("Summary", summaryLine(dossier.tldr, dossier.rawSummary, 280))
```
(Removes household notes + full structured field rows + full rawSummary per spec — short summary only.)

- [ ] **Step 3: Replace per-kin 411 full-text render with the short summary.** In `KinCard` (the expanded `kin411?.let { f -> … }` block ~1290–1295), replace:
```kotlin
kin411?.let { f ->
    ContextField("Personality", f.personality)
    ContextField("Quirks", f.quirksAndPreferences)
    ContextField("Medical", f.medicalNotes)
    ContextField("Diet", f.dietaryDetails)
}
```
with:
```kotlin
kin411?.let { f ->
    ContextField("411", summaryLine(f.tldr, f.rawSummary, 200))
}
```

- [ ] **Step 4: Add the "Admin only / internal" marker + drop the Refresh button on the panel.** In `RecipientContextPanel` (~1071–1102), remove the DenPanel trailing "Refresh intelligence" button (the trailing-content lambda at ~1082–1093) and its `onSynthesize`/`isSynthesizing` params. Add a small muted marker line at the top of the panel body, e.g.:
```kotlin
Text(
    "Admin only / internal",
    style = AuntieTheme.typography.labelSmall,
    color = c.textMuted,
)
```
(Use the screen's existing muted color token — match how other muted captions are styled in this file.) Update the call site of `RecipientContextPanel` to stop passing `onSynthesize`/`isSynthesizing`.

- [ ] **Step 5: Remove the now-orphaned synthesize wiring.** Delete the local `synthesizeProfile()` function (~280–298), the `isSynthesizing` state var (~182), and the `SYNTHESIZE_SUCCESS`/`synthesizeBlocker` usages on this screen if they become unused. Leave `firestore.synthesizeProfile(...)` in `FirestoreClient` intact (Phase 3 reuses it on the profile screen). If `synthesizeBlocker`/`SYNTHESIZE_SUCCESS` in `RecipientContext.kt` are now unused, leave them defined (Phase 3 reuses) — do not delete shared helpers.

- [ ] **Step 6: Add the last-communication box under the recipient picker.** In `ComposePanel`, immediately after the `RecipientPicker(...)` call, add a composable that renders the comms box when a recipient is selected. Add a new private composable to this file:

```kotlin
@Composable
private fun LastCommunicationBox(
    kinfolkId: String,
    firestore: FirestoreClient,
) {
    val flags = LocalFeatureFlags.current
    val scope = rememberCoroutineScope()

    // Reuse the existing global comms streams, filtered client-side by kinfolkId.
    val smsState by remember { firestore.smsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val callsState by remember { firestore.callsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val emailsState by remember { firestore.emailsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val vmState by remember { firestore.voicemailsStream() }.collectAsState(initial = FirestoreResult.Loading)

    val sms = (smsState as? FirestoreResult.Data)?.value.orEmpty().filter { it.kinfolkId == kinfolkId }
    val calls = (callsState as? FirestoreResult.Data)?.value.orEmpty().filter { it.kinfolkId == kinfolkId }
    val emails = (emailsState as? FirestoreResult.Data)?.value.orEmpty().filter { it.kinfolkId == kinfolkId }
    val vms = (vmState as? FirestoreResult.Data)?.value.orEmpty().filter { it.kinfolkId == kinfolkId }
    val latest = latestCommunication(sms, emails, calls, vms)

    var recap by remember(kinfolkId) { mutableStateOf<String?>(null) }
    var recapError by remember(kinfolkId) { mutableStateOf<String?>(null) }

    LaunchedEffect(kinfolkId, flags.communicateCommsRecap) {
        recap = null; recapError = null
        if (flags.communicateCommsRecap) {
            when (val r = firestore.recapRecentComms(kinfolkId)) {
                is WriteResult.Ok -> recap = r.value.recap
                is WriteResult.Err -> recapError = r.message  // fail-loud; box falls back to raw-latest
            }
        }
    }

    // Surface any comms-stream load errors (fail-loud, no silent blank).
    listOf(smsState, callsState, emailsState, vmState).forEach { st ->
        (st as? FirestoreResult.Error)?.let { err ->
            AuntieBanner(tone = AuntieBannerTone.Warning, icon = Lucide.TriangleAlert) {
                Text("Couldn't load recent messages: ${err.message}", style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            }
        }
    }
    recapError?.let { msg ->
        AuntieBanner(tone = AuntieBannerTone.Warning, icon = Lucide.TriangleAlert) {
            Text("AI recap unavailable ($msg) — showing the latest message instead.", style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
        }
    }

    when (val state = commsBoxState(flags.communicateCommsRecap, recap, latest)) {
        is CommsBoxState.AiRecap -> {
            FieldLabel("Where things last left off")
            Text(state.recap, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        }
        is CommsBoxState.RawLatest -> {
            FieldLabel("Latest message")
            Text(
                "${state.latest.channel} · ${relativeOrRaw(state.latest.timestamp)} — ${state.latest.snippet}",
                style = AuntieTheme.typography.bodyMedium, color = c.textPrimary,
            )
            if (state.disclosedFallback) {
                Text("Showing the raw latest message (AI recap unavailable).", style = AuntieTheme.typography.labelSmall, color = c.textMuted)
            }
        }
        CommsBoxState.Empty -> {
            Text("No messages on file yet.", style = AuntieTheme.typography.bodySmall, color = c.textMuted)
        }
    }
}
```
Then call it in `ComposePanel` after the picker:
```kotlin
selectedKinfolk?._id?.takeIf { it.isNotBlank() }?.let { id ->
    LastCommunicationBox(kinfolkId = id, firestore = firestore)
}
```
Notes:
- `c` is the screen's theme colors handle (already in scope in this file's composables — match how `DossierPanel`/`KinCard` reference `c`). If `c` is not in scope inside the new composable, resolve colors the same way the sibling composables do (e.g. `val c = AuntieTheme.colors` or the existing `LocalAuntieColors.current`).
- `relativeOrRaw(timestamp)` — if a relative-time formatter already exists on this screen / in the UI utils, use it; otherwise render the raw ISO timestamp string (do NOT invent a fake humanizer). Grep the file/module for an existing relative-time helper first; fall back to the raw string.
- `FieldLabel` is the existing label composable used in `RecipientContextBody`.

- [ ] **Step 7: Compile + test gates.**
Run: `cd web && ./gradlew :composeApp:jvmTest :composeApp:compileKotlinWasmJs`
Expected: PASS. Fix any unresolved references by matching the screen's existing imports/handles (colors, banner, labels).

---

## Task 11: Android — comms reads + `recapRecentComms` in `AuntieRepository`

**Files:**
- Modify: `android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`

- [ ] **Step 1: Read templates.** Read `getDossier` (~427–436), `get411ForKin` (~438–448), `synthesizeProfile` (~547–556), and a callable that decodes a `Map` result like `sendExternalMessage`/`listRecentSends` (~567–618).

- [ ] **Step 2: Add a `RecentComms` holder + per-kinfolk reads.** Add near the other model/result helpers:

```kotlin
data class RecentComms(
    val sms: List<SmsMessage> = emptyList(),
    val emails: List<EmailMessage> = emptyList(),
    val calls: List<CallLog> = emptyList(),
    val voicemails: List<VoicemailLog> = emptyList(),
)

suspend fun recentCommsForKinfolk(kinfolkId: String, perCollectionLimit: Long = 25): Result<RecentComms> = runCatching {
    coroutineScope {
        val smsD = async {
            firestore.collection("sms_messages").whereEqualTo("kinfolkId", kinfolkId)
                .limit(perCollectionLimit).get().await().toObjects(SmsMessage::class.java)
        }
        val emailsD = async {
            firestore.collection("emails").whereEqualTo("kinfolkId", kinfolkId)
                .limit(perCollectionLimit).get().await().toObjects(EmailMessage::class.java)
        }
        val callsD = async {
            firestore.collection("calls_log").whereEqualTo("kinfolkId", kinfolkId)
                .limit(perCollectionLimit).get().await().toObjects(CallLog::class.java)
        }
        val vmD = async {
            firestore.collection("voicemails").whereEqualTo("kinfolkId", kinfolkId)
                .limit(perCollectionLimit).get().await().toObjects(VoicemailLog::class.java)
        }
        RecentComms(smsD.await(), emailsD.await(), callsD.await(), vmD.await())
    }
}.onFailure { AuntieLog.e("recentCommsForKinfolk failed for $kinfolkId", it) }
```
(Match the file's existing collection-read idiom — `toObjects(...)`, `await()`, `coroutineScope`/`async` are already used in `loadProfiles`-adjacent code. If the model class names differ, use the actual ones from `Models.kt`.)

- [ ] **Step 3: Add `recapRecentComms` callable.** Mirror `synthesizeProfile` + a Map-decoding callable:

```kotlin
data class CommsRecap(
    val recap: String = "",
    val lastAt: String = "",
    val sourceCount: Int = 0,
)

suspend fun recapRecentComms(kinfolkId: String): Result<CommsRecap> = runCatching {
    ensureAuthenticated()
    val raw = withContext(Dispatchers.IO) {
        functions.getHttpsCallable("recap_recent_comms")
            .call(mapOf("kinfolkId" to kinfolkId))
            .await().data as? Map<*, *>
    }
    CommsRecap(
        recap = (raw?.get("recap") as? String).orEmpty(),
        lastAt = (raw?.get("lastAt") as? String).orEmpty(),
        sourceCount = ((raw?.get("sourceCount") as? Number)?.toInt()) ?: 0,
    )
}.onFailure { AuntieLog.e("recapRecentComms failed for $kinfolkId", it) }
```

- [ ] **Step 4: Compile gate.**
Run: `cd android && ./gradlew :app:assembleDebug`
Expected: PASS (fix any unresolved imports/model names by matching `Models.kt`).

---

## Task 12: Android — ViewModel comms-box state + reshape `CommunicateScreen`

**Files:**
- Modify: `android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicateViewModel.kt`
- Modify: `android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicateScreen.kt`
- Test: `android/app/src/test/java/com/tribetails/auntieos/ui/communicate/CommunicateViewModelTest.kt`

- [ ] **Step 1: Write a failing VM test for comms-box state.** In `CommunicateViewModelTest.kt`, add (mirror the existing setup — `mockRepo = mockk()`, `coEvery` stubs, `runTest`):

```kotlin
@Test
fun `selecting kinfolk with flag off loads raw-latest comms box`() = runTest(testDispatcher) {
    coEvery { mockRepo.getDossier(any()) } returns Result.success(null)
    coEvery { mockRepo.getKin(any()) } returns Result.success(emptyList())
    coEvery { mockRepo.recentCommsForKinfolk(any()) } returns Result.success(
        AuntieRepository.RecentComms(
            sms = listOf(SmsMessage(id = "s1", kinfolkId = "kf1", timestamp = "2026-06-10T00:00:00Z", body = "see you Tuesday")),
        )
    )
    val vm = buildViewModel(commsRecapFlag = false)   // flag OFF -> recap callable not invoked
    vm.selectKinfolk(TestFixtures.kinfolk1.copy(id = "kf1"))
    advanceUntilIdle()
    val state = vm.uiState.value.commsBox
    assertTrue(state is CommsBoxState.RawLatest)
    coVerify(exactly = 0) { mockRepo.recapRecentComms(any()) }
}
```
(If `buildViewModel` does not yet accept a flag, add an overload/param that injects the flag value the VM reads — see Step 3. Adjust `TestFixtures` usage to whatever the fixture API is.)

- [ ] **Step 2: Run to verify it fails.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*CommunicateViewModelTest"`
Expected: FAIL — `commsBox` not on state / `recentCommsForKinfolk` not stubbable / `buildViewModel` signature.

- [ ] **Step 3: Add comms-box state + loader to the ViewModel.**
  - Add to `CommunicateUiState` (after the profile-panel fields):
    ```kotlin
    val commsBox: CommsBoxState = CommsBoxState.Empty,
    val commsBoxLoading: Boolean = false,
    val commsRecapError: String? = null,
    ```
  - The VM needs to know the flag value. The screen reads `LocalFeatureFlags.current`; pass `communicateCommsRecap` into the VM either via constructor or via the load call. Simplest: add a parameter to the loader. In `selectKinfolk`/`loadProfiles`, after profiles load, call a new `loadCommsBox`:
    ```kotlin
    fun loadCommsBox(kinfolkId: String, recapFlagOn: Boolean) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(commsBoxLoading = true, commsRecapError = null)
            val comms = repo.recentCommsForKinfolk(kinfolkId).getOrElse {
                _uiState.value = _uiState.value.copy(
                    commsBoxLoading = false,
                    commsBox = CommsBoxState.Empty,
                    commsRecapError = "Couldn't load recent messages: ${it.message}",
                )
                return@launch
            }
            val latest = latestCommunication(comms.sms, comms.emails, comms.calls, comms.voicemails)
            var recap: String? = null
            var recapErr: String? = null
            if (recapFlagOn) {
                repo.recapRecentComms(kinfolkId)
                    .onSuccess { recap = it.recap }
                    .onFailure { recapErr = it.message }
            }
            _uiState.value = _uiState.value.copy(
                commsBoxLoading = false,
                commsBox = commsBoxState(recapFlagOn, recap, latest),
                commsRecapError = recapErr,
            )
        }
    }
    ```
  - Trigger it: the screen calls `viewModel.loadCommsBox(kinfolk.id, flags.communicateCommsRecap)` when a recipient is selected (a `LaunchedEffect(selectedKinfolk, flags.communicateCommsRecap)` in the screen — see Step 5), OR thread the flag into `selectKinfolk`. Pick the screen-driven `LaunchedEffect` approach to keep the VM free of Compose flag plumbing.
  - For the test's `buildViewModel(commsRecapFlag = …)`: have the test call `vm.loadCommsBox("kf1", recapFlagOn = false)` directly after `selectKinfolk` (no constructor change needed) — simplest and matches the screen's call. Adjust the test in Step 1 to call `vm.loadCommsBox("kf1", recapFlagOn = false)` then `advanceUntilIdle()` if `buildViewModel` has no flag param.

- [ ] **Step 4: Run the VM test to verify it passes.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*CommunicateViewModelTest"`
Expected: PASS.

- [ ] **Step 5: Reshape the android `ContextPanel` + add the comms box + drop Refresh.** In `CommunicateScreen.kt`:
  - In `DossierPanel` (~902–939), replace the field rows (incl. `householdNotes` ~931 and `rawSummary` ~935) with a single short summary:
    ```kotlin
    ContextField("Summary", summaryLine(dossier.tldr, dossier.rawSummary, 280))
    ```
    (Remove the Communication Style / Household Notes / Relationship / Life Context / Preferred Contact / Summary rows — short summary only.)
  - In `KinCard` (~942–997), replace the 411 field rows (personality ~989, quirks ~990, medical ~991, diet ~992) with:
    ```kotlin
    kin411?.let { f ->
        ContextField("411", summaryLine(f.tldr, f.rawSummary, 200))
    }
    ```
  - In `ContextPanel` (~860–899): remove the "Refresh intelligence" button (~868–879) and add the "Admin only / internal" marker near the panel title:
    ```kotlin
    Text("Admin only / internal", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    ```
    (Match the file's actual theme/typography handles.) Leave `viewModel.synthesizeProfile()` + `isSynthesizing` in the VM intact — Phase 3 reuses them on the profile screen.
  - Add the comms box. Where the recipient is shown (top of the compose area / above `ContextPanel`), add:
    ```kotlin
    val flags = LocalFeatureFlags.current
    LaunchedEffect(state.selectedKinfolk?.id, flags.communicateCommsRecap) {
        state.selectedKinfolk?.id?.takeIf { it.isNotBlank() }?.let { viewModel.loadCommsBox(it, flags.communicateCommsRecap) }
    }
    state.commsRecapError?.let { msg ->
        // fail-loud banner (match existing banner pattern on this screen)
        Text("AI recap unavailable ($msg) — showing the latest message instead.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
    when (val cb = state.commsBox) {
        is CommsBoxState.AiRecap -> {
            Text("Where things last left off", style = MaterialTheme.typography.labelMedium)
            Text(cb.recap, style = MaterialTheme.typography.bodyMedium)
        }
        is CommsBoxState.RawLatest -> {
            Text("Latest message", style = MaterialTheme.typography.labelMedium)
            Text("${cb.latest.channel} · ${cb.latest.timestamp} — ${cb.latest.snippet}", style = MaterialTheme.typography.bodyMedium)
            if (cb.disclosedFallback) Text("Showing the raw latest message (AI recap unavailable).", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        CommsBoxState.Empty -> Text("No messages on file yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    ```
    (Use the file's actual Compose imports/handles. If a relative-time formatter exists, use it for `cb.latest.timestamp`; else show the raw string — do not fake one.)

- [ ] **Step 6: Build gates.**
Run: `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`
Expected: PASS.

---

## Task 13: Full verification (all platforms)

No code changes — run every gate and record output. (REQUIRED SUB-SKILL: superpowers:verification-before-completion — evidence before claims.)

- [ ] **Step 1: Backend.**
Run: `cd web/functions-python && ./venv/bin/python -m pytest -v`
Expected: all PASS (existing + new `test_reconcile_prompts.py` tldr tests + `test_recap_recent_comms.py`).

- [ ] **Step 2: Web.**
Run: `cd web && ./gradlew :composeApp:jvmTest :composeApp:compileKotlinWasmJs`
Expected: all PASS.

- [ ] **Step 3: Android.**
Run: `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`
Expected: all PASS; debug APK assembles.

- [ ] **Step 4: Anti-slop pass on user-facing strings.** Run the `anti-ai-slop` skill over the new UI copy ("Where things last left off", "No messages on file yet.", "Admin only / internal", disclosed-fallback note, banner text). Revise anything that matches a slop pattern.

- [ ] **Step 5: Record results** in the session handoff (`.remember/remember.md`, written directly per the broken `/remember` note). Note what is NOT done (Phases 2 + 3) and that nothing is deployed (operator-gated).

---

## Self-Review (done while writing — recorded for the executor)

**Spec coverage:**
- tldr synthesis (dossier + 411, no extra LLM call, regenerated each run, not frozen) → Tasks 1, 2, 8. ✓
- `recap_recent_comms` callable → Task 3. ✓
- `communicate.commsRecap` flag default OFF on all registries → Tasks 4 (web), 5 (android), 4-Step-9 (MyTribe = verified no-op). ✓
- Pure helpers `summaryLine`/`latestCommunication`/`commsBoxState` (TDD, commonTest + android unit) → Tasks 6, 7. ✓ (`missingHouseholdFields` correctly deferred to Phase 2.)
- Last-communication box (AI recap | raw-latest disclosed | empty) under the picker → Tasks 10 (web), 12 (android). ✓
- Recipient context reshaped: short summaries, no household notes, no full text, no image strips (already none), no Refresh button, Admin-only marker → Tasks 10, 12. ✓
- Per-source fail-loud errors, disclosed fallback, no silent blanks → Tasks 10, 12 (banners + disclosed note + "No messages on file yet."). ✓
- Build gates (web jvmTest + compileKotlinWasmJs; android testDebugUnitTest + assembleDebug; pytest) → Task 13. ✓

**Type consistency:** `CommsRecap`(recap,lastAt,sourceCount), `LatestComm`(channel,timestamp,snippet), `CommsBoxState`{AiRecap,RawLatest(disclosedFallback),Empty}, helper names `summaryLine`/`latestCommunication`/`commsBoxState` — used identically across web + android + tests. Backend 3-tuple `(summary, fields, tldr)` threaded consistently through both merge fns + both upserts + reconcile_pass + the idempotency spy. ✓

**Placeholder scan:** UI tasks reference real mapped file:line edit points with old→new snippets; the two genuinely environment-dependent spots (theme color handle `c`, relative-time formatter) are flagged with an explicit "match the file's existing handle / do not fake" instruction rather than inventing an API. ✓
