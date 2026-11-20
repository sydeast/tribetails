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


def test_reconcile_pass_kin_target_pointing_at_a_deleted_kin_is_an_error():
    """A targeted note has exactly one destination and no fallback.

    Before #461 a KIN-targeted note whose pet had since been deleted still landed
    in the household's dossier. Now there is nowhere else for it to go, so
    retiring it 'applied' would drop the operator's words in silence. It must
    fail loud and stay triageable, the way an ambiguous contact match does.
    """
    db = seed_household()
    db.data["training_documents"] = {
        "n6": {
            "targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "ghost",
            "content": "Ghost needs meds at 8am.", "reconcileStatus": "pending",
        }
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    note = db.data["training_documents"]["n6"]
    assert note["reconcileStatus"] == "error"
    assert "kin/ghost" in note["reconcileNotes"]
    # Nothing was written anywhere, least of all into the household's records.
    assert db.data.get("dossiers", {}) == {}
    assert db.data.get("the_411", {}) == {}
    assert db.data.get("household_bank", {}) == {}


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


# ---------- a 411 takes notes from its own household only ----------

def seed_two_households():
    """seed_household plus a second home, kf2, whose Kin k9 already has a 411."""
    db = seed_household()
    db.data["kinfolk"]["kf2"] = {"firstName": "Sam", "lastName": "Ortiz"}
    db.data["kin"]["k9"] = {"kinfolkId": "kf2", "name": "Milo", "species": "Dog"}
    db.data["the_411"] = {
        "411_k9": {"kinId": "k9", "rawSummary": "Milo eats at 7.", "lastReconcileSourceLogIds": []},
    }
    return db


def test_kin_belongs_to_household_compares_the_kins_own_household():
    assert rc.kin_belongs_to_household({"kinfolkId": "kf1"}, "kf1") is True
    assert rc.kin_belongs_to_household({"kinfolkId": " kf1 "}, "kf1") is True
    assert rc.kin_belongs_to_household({"kinfolkId": "kf2"}, "kf1") is False


def test_kin_belongs_to_household_accepts_a_kin_with_no_household_on_record():
    """The save callables accept a note about a Kin whose record names no
    household, and so does the pipeline: there is no second home to cross into."""
    assert rc.kin_belongs_to_household({}, "kf1") is True
    assert rc.kin_belongs_to_household({"kinfolkId": ""}, "kf1") is True
    assert rc.kin_belongs_to_household({"kinfolkId": None}, "kf1") is True


def test_kin_belongs_to_household_reads_a_household_that_is_not_text_as_none():
    """Read the way the save callables read it, and never an exception: the
    check runs after the log is claimed."""
    for stored in (7, 0, True, ["kf2"], {"id": "kf2"}):
        assert rc.kin_belongs_to_household({"kinfolkId": stored}, "kf1") is True


def test_reconcile_pass_finishes_the_log_when_a_kins_household_is_not_text():
    """A claimed log is always retired. A stray value on the Kin's record must
    not end the pass and leave the note waiting forever."""
    db = seed_household()
    db.data["kin"]["k7"] = {"kinfolkId": 7, "name": "Pip", "species": "Rabbit"}
    db.data["training_documents"] = {
        "n10": {
            "targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "k7",
            "content": "Pip likes cilantro.", "reconcileStatus": "pending",
        }
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    note = db.data["training_documents"]["n10"]
    assert note["reconcileStatus"] == "applied"
    assert "the_411/411_k7" in note["reconcileNotes"]


def test_reconcile_pass_kin_target_in_another_household_writes_nothing():
    """A note filed under one household that names another household's Kin
    lands nowhere, and says why."""
    db = seed_two_households()
    db.data["training_documents"] = {
        "n7": {
            "targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "k9",
            "content": "Give the evening pill with food.", "reconcileStatus": "pending",
        }
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    note = db.data["training_documents"]["n7"]
    assert note["reconcileStatus"] == "error"
    assert "kin/k9" in note["reconcileNotes"]
    assert "another household" in note["reconcileNotes"]
    # The note's own row never names the other home.
    assert "kf2" not in note["reconcileNotes"]

    # The other household's 411 is exactly as it was.
    assert db.data["the_411"] == {
        "411_k9": {"kinId": "k9", "rawSummary": "Milo eats at 7.", "lastReconcileSourceLogIds": []},
    }
    assert db.data.get("dossiers", {}) == {}
    assert db.data.get("household_bank", {}) == {}


def test_reconcile_pass_kintale_skips_only_the_kin_from_another_household():
    """A KinTale listing two Kin, one of them from another home: its own Kin's
    411 and its household's dossier are written, the other Kin's 411 is not."""
    db = seed_two_households()
    db.data["kin_care_reports"] = {
        "r2": {
            "kinfolkId": "kf1", "kinIds": ["k1", "k9"],
            "summary": "Long walk, ate everything.", "reconcileStatus": "pending",
        },
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    report = db.data["kin_care_reports"]["r2"]
    # 'applied', not 'partial': a later pass could never land the skipped Kin.
    assert report["reconcileStatus"] == "applied"
    assert "the_411/411_k1" in report["reconcileNotes"]
    assert "skipped kin/k9 (another household)" in report["reconcileNotes"]
    assert "ERROR(" not in report["reconcileNotes"]
    assert "kf2" not in report["reconcileNotes"]

    assert "kin_care_reports/r2" in db.data["the_411"]["411_k1"]["lastReconcileSourceLogIds"]
    assert db.data["the_411"]["411_k9"] == {
        "kinId": "k9", "rawSummary": "Milo eats at 7.", "lastReconcileSourceLogIds": [],
    }
    assert "kin_care_reports/r2" in db.data["dossiers"]["kf1"]["lastReconcileSourceLogIds"]


def test_reconcile_pass_kintale_naming_only_another_households_kin_keeps_the_dossier():
    db = seed_two_households()
    db.data["kin_care_reports"] = {
        "r3": {"kinfolkId": "kf1", "kinIds": ["k9"], "summary": "Quiet visit.", "reconcileStatus": "pending"},
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    report = db.data["kin_care_reports"]["r3"]
    assert report["reconcileStatus"] == "applied"
    assert "dossiers/kf1" in report["reconcileNotes"]
    assert "skipped kin/k9 (another household)" in report["reconcileNotes"]
    assert db.data["the_411"]["411_k9"]["rawSummary"] == "Milo eats at 7."


def test_reconcile_pass_kin_with_no_household_on_record_still_takes_its_note():
    db = seed_household()
    db.data["kin"]["k7"] = {"name": "Pip", "species": "Rabbit"}
    db.data["training_documents"] = {
        "n8": {
            "targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "k7",
            "content": "Pip likes cilantro.", "reconcileStatus": "pending",
        }
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True)

    note = db.data["training_documents"]["n8"]
    assert note["reconcileStatus"] == "applied"
    assert "the_411/411_k7" in note["reconcileNotes"]


def test_dry_run_merges_nothing_for_a_kin_from_another_household(capsys):
    db = seed_two_households()
    db.data["training_documents"] = {
        "n9": {
            "targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "k9",
            "content": "Give the evening pill with food.", "reconcileStatus": "pending",
        }
    }
    rc.reconcile_pass(db, max_per_run=25, use_stub=True, dry_run=True)

    out = capsys.readouterr().out
    assert "kin/k9" in out
    assert "another household" in out
    # No merge was computed against the other household's 411, so none is printed.
    assert "NEW_411" not in out
    assert "Milo eats at 7." not in out
    assert db.data["training_documents"]["n9"]["reconcileStatus"] == "pending"
    assert db.data["the_411"]["411_k9"]["rawSummary"] == "Milo eats at 7."


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
