"""Tests for clear_dossier_household_notes: auth/validation + sets householdNotes=""
on the right dossier doc (deterministic id OR legacy auto-id). FakeDb, no live Firestore.
"""
import pytest
from unittest.mock import MagicMock

from firebase_functions.https_fn import CallableRequest, FunctionsErrorCode, HttpsError, AuthData

import reconcile_comms as rc
from main import _clear_dossier_household_notes


class FakeSnap:
    def __init__(self, _id, data):
        self.id = _id
        self._data = data
    def to_dict(self):
        return dict(self._data)

class FakeDocRef:
    def __init__(self, db, coll, doc_id):
        self._db = db; self._coll = coll; self._id = doc_id
    @property
    def id(self):
        return self._id
    def set(self, data, merge=False):
        store = self._db.data.setdefault(self._coll, {})
        cur = dict(store.get(self._id, {})) if merge else {}
        cur.update(data)
        store[self._id] = cur

class FakeQuery:
    def __init__(self, db, coll, docs):
        self._db = db; self._coll = coll; self._docs = docs
    def where(self, field, op, value):
        return FakeQuery(self._db, self._coll, [d for d in self._docs if d._data.get(field) == value])
    def limit(self, n):
        return FakeQuery(self._db, self._coll, self._docs[:n])
    def stream(self):
        return iter(self._docs)

class FakeCollection(FakeQuery):
    def document(self, doc_id):
        return FakeDocRef(self._db, self._coll, doc_id)

class FakeDb:
    def __init__(self):
        self.data = {}
    def collection(self, name):
        docs = [FakeSnap(k, v) for k, v in self.data.get(name, {}).items()]
        return FakeCollection(self, name, docs)

FAKE_DB = FakeDb()


def _make_req(data, auth):
    return CallableRequest(data=data, raw_request=MagicMock(), auth=auth)

def _admin():
    return AuthData(uid="admin-uid", token={"uid": "admin-uid", "admin": True})

def _non_admin():
    return AuthData(uid="u", token={"uid": "u"})


def test_non_admin_rejected():
    with pytest.raises(HttpsError) as ei:
        _clear_dossier_household_notes(_make_req({"kinfolkId": "kf1"}, _non_admin()), FAKE_DB)
    assert ei.value.code == FunctionsErrorCode.PERMISSION_DENIED


def test_missing_kinfolk_id_rejected():
    with pytest.raises(HttpsError) as ei:
        _clear_dossier_household_notes(_make_req({}, _admin()), FAKE_DB)
    assert ei.value.code == FunctionsErrorCode.INVALID_ARGUMENT


def test_clears_notes_on_deterministic_doc():
    db = FakeDb()
    db.data["dossiers"] = {"kf1": {"kinfolkId": "kf1", "householdNotes": "partner Bill, daughters weekends", "rawSummary": "keep me"}}
    res = _clear_dossier_household_notes(_make_req({"kinfolkId": "kf1"}, _admin()), db)
    assert res == {"kinfolkId": "kf1", "cleared": True}
    assert db.data["dossiers"]["kf1"]["householdNotes"] == ""
    assert db.data["dossiers"]["kf1"]["rawSummary"] == "keep me"  # other fields untouched


def test_clears_notes_on_legacy_autoid_doc():
    db = FakeDb()
    db.data["dossiers"] = {"auto_xyz": {"kinfolkId": "kf2", "householdNotes": "notes"}}
    res = _clear_dossier_household_notes(_make_req({"kinfolkId": "kf2"}, _admin()), db)
    assert res == {"kinfolkId": "kf2", "cleared": True}
    assert db.data["dossiers"]["auto_xyz"]["householdNotes"] == ""


def test_no_dossier_returns_not_cleared_without_creating_doc():
    db = FakeDb()
    res = _clear_dossier_household_notes(_make_req({"kinfolkId": "ghost"}, _admin()), db)
    assert res == {"kinfolkId": "ghost", "cleared": False}
    assert "dossiers" not in db.data or "ghost" not in db.data.get("dossiers", {})
