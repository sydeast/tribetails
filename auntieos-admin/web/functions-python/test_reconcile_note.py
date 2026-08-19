"""Tests for the Tribal Intel `note` channel in reconcile_comms.py.

In-memory fake Firestore (collection/document/where/stream/get/set/update) drives
reconcile_pass with use_stub=True (no LLM cost) over a seeded training_documents
note plus a kinfolk + kin, asserting the dossier + 411 upserts fire and the
source note flips to 'applied'.

Run:
    ./venv/bin/python -m pytest test_reconcile_note.py -q
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


def seed_household():
    db = FakeDb()
    db.data["kinfolk"] = {"kf1": {"firstName": "Dana", "lastName": "Reed"}}
    db.data["kin"] = {
        "k1": {"kinfolkId": "kf1", "name": "Rex", "species": "Dog"},
        "k2": {"kinfolkId": "kf1", "name": "Nova", "species": "Cat"},
    }
    return db


# ---------- find_kinfolk_by_contact note branch ----------

def test_note_branch_resolves_by_target_kinfolk_id():
    db = seed_household()
    log = {"targetType": "KINFOLK", "targetKinfolkId": "kf1", "content": "x"}
    match = rc.find_kinfolk_by_contact(db, "note", log)
    assert match is not None
    assert match[0] == "kf1"


def test_note_branch_no_target_is_miss():
    db = seed_household()
    log = {"targetType": "KINFOLK", "content": "x"}
    assert rc.find_kinfolk_by_contact(db, "note", log) is None


# ---------- body extractor ----------

def test_extract_body_includes_content_notes_and_attachment_provenance():
    body = rc.extract_log_body({
        "title": "Gate code",
        "content": "Side gate code is 4321.",
        "notes": "Use the back path.",
        "attachments": [
            {"fileName": "gate.jpg", "storageUrl": "https://res.cloudinary.com/x/gate.jpg"},
        ],
    })
    assert "Gate code" in body
    assert "4321" in body
    assert "back path" in body
    assert "gate.jpg" in body
    assert "provenance only" in body


# ---------- target classification (issue #461) ----------
#
# resolve_target_type is the pipeline half of the agreement with the clients.
# The other half is `tribalIntelFormat.ts#tribalIntelTarget` (web) and
# `TribalIntelTarget.kt#tribalIntelTarget` (Android); the cases below are the
# same cases those two suites assert, so a divergence fails on both sides.

def test_resolve_target_kin_needs_a_named_kin():
    assert rc.resolve_target_type("note", {"targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "k1"}) == "KIN"
    # A KIN row naming no animal cannot route to one: it falls to the household.
    assert rc.resolve_target_type("note", {"targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": ""}) == "HOUSEHOLD"


def test_resolve_target_kinfolk_needs_an_anchor():
    assert rc.resolve_target_type("note", {"targetType": "KINFOLK", "targetKinfolkId": "kf1"}) == "KINFOLK"
    assert rc.resolve_target_type("note", {"targetType": "KINFOLK"}) == "HOUSEHOLD"


def test_resolve_target_household_and_legacy_untargeted_rows():
    assert rc.resolve_target_type("note", {"targetType": "HOUSEHOLD", "targetKinfolkId": "kf1"}) == "HOUSEHOLD"
    # THE LEGACY DECISION: a pre-#427 row carries kinfolkRef and no targetType.
    # It becomes HOUSEHOLD, explicitly, not by falling through a default.
    assert rc.resolve_target_type("note", {"kinfolkRef": "kf1"}) == "HOUSEHOLD"
    assert rc.LEGACY_UNTARGETED_TARGET == "HOUSEHOLD"


def test_resolve_target_is_none_for_untargeted_channels():
    """Voicemail/call/sms/email/kintale are addressed by nobody, so they are not
    silently treated as household-targeted; they keep the old fan-out."""
    for channel in ("voicemail", "call", "sms", "email", "kintale"):
        assert rc.resolve_target_type(channel, {"targetType": "KIN", "targetKinId": "k1"}) is None


# ---------- fan-out ----------

def test_kin_target_fans_to_single_kin():
    db = seed_household()
    log = {"targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "k1"}
    ids = rc.kin_ids_for_household(db, "kf1", log, "note")
    assert ids == ["k1"]


def test_kinfolk_target_reaches_no_kin_at_all():
    """#461: a note about one person stops reaching every pet."""
    db = seed_household()
    log = {"targetType": "KINFOLK", "targetKinfolkId": "kf1"}
    assert rc.kin_ids_for_household(db, "kf1", log, "note") == []


def test_household_target_reaches_no_kin_at_all():
    db = seed_household()
    log = {"targetType": "HOUSEHOLD", "targetKinfolkId": "kf1"}
    assert rc.kin_ids_for_household(db, "kf1", log, "note") == []


def test_untargeted_channel_still_fans_to_all_household_kin():
    """The routing change is scoped to the note channel. A KinTale still reaches
    every pet in the home, which is RULING R1 and is unchanged by #461."""
    db = seed_household()
    ids = rc.kin_ids_for_household(db, "kf1", {}, "kintale")
    assert set(ids) == {"k1", "k2"}


# ---------- full reconcile_pass (stub, no LLM) ----------

def test_reconcile_pass_kin_target_writes_only_that_kins_411():
    """KIN-targeted: the 411 and nothing else. Before #461 this also wrote the
    household's dossier, which filed a fact about one pet under the whole home."""
    db = seed_household()
    db.data["training_documents"] = {
        "n1": {
            "targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "k1",
            "content": "Rex is allergic to chicken.", "reconcileStatus": "pending",
        }
    }
    processed = rc.reconcile_pass(db, max_per_run=25, use_stub=True)
    assert processed >= 1

    note = db.data["training_documents"]["n1"]
    assert note["reconcileStatus"] == "applied"
    assert "the_411/411_k1" in note["reconcileNotes"]
    assert "dossiers/" not in note["reconcileNotes"]
    assert "household_bank/" not in note["reconcileNotes"]

    # Only the single targeted kin's 411 was touched.
    the_411 = db.data.get("the_411", {})
    touched = [v for v in the_411.values() if v and "training_documents/n1" in (v.get("lastReconcileSourceLogIds") or [])]
    assert {v["kinId"] for v in touched} == {"k1"}

    # No dossier and no bank were created by a kin-targeted note.
    assert db.data.get("dossiers", {}) == {}
    assert db.data.get("household_bank", {}) == {}


def test_reconcile_pass_kinfolk_target_writes_only_the_dossier():
    """KINFOLK-targeted: the dossier and nothing else. Before #461 this fanned
    out to every pet in the household."""
    db = seed_household()
    db.data["training_documents"] = {
        "n2": {
            "targetType": "KINFOLK", "targetKinfolkId": "kf1",
            "content": "Dana prefers texts over calls.", "reconcileStatus": "pending",
        }
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    note = db.data["training_documents"]["n2"]
    assert note["reconcileStatus"] == "applied"
    assert "dossiers/kf1" in note["reconcileNotes"]
    assert "the_411" not in note["reconcileNotes"]

    dossier = db.data["dossiers"]["kf1"]
    assert "training_documents/n2" in dossier["lastReconcileSourceLogIds"]
    assert db.data.get("the_411", {}) == {}
    assert db.data.get("household_bank", {}) == {}


def test_reconcile_pass_household_target_writes_only_the_bank():
    """HOUSEHOLD-targeted: the household's own record, the peer of the other two."""
    db = seed_household()
    db.data["training_documents"] = {
        "n4": {
            "targetType": "HOUSEHOLD", "targetKinfolkId": "kf1",
            "content": "Side gate code is 4321.", "reconcileStatus": "pending",
        }
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    note = db.data["training_documents"]["n4"]
    assert note["reconcileStatus"] == "applied"
    assert "household_bank/kf1" in note["reconcileNotes"]

    bank = db.data["household_bank"]["kf1"]
    assert bank["householdId"] == "kf1"
    assert "training_documents/n4" in bank["lastReconcileSourceLogIds"]
    assert "4321" in bank["rawSummary"]
    # The stub emits a real citation, so a stub-built bank is not permanently
    # flagged needsMoreSamples for the wrong reason (NOTE-60).
    from reconcile_prompts import count_sources
    assert count_sources(bank["rawSummary"]) == 1

    assert db.data.get("dossiers", {}) == {}
    assert db.data.get("the_411", {}) == {}


def test_reconcile_pass_legacy_untargeted_note_goes_to_the_bank():
    """A row written before the three targets existed: no targetType at all.
    It becomes HOUSEHOLD, so it lands in the bank."""
    db = seed_household()
    db.data["training_documents"] = {
        "n5": {
            "targetKinfolkId": "kf1",
            "content": "Trash goes out Tuesday night.", "reconcileStatus": "pending",
        }
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    assert db.data["training_documents"]["n5"]["reconcileStatus"] == "applied"
    assert "household_bank/kf1" in db.data["training_documents"]["n5"]["reconcileNotes"]
    assert db.data["household_bank"]["kf1"]["householdId"] == "kf1"
    assert db.data.get("dossiers", {}) == {}
    assert db.data.get("the_411", {}) == {}


def test_reconcile_pass_untargeted_channel_still_writes_dossier_and_all_411s():
    """The other five channels are untouched by #461."""
    db = seed_household()
    db.data["kin_care_reports"] = {
        "r1": {"kinfolkId": "kf1", "summary": "Both pets did great.", "reconcileStatus": "pending"},
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    assert db.data["kin_care_reports"]["r1"]["reconcileStatus"] == "applied"
    assert db.data["dossiers"]["kf1"]["kinfolkId"] == "kf1"
    touched = {v["kinId"] for v in db.data["the_411"].values()
               if v and "kin_care_reports/r1" in (v.get("lastReconcileSourceLogIds") or [])}
    assert touched == {"k1", "k2"}
    assert db.data.get("household_bank", {}) == {}


# ---------- household bank upsert (peer of upsert_dossier / upsert_kin411) ----------

def test_new_household_bank_doc_id_equals_household_id():
    db = FakeDb()
    rc.upsert_household_bank(db, "kf1", "bank one", "T", "training_documents/n1", False, {})
    assert list(db.data["household_bank"]) == ["kf1"]
    assert db.collection("household_bank").document("kf1").get().exists


def test_existing_household_bank_reused_not_duplicated():
    db = FakeDb()
    db.data["household_bank"] = {"legacy-auto-id": {"householdId": "kf1", "rawSummary": "old"}}
    rc.upsert_household_bank(db, "kf1", "new summary", "T", "training_documents/n2", False, {})
    assert list(db.data["household_bank"]) == ["legacy-auto-id"]
    assert db.data["household_bank"]["legacy-auto-id"]["rawSummary"] == "new summary"


def test_empty_tldr_does_not_clobber_existing_bank_tldr():
    db = FakeDb()
    rc.upsert_household_bank(db, "kf1", "summary", "T", "src/1", False, {}, tldr="EXISTING TLDR")
    assert db.data["household_bank"]["kf1"]["tldr"] == "EXISTING TLDR"
    rc.upsert_household_bank(db, "kf1", "summary2", "T2", "src/2", False, {}, tldr="")
    assert db.data["household_bank"]["kf1"]["tldr"] == "EXISTING TLDR"
    rc.upsert_household_bank(db, "kf1", "summary3", "T3", "src/3", False, {}, tldr="NEW TLDR")
    assert db.data["household_bank"]["kf1"]["tldr"] == "NEW TLDR"


def test_operator_edited_bank_field_is_never_overwritten():
    db = FakeDb()
    rc.upsert_household_bank(db, "kf1", "s1", "T", "src/1", False, {"accessAndEntry": "gate 1111"})
    assert db.data["household_bank"]["kf1"]["accessAndEntry"] == "gate 1111"
    rc.upsert_household_bank(db, "kf1", "s2", "T2", "src/2", False, {"accessAndEntry": "gate 9999"})
    assert db.data["household_bank"]["kf1"]["accessAndEntry"] == "gate 1111"


def test_reconcile_pass_no_target_marks_skipped():
    db = seed_household()
    db.data["training_documents"] = {
        "n3": {"targetType": "KINFOLK", "content": "orphan note", "reconcileStatus": "pending"}
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)
    assert db.data["training_documents"]["n3"]["reconcileStatus"] == "skipped"


# ---------- doc-id asymmetry fix (generator point-reads dossiers.doc(kinfolkId)) ----------

def test_new_dossier_doc_id_equals_kinfolkid():
    db = FakeDb()
    rc.upsert_dossier(db, "kf1", "summary one", "T", "voicemails/v1", False, {})
    assert list(db.data["dossiers"]) == ["kf1"]            # keyed by kinfolkId, not auto-id
    assert db.collection("dossiers").document("kf1").get().exists  # point-read resolves


def test_existing_dossier_reused_not_duplicated():
    db = FakeDb()
    db.data["dossiers"] = {"kf1": {"kinfolkId": "kf1", "rawSummary": "old"}}
    rc.upsert_dossier(db, "kf1", "new summary", "T", "voicemails/v2", False, {})
    assert list(db.data["dossiers"]) == ["kf1"]


# ---------- tldr no-clobber (empty tldr must not overwrite an existing one) ----------

def test_empty_tldr_does_not_clobber_existing_dossier_tldr():
    db = FakeDb()
    # Seed an existing dossier carrying a real tldr.
    rc.upsert_dossier(db, "kf1", "summary", "T", "src/1", False, {}, tldr="EXISTING TLDR")
    assert db.data["dossiers"]["kf1"]["tldr"] == "EXISTING TLDR"

    # Stub / no-LLM path emits an empty tldr — it must NOT clobber the existing one.
    rc.upsert_dossier(db, "kf1", "summary2", "T2", "src/2", False, {}, tldr="")
    assert db.data["dossiers"]["kf1"]["tldr"] == "EXISTING TLDR"

    # A fresh non-empty tldr DOES overwrite.
    rc.upsert_dossier(db, "kf1", "summary3", "T3", "src/3", False, {}, tldr="NEW TLDR")
    assert db.data["dossiers"]["kf1"]["tldr"] == "NEW TLDR"
