"""Tests for the five reconcile pipeline findings (W29, W32, W34, N59, N60).

Reuses the in-memory FakeDb from test_reconcile_matching.py.

  W29 — build_kinfolk_contact_index resolves matches without per-log full
        kinfolk streams; matcher behavior is unchanged vs the live-query path.
  W32 — pending kin_care_reports are reached even when many applied docs exist
        (status filter, not first-N-then-filter, so applied docs don't starve
        the budget).
  W34 — the stale root twin carries a deprecation banner (asserted in
        test_reconcile_matching is not the place; checked here against the
        canonical-vs-root files).
  N59 — a kinfolk-filtered run is bounded by max_per_run (filtered-out logs
        count against the budget).
  N60 — a stub-built doc with >=3 sources is not flagged needsMoreSamples.

Run:
    ./venv/bin/python -m pytest test_reconcile_findings.py -q
"""
from __future__ import annotations

from pathlib import Path

import reconcile_comms as rc
from reconcile_prompts import count_sources
from test_reconcile_matching import (
    FakeDb, FakeCollection, FakeQuery, FakeSnap, FakeDocRef,
)


# ---------- a FakeDb that counts how many times the kinfolk collection streams ----------

class CountingQuery(FakeQuery):
    def stream(self):
        if self._coll == "kinfolk" and not self._filters:
            # A full (unfiltered) kinfolk stream — the expensive O(N) scan W29
            # is meant to collapse to ONE per pass.
            self._store.kinfolk_full_streams += 1
        return super().stream()

    def where(self, field, op, value):
        return CountingQuery(self._store, self._coll, self._filters + [(field, op, value)], self._lim)

    def limit(self, n):
        return CountingQuery(self._store, self._coll, self._filters, n)


class CountingCollection(CountingQuery):
    def document(self, doc_id=None):
        if doc_id is None:
            self._store.auto += 1
            doc_id = f"auto-{self._store.auto}"
        return FakeDocRef(self._store, self._coll, doc_id)


class CountingDb(FakeDb):
    def __init__(self):
        super().__init__()
        self.kinfolk_full_streams = 0

    def collection(self, name):
        return CountingCollection(self, name)


def _stub_pass(db, **kw):
    """reconcile_pass in stub mode (no Claude) with defaults filled in."""
    kw.setdefault("use_stub", True)
    return rc.reconcile_pass(db, **kw)


# ---------- W29: in-memory index, one kinfolk stream per pass ----------

def test_index_resolves_phone_without_per_log_stream():
    idx = {
        "by_phone": {"5551234567": {"kfA"}},
        "by_email": {},
        "docs": {"kfA": {"firstName": "Ann", "phoneNumber": "555-123-4567"}},
    }
    res = rc.find_kinfolk_by_contact(None, "sms", {"callerNumber": "5551234567"}, index=idx)
    assert res is not None and res[0] == "kfA"


def test_index_resolves_email_without_per_log_stream():
    idx = {
        "by_phone": {},
        "by_email": {"ann@example.com": {"kfA"}},
        "docs": {"kfA": {"email": "ann@example.com"}},
    }
    log = {"direction": "outbound", "fromAddress": "biz@x.com", "toAddresses": ["ann@example.com"]}
    res = rc.find_kinfolk_by_contact(None, "email", log, index=idx)
    assert res is not None and res[0] == "kfA"


def test_index_duplicate_contact_is_ambiguous():
    idx = {
        "by_phone": {"5551234567": {"kfA", "kfB"}},
        "by_email": {},
        "docs": {"kfA": {}, "kfB": {}},
    }
    assert rc.find_kinfolk_by_contact(None, "sms", {"callerNumber": "5551234567"}, index=idx) is rc.AMBIGUOUS_MATCH


def test_build_index_matches_live_query_behavior():
    """The index path and the live-query path resolve the same kinfolk."""
    db = FakeDb()
    db.data["kinfolk"] = {
        "kfA": {"firstName": "Ann", "phoneNumber": "555-123-4567", "email": "ann@x.com"},
        "kfB": {"firstName": "Bob", "phoneNumber": "555-999-0000"},
    }
    idx = rc.build_kinfolk_contact_index(db)
    log = {"callerNumber": "5551234567"}
    live = rc.find_kinfolk_by_contact(db, "sms", log)          # streams collection
    indexed = rc.find_kinfolk_by_contact(db, "sms", log, index=idx)
    assert live[0] == indexed[0] == "kfA"


def test_pass_streams_kinfolk_collection_once():
    db = CountingDb()
    db.data["kinfolk"] = {
        "kfA": {"firstName": "Ann", "phoneNumber": "555-123-4567"},
        "kfB": {"firstName": "Bob", "phoneNumber": "555-999-0000"},
    }
    db.data["sms_messages"] = {
        f"s{i}": {"callerNumber": "5551234567", "body": "hi", "reconcileStatus": "pending"}
        for i in range(5)
    }
    _stub_pass(db, max_per_run=25)
    # 5 phone logs would have been 5 full kinfolk streams pre-W29; now exactly 1.
    assert db.kinfolk_full_streams == 1, (
        f"expected ONE full kinfolk stream per pass, got {db.kinfolk_full_streams}"
    )
    # All five still got applied (behavior parity).
    assert all(v["reconcileStatus"] == "applied" for v in db.data["sms_messages"].values())


# ---------- W32: pending kin_care_reports not starved by applied docs ----------

def test_pending_kincare_report_reached_despite_many_applied():
    db = FakeDb()
    db.data["kinfolk"] = {"kf1": {"firstName": "Dana", "phoneNumber": "555-000-1111"}}
    db.data["kin"] = {"k1": {"kinfolkId": "kf1", "name": "Rex", "species": "Dog"}}
    # 30 already-applied reports + 1 pending. With a small budget, a
    # limit-before-filter query would fill on applied docs and never reach p1.
    reports = {
        f"applied{i}": {"kinfolkId": "kf1", "kinIds": ["k1"],
                        "content": "done", "reconcileStatus": "applied"}
        for i in range(30)
    }
    reports["p1"] = {"kinfolkId": "kf1", "kinIds": ["k1"],
                     "content": "Rex update", "reconcileStatus": "pending"}
    db.data["kin_care_reports"] = reports

    _stub_pass(db, max_per_run=5)
    assert db.data["kin_care_reports"]["p1"]["reconcileStatus"] == "applied", (
        "pending kin_care_report must be reached even with many applied docs (W32)"
    )
    # Applied docs were never re-touched.
    assert db.data["kin_care_reports"]["applied0"]["reconcileStatus"] == "applied"


# ---------- N59: filtered run is bounded by max_per_run ----------

def test_filtered_run_is_bounded_by_max_per_run():
    db = FakeDb()
    db.data["kinfolk"] = {
        "kfWanted": {"firstName": "W", "phoneNumber": "555-000-0001"},
        "kfOther":  {"firstName": "O", "phoneNumber": "555-000-0002"},
    }
    # 10 sms logs that all resolve to kfOther (none match the filter).
    db.data["sms_messages"] = {
        f"s{i}": {"callerNumber": "5550000002", "body": "x", "reconcileStatus": "pending"}
        for i in range(10)
    }
    processed = _stub_pass(db, max_per_run=3, kinfolk_id_filter="kfWanted")
    # Filtered-out logs count against the budget, so the pass stops at 3.
    assert processed == 3, f"filtered run must be bounded by max_per_run, processed={processed}"
    # None were claimed/mutated — they stay pending for an unfiltered pass.
    assert all(v["reconcileStatus"] == "pending" for v in db.data["sms_messages"].values())


# ---------- N60: stub-built doc with >=3 sources is not needsMoreSamples ----------

def test_stub_three_sources_not_flagged_needs_more_samples():
    db = FakeDb()
    db.data["kinfolk"] = {"kf1": {"firstName": "Dana", "phoneNumber": "555-000-1111"}}
    db.data["kin"] = {"k1": {"kinfolkId": "kf1", "name": "Rex", "species": "Dog"}}
    # Three distinct sms logs for the same kinfolk -> three stub merges -> three
    # [[source: ...]] citations -> count_sources >= 3 -> not needsMoreSamples.
    db.data["sms_messages"] = {
        f"s{i}": {"callerNumber": "5550001111", "body": f"msg {i}", "reconcileStatus": "pending"}
        for i in range(3)
    }
    _stub_pass(db, max_per_run=25)
    dossier = next(iter(db.data["dossiers"].values()))
    assert count_sources(dossier["rawSummary"]) >= 3, "stub merges must accumulate citations (N60)"
    assert dossier["needsMoreSamples"] is False, "a >=3-source stub doc must NOT be needsMoreSamples (N60)"


def test_stub_one_source_still_flagged_needs_more_samples():
    """Sanity: a single-source stub doc IS still flagged (threshold is 3)."""
    db = FakeDb()
    db.data["kinfolk"] = {"kf1": {"firstName": "Dana", "phoneNumber": "555-000-2222"}}
    db.data["kin"] = {"k1": {"kinfolkId": "kf1", "name": "Rex", "species": "Dog"}}
    db.data["sms_messages"] = {
        "s1": {"callerNumber": "5550002222", "body": "one", "reconcileStatus": "pending"},
    }
    _stub_pass(db, max_per_run=25)
    dossier = next(iter(db.data["dossiers"].values()))
    assert dossier["needsMoreSamples"] is True


# ---------- W34: stale root twin carries a deprecation banner ----------

def test_root_twin_has_deprecation_banner():
    root_twin = Path(__file__).resolve().parent.parent.parent / "reconcile_comms.py"
    if not root_twin.exists():
        # If the operator later deletes it, this finding is moot.
        return
    head = root_twin.read_text(encoding="utf-8")[:1200]
    assert "DEPRECATED" in head and "functions-python/reconcile_comms.py" in head, (
        "root twin must carry a deprecation banner pointing at the canonical module (W34)"
    )
