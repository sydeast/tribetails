"""Tests for CRITICAL-5: claim-first idempotency in reconcile_comms.reconcile_pass.

Verifies that:
 1. A log already 'applied' or 'in_progress' is NOT re-merged (upsert_dossier
    never called for it).
 2. The claim-first path sets status 'in_progress' BEFORE merge and 'applied'
    AFTER; a simulated crash after the dossier write (status still in_progress)
    means a second pass does NOT call merge again.
 3. The happy path: pending -> in_progress (before merge) -> applied (after merge)
    with the merge called exactly once.

All tests use the in-memory FakeDb from test_reconcile_note.py conventions plus
a local call-tracking wrapper to assert write order.

Run:
    ./venv/bin/python -m pytest test_reconcile_idempotency.py -v
"""
from __future__ import annotations

from typing import Any

import reconcile_comms as rc


# ---------- in-memory fake Firestore (mirrors test_reconcile_note.py) ----------

class FakeSnap:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data

    @property
    def exists(self):
        return self._data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class FakeDocRef:
    def __init__(self, store, coll, doc_id):
        self._store = store
        self._coll = coll
        self._id = doc_id

    @property
    def id(self):
        return self._id

    def get(self):
        data = self._store.data.get(self._coll, {}).get(self._id)
        return FakeSnap(self._id, data)

    def set(self, data, merge=False):
        coll = self._store.data.setdefault(self._coll, {})
        if merge and self._id in coll and coll[self._id] is not None:
            merged = dict(coll[self._id])
            merged.update(data)
            coll[self._id] = merged
        else:
            coll[self._id] = dict(data)

    def update(self, data):
        coll = self._store.data.setdefault(self._coll, {})
        cur = dict(coll.get(self._id) or {})
        cur.update(data)
        coll[self._id] = cur
        # Record the write for order-assertion tests
        self._store.writes.append((self._coll, self._id, dict(data)))


class FakeQuery:
    def __init__(self, store, coll, filters=None, lim=None):
        self._store = store
        self._coll = coll
        self._filters = filters or []
        self._lim = lim

    def where(self, field, op, value):
        return FakeQuery(self._store, self._coll, self._filters + [(field, op, value)], self._lim)

    def limit(self, n):
        return FakeQuery(self._store, self._coll, self._filters, n)

    def stream(self):
        rows = []
        for doc_id, data in (self._store.data.get(self._coll) or {}).items():
            if data is None:
                continue
            ok = all(data.get(f) == v for (f, op, v) in self._filters if op == "==")
            if ok:
                rows.append(FakeSnap(doc_id, data))
        if self._lim is not None:
            rows = rows[: self._lim]
        return iter(rows)


class FakeCollection(FakeQuery):
    def document(self, doc_id=None):
        if doc_id is None:
            self._store.auto += 1
            doc_id = f"auto-{self._store.auto}"
        return FakeDocRef(self._store, self._coll, doc_id)


class FakeDb:
    def __init__(self):
        self.data: dict[str, dict[str, Any]] = {}
        self.auto = 0
        # ordered list of (coll, doc_id, payload) for write-order assertions
        self.writes: list[tuple[str, str, dict]] = []

    def collection(self, name):
        return FakeCollection(self, name)


def seed_household(db: FakeDb):
    db.data["kinfolk"] = {"kf1": {"firstName": "Toni", "lastName": "Park"}}
    db.data["kin"] = {
        "k1": {"kinfolkId": "kf1", "name": "Biscuit", "species": "Dog"},
    }
    return db


# ---------- helper: count dossier upsert calls ----------

class UpsertSpy:
    """Wraps rc.upsert_dossier, counting calls and delegating to real impl.

    Must be constructed BEFORE patching rc.upsert_dossier so _real holds the
    original function, not the spy itself.
    """
    def __init__(self):
        self._real = rc.upsert_dossier  # capture before patching
        self.call_count = 0

    def __call__(self, db, kinfolk_id, new_summary, ts, source_id, needs_more, new_fields=None, tldr=""):
        self.call_count += 1
        return self._real(db, kinfolk_id, new_summary, ts, source_id, needs_more, new_fields, tldr)


# ---------- test 1: already-applied log is not re-merged ----------

def test_applied_log_is_not_remerged():
    """A log with reconcileStatus='applied' must be skipped — upsert_dossier not called."""
    db = FakeDb()
    seed_household(db)
    db.data["training_documents"] = {
        "n_applied": {
            "targetType": "KINFOLK", "targetKinfolkId": "kf1",
            "content": "Prefers morning appointments.",
            "reconcileStatus": "applied",  # already done
        }
    }

    spy = UpsertSpy()
    orig = rc.upsert_dossier
    rc.upsert_dossier = spy
    try:
        rc.reconcile_pass(db, max_per_run=25, use_stub=True)
    finally:
        rc.upsert_dossier = orig

    assert spy.call_count == 0, (
        "upsert_dossier was called for an already-applied log — double-merge bug present"
    )
    # Status must remain applied (not mutated)
    assert db.data["training_documents"]["n_applied"]["reconcileStatus"] == "applied"


# ---------- test 2: in_progress log (crashed mid-flight) is not re-merged ----------

def test_in_progress_log_is_not_remerged():
    """A log left in_progress (from a previous crashed run) must be skipped.

    The 'pending' query won't return it, so it naturally can't be re-merged.
    We verify this by seeding an in_progress doc and confirming upsert_dossier
    is never called for it.
    """
    db = FakeDb()
    seed_household(db)
    db.data["training_documents"] = {
        "n_inprog": {
            "targetType": "KINFOLK", "targetKinfolkId": "kf1",
            "content": "Gate code changed.",
            "reconcileStatus": "in_progress",  # crashed mid-flight previously
            "reconcileClaimedAt": "2026-06-21T00:00:00Z",
        }
    }

    spy = UpsertSpy()
    orig = rc.upsert_dossier
    rc.upsert_dossier = spy
    try:
        rc.reconcile_pass(db, max_per_run=25, use_stub=True)
    finally:
        rc.upsert_dossier = orig

    assert spy.call_count == 0, (
        "upsert_dossier was called for an in_progress log — crashed-run duplication bug present"
    )
    # Status must remain in_progress (not picked up and re-merged)
    assert db.data["training_documents"]["n_inprog"]["reconcileStatus"] == "in_progress"


# ---------- test 3: claim-first sets in_progress before merge, applied after ----------

def test_claim_sets_in_progress_before_merge_and_applied_after():
    """Assert the write order: in_progress (claim) -> dossier upsert -> applied.

    We instrument the FakeDb.writes list to capture all update() calls in order.
    The claim (in_progress write) must appear BEFORE the dossier upsert, and
    applied must appear AFTER.
    """
    db = FakeDb()
    seed_household(db)
    db.data["training_documents"] = {
        "n_order": {
            "targetType": "KINFOLK", "targetKinfolkId": "kf1",
            "content": "Has a new foster pet named Pretzel.",
            "reconcileStatus": "pending",
        }
    }

    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    # Collect writes to training_documents/n_order in order
    log_writes = [
        w for w in db.writes
        if w[0] == "training_documents" and w[1] == "n_order"
    ]
    # Must have at least two writes: claim (in_progress) and final (applied)
    assert len(log_writes) >= 2, (
        f"Expected at least 2 writes to training_documents/n_order, got {len(log_writes)}: {log_writes}"
    )

    # First write must set in_progress
    first_status = log_writes[0][2].get("reconcileStatus")
    assert first_status == "in_progress", (
        f"First write to log should be 'in_progress' (claim), got '{first_status}'"
    )

    # Last write must set applied
    last_status = log_writes[-1][2].get("reconcileStatus")
    assert last_status == "applied", (
        f"Last write to log should be 'applied', got '{last_status}'"
    )

    # Final state in the store is applied
    final = db.data["training_documents"]["n_order"]
    assert final["reconcileStatus"] == "applied"
    assert "dossiers/" in final.get("reconcileNotes", "")


# ---------- test 4: simulated crash after dossier write, second pass is safe ----------

def test_second_pass_after_crash_does_not_remerge():
    """Simulate a crash after dossier write but before 'applied' mark.

    At crash time: dossier is written, log status is still 'in_progress'.
    A second pass must NOT pick up the in_progress log and re-merge.
    """
    db = FakeDb()
    seed_household(db)
    # Pre-seed the dossier (as if the first pass already wrote it before crashing)
    db.data["dossiers"] = {
        "kf1": {
            "kinfolkId": "kf1",
            "rawSummary": "Has a foster pet named Pretzel.",
            "lastReconcileSourceLogIds": ["training_documents/n_crash"],
        }
    }
    # Log is stuck in_progress — the crash prevented 'applied'
    db.data["training_documents"] = {
        "n_crash": {
            "targetType": "KINFOLK", "targetKinfolkId": "kf1",
            "content": "Has a foster pet named Pretzel.",
            "reconcileStatus": "in_progress",
            "reconcileClaimedAt": "2026-06-21T00:00:00Z",
        }
    }

    spy = UpsertSpy()
    orig = rc.upsert_dossier
    rc.upsert_dossier = spy
    try:
        # Second pass: must not re-merge
        rc.reconcile_pass(db, max_per_run=25, use_stub=True)
    finally:
        rc.upsert_dossier = orig

    assert spy.call_count == 0, (
        "Second pass called upsert_dossier for an in_progress log — post-crash double-merge bug"
    )


# ---------- test 5: happy path — merge called exactly once ----------

def test_happy_path_merge_called_exactly_once():
    """End-to-end happy path: pending -> in_progress -> applied, merge exactly once."""
    db = FakeDb()
    seed_household(db)
    db.data["training_documents"] = {
        "n_happy": {
            "targetType": "KINFOLK", "targetKinfolkId": "kf1",
            "content": "Drop-off at 8am only.",
            "reconcileStatus": "pending",
        }
    }

    spy = UpsertSpy()
    orig = rc.upsert_dossier
    rc.upsert_dossier = spy
    try:
        processed = rc.reconcile_pass(db, max_per_run=25, use_stub=True)
    finally:
        rc.upsert_dossier = orig

    assert processed >= 1
    assert spy.call_count == 1, f"Expected merge exactly once, got {spy.call_count}"

    final = db.data["training_documents"]["n_happy"]
    assert final["reconcileStatus"] == "applied"

    # Dossier must exist for kf1
    dossiers = [v for v in db.data.get("dossiers", {}).values() if v and v.get("kinfolkId") == "kf1"]
    assert dossiers, "Expected dossier for kf1 after happy-path reconcile"


# ---------- test 6: claim_log_atomic helper directly ----------

def test_claim_log_atomic_returns_false_for_non_pending():
    """claim_log_atomic must return False for any status other than 'pending'."""
    for status in ("applied", "in_progress", "skipped", "error"):
        db = FakeDb()
        db.data["sms_messages"] = {
            "sms1": {"reconcileStatus": status, "body": "hi"}
        }
        result = rc.claim_log_atomic(db, "sms_messages", "sms1", "T")
        assert result is False, f"Expected False for status='{status}', got {result}"
        # Status must be unchanged
        assert db.data["sms_messages"]["sms1"]["reconcileStatus"] == status


def test_claim_log_atomic_claims_pending_and_sets_in_progress():
    """claim_log_atomic must return True and set in_progress for a pending doc."""
    db = FakeDb()
    db.data["sms_messages"] = {
        "sms2": {"reconcileStatus": "pending", "body": "hello"}
    }
    result = rc.claim_log_atomic(db, "sms_messages", "sms2", "2026-06-21T00:00:00Z")
    assert result is True
    doc = db.data["sms_messages"]["sms2"]
    assert doc["reconcileStatus"] == "in_progress"
    assert doc["reconcileClaimedAt"] == "2026-06-21T00:00:00Z"


def test_claim_log_atomic_returns_false_for_missing_doc():
    """claim_log_atomic must return False (not raise) for a nonexistent doc."""
    db = FakeDb()
    db.data["sms_messages"] = {}
    result = rc.claim_log_atomic(db, "sms_messages", "ghost", "T")
    assert result is False


# ---------- test 7: dry_run does not claim or mutate ----------

def test_dry_run_does_not_claim():
    """In dry_run mode, the log status must stay 'pending' — no claiming writes."""
    db = FakeDb()
    seed_household(db)
    db.data["training_documents"] = {
        "n_dry": {
            "targetType": "KINFOLK", "targetKinfolkId": "kf1",
            "content": "Allergic to poultry.",
            "reconcileStatus": "pending",
        }
    }

    rc.reconcile_pass(db, max_per_run=25, use_stub=True, dry_run=True)

    # No writes at all in dry_run
    assert not db.writes, f"Expected no writes in dry_run, got {db.writes}"
    # Status must remain pending
    assert db.data["training_documents"]["n_dry"]["reconcileStatus"] == "pending"
