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
