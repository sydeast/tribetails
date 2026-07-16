"""Doc-id asymmetry fix for reconcile_comms.upsert_dossier.

The generator point-reads dossiers.doc(kinfolkId) (web/functions/generate.js). A
freshly-created dossier must therefore be keyed by the kinfolkId, not an auto-id.
This pins that: new dossier doc-id == kinfolkId (happy), existing canonical doc is
reused not duplicated (sad), and a legacy mis-keyed doc is updated-in-place rather
than duplicated (negative; migrating its id to canonical is the seeder's job).

Run:
    android/.venv/bin/python -m pytest test_reconcile_docid.py -q
"""
from __future__ import annotations

import reconcile_comms as rc


# ---------- in-memory fake Firestore ----------

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
        self._store, self._coll, self._id = store, coll, doc_id

    @property
    def id(self):
        return self._id

    def get(self):
        return FakeSnap(self._id, self._store.data.get(self._coll, {}).get(self._id))

    def set(self, data, merge=False):
        coll = self._store.data.setdefault(self._coll, {})
        if merge and coll.get(self._id) is not None:
            cur = dict(coll[self._id]); cur.update(data); coll[self._id] = cur
        else:
            coll[self._id] = dict(data)


class FakeQuery:
    def __init__(self, store, coll, filters=None, lim=None):
        self._store, self._coll, self._filters, self._lim = store, coll, filters or [], lim

    def where(self, field, op, value):
        return FakeQuery(self._store, self._coll, self._filters + [(field, op, value)], self._lim)

    def limit(self, n):
        return FakeQuery(self._store, self._coll, self._filters, n)

    def stream(self):
        rows = [FakeSnap(i, d) for i, d in (self._store.data.get(self._coll) or {}).items()
                if d is not None and all(d.get(f) == v for (f, op, v) in self._filters if op == "==")]
        return iter(rows[: self._lim] if self._lim is not None else rows)


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


# ---------- the fix ----------

def test_new_dossier_doc_id_equals_kinfolkid():
    db = FakeDb()
    rc.upsert_dossier(db, "kf1", "summary one", "T", "sms_messages/m1", False, {})
    dossiers = db.data["dossiers"]
    assert list(dossiers) == ["kf1"]                      # keyed by kinfolkId, not auto-id
    assert dossiers["kf1"]["kinfolkId"] == "kf1"
    # The generator's point-read must resolve it.
    assert db.collection("dossiers").document("kf1").get().exists


def test_existing_canonical_dossier_reused_not_duplicated():
    db = FakeDb()
    db.data["dossiers"] = {"kf1": {"kinfolkId": "kf1", "rawSummary": "old"}}
    rc.upsert_dossier(db, "kf1", "new summary", "T", "sms_messages/m2", False, {})
    assert list(db.data["dossiers"]) == ["kf1"]           # still one doc
    assert db.data["dossiers"]["kf1"]["rawSummary"] == "new summary"


def test_legacy_miskeyed_dossier_updated_in_place_not_duplicated():
    db = FakeDb()
    db.data["dossiers"] = {"legacy-auto": {"kinfolkId": "kf1", "rawSummary": "old"}}
    rc.upsert_dossier(db, "kf1", "new summary", "T", "sms_messages/m3", False, {})
    # The where-query finds the legacy doc and updates it in place: no duplicate.
    assert list(db.data["dossiers"]) == ["legacy-auto"]
    assert db.data["dossiers"]["legacy-auto"]["rawSummary"] == "new summary"
