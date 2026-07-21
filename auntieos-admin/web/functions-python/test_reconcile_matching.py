"""Tests for reconcile_comms matching + failure-status hardening.

Covers:
 - WARNING-30: phone-match ambiguity (two kinfolk share last-10 digits) ->
   AMBIGUOUS_MATCH, caller marks 'error' (not first-wins, not 'skipped'); short
   needles (<10 digits) reject as a miss.
 - WARNING-31: email matcher direction — an OUTBOUND business->kinfolk email
   (kinfolk is in toAddresses) matches that kinfolk.
 - WARNING-33: a 411 fan-out failure leaves the source log NON-applied
   ('partial'), so it is not silently retired as success.

In-memory FakeDb mirrors test_reconcile_note.py.

Run:
    ./venv/bin/python -m pytest test_reconcile_matching.py -q
"""
from __future__ import annotations

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
        self.data = {}
        self.auto = 0

    def collection(self, name):
        return FakeCollection(self, name)


# ---------- WARNING-30: phone match ambiguity ----------

def test_two_kinfolk_same_last10_phone_is_ambiguous():
    db = FakeDb()
    db.data["kinfolk"] = {
        "kfA": {"firstName": "Ann", "phoneNumber": "+1 (555) 123-4567"},
        "kfB": {"firstName": "Bob", "phoneNumber": "555-123-4567"},  # same last-10
    }
    log = {"callerNumber": "15551234567"}
    result = rc.find_kinfolk_by_contact(db, "sms", log)
    assert result is rc.AMBIGUOUS_MATCH, "two kinfolk sharing last-10 must be ambiguous, not first-wins"


def test_single_phone_match_still_resolves():
    db = FakeDb()
    db.data["kinfolk"] = {
        "kfA": {"firstName": "Ann", "phoneNumber": "555-123-4567"},
        "kfB": {"firstName": "Bob", "phoneNumber": "555-999-0000"},
    }
    result = rc.find_kinfolk_by_contact(db, "sms", {"callerNumber": "5551234567"})
    assert result is not None and result is not rc.AMBIGUOUS_MATCH
    assert result[0] == "kfA"


def test_same_kinfolk_two_matching_fields_is_not_ambiguous():
    """A single kinfolk whose primary AND secondary phone both match is ONE hit."""
    db = FakeDb()
    db.data["kinfolk"] = {
        "kfA": {"firstName": "Ann", "phoneNumber": "555-123-4567", "secondaryPhone": "(555) 123-4567"},
    }
    result = rc.find_kinfolk_by_contact(db, "sms", {"callerNumber": "5551234567"})
    assert result is not None and result is not rc.AMBIGUOUS_MATCH
    assert result[0] == "kfA"


def test_short_phone_needle_is_a_miss():
    db = FakeDb()
    db.data["kinfolk"] = {"kfA": {"phoneNumber": "555-123-4567"}}
    # 7-digit needle must not be allowed to suffix-collide.
    assert rc.find_kinfolk_by_contact(db, "sms", {"callerNumber": "1234567"}) is None


def test_ambiguous_phone_marks_log_error_in_pass():
    """End-to-end: an ambiguous sms log is marked 'error' (ambiguous), not applied/skipped."""
    db = FakeDb()
    db.data["kinfolk"] = {
        "kfA": {"firstName": "Ann", "phoneNumber": "555-123-4567"},
        "kfB": {"firstName": "Bob", "phoneNumber": "5551234567"},
    }
    db.data["sms_messages"] = {
        "s1": {"callerNumber": "5551234567", "body": "hi", "reconcileStatus": "pending"},
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)
    s1 = db.data["sms_messages"]["s1"]
    assert s1["reconcileStatus"] == "error"
    assert "ambiguous" in s1["reconcileNotes"].lower()


# ---------- WARNING-31: email matcher direction ----------

def test_outbound_email_to_kinfolk_matches():
    """An outbound business->kinfolk email (kinfolk in toAddresses) must match."""
    db = FakeDb()
    db.data["kinfolk"] = {
        "kfA": {"firstName": "Ann", "email": "ann@example.com"},
    }
    log = {
        "direction": "outbound",
        "fromAddress": "auntie@business.com",   # business, never a kinfolk
        "toAddresses": ["ann@example.com"],
    }
    result = rc.find_kinfolk_by_contact(db, "email", log)
    assert result is not None and result is not rc.AMBIGUOUS_MATCH
    assert result[0] == "kfA"


def test_inbound_email_from_kinfolk_matches():
    db = FakeDb()
    db.data["kinfolk"] = {"kfA": {"email": "ann@example.com"}}
    log = {
        "direction": "inbound",
        "fromAddress": "ann@example.com",
        "toAddresses": ["auntie@business.com"],
    }
    result = rc.find_kinfolk_by_contact(db, "email", log)
    assert result is not None and result[0] == "kfA"


def test_email_unknown_direction_tries_both_ends():
    """No direction field -> defensively match either from or any to-address."""
    db = FakeDb()
    db.data["kinfolk"] = {"kfA": {"email": "ann@example.com"}}
    # Kinfolk only in toAddresses, no direction field.
    log = {"fromAddress": "auntie@business.com", "toAddresses": ["x@y.com", "ann@example.com"]}
    result = rc.find_kinfolk_by_contact(db, "email", log)
    assert result is not None and result[0] == "kfA"


def test_email_duplicate_address_across_kinfolk_is_ambiguous():
    db = FakeDb()
    db.data["kinfolk"] = {
        "kfA": {"email": "shared@example.com"},
        "kfB": {"secondaryEmail": "shared@example.com"},
    }
    log = {"direction": "inbound", "fromAddress": "shared@example.com"}
    assert rc.find_kinfolk_by_contact(db, "email", log) is rc.AMBIGUOUS_MATCH


def test_email_no_candidate_is_miss():
    db = FakeDb()
    db.data["kinfolk"] = {"kfA": {"email": "ann@example.com"}}
    assert rc.find_kinfolk_by_contact(db, "email", {"toAddresses": []}) is None


# ---------- WARNING-33: 411 failure must not mark log applied ----------

def test_411_failure_leaves_log_partial_not_applied(monkeypatch):
    """If the 411 fan-out fails for a kin, the source log must NOT be 'applied'."""
    db = FakeDb()
    db.data["kinfolk"] = {"kf1": {"firstName": "Dana", "lastName": "Reed"}}
    db.data["kin"] = {"k1": {"kinfolkId": "kf1", "name": "Rex", "species": "Dog"}}
    db.data["training_documents"] = {
        "n1": {
            "targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "k1",
            "content": "Rex is allergic to chicken.", "reconcileStatus": "pending",
        }
    }

    # Force the 411 merge to fail (use_stub=False so claude_merge_411 is hit).
    def boom(*a, **k):
        raise RuntimeError("simulated 411 failure")

    def fake_dossier_merge(*a, **k):
        return ("dossier summary [[source: note on 2026-06-22]]", {}, "")

    monkeypatch.setattr(rc, "claude_merge_411", boom)
    monkeypatch.setattr(rc, "claude_merge", fake_dossier_merge)

    rc.reconcile_pass(db, max_per_run=25, use_stub=False)

    note = db.data["training_documents"]["n1"]
    assert note["reconcileStatus"] != "applied", (
        "a 411 fan-out failure must NOT mark the source log applied (WARNING-33)"
    )
    assert note["reconcileStatus"] == "partial"
    assert "ERROR(kin/k1)" in note["reconcileNotes"]


def test_411_success_still_marks_applied(monkeypatch):
    """Sanity: when the 411 fan-out succeeds, the log is still marked applied."""
    db = FakeDb()
    db.data["kinfolk"] = {"kf1": {"firstName": "Dana", "lastName": "Reed"}}
    db.data["kin"] = {"k1": {"kinfolkId": "kf1", "name": "Rex", "species": "Dog"}}
    db.data["training_documents"] = {
        "n1": {
            "targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "k1",
            "content": "Rex is allergic to chicken.", "reconcileStatus": "pending",
        }
    }

    def fake_dossier_merge(*a, **k):
        return ("dossier summary [[source: note on 2026-06-22]]", {}, "")

    def fake_411_merge(*a, **k):
        return ("411 summary [[source: note on 2026-06-22]]", {}, "")

    monkeypatch.setattr(rc, "claude_merge", fake_dossier_merge)
    monkeypatch.setattr(rc, "claude_merge_411", fake_411_merge)

    rc.reconcile_pass(db, max_per_run=25, use_stub=False)
    assert db.data["training_documents"]["n1"]["reconcileStatus"] == "applied"
