"""Tests for the untargeted-Tribal-Intel backfill (issue #461).

The script itself is operator-run against production and is never executed here.
What IS worth pinning is its decision rule: which rows it claims, which it leaves
alone, and that the value it writes is the same one the nightly pipeline infers.

Run:
    ./venv/bin/python -m pytest test_backfill_tribal_intel_target_type.py -q
"""
from __future__ import annotations

import backfill_tribal_intel_target_type as bf
import reconcile_comms as rc


def test_missing_target_type_is_claimed():
    assert bf.needs_backfill({"kinfolkRef": "kf1", "content": "legacy row"}) is True


def test_blank_target_type_is_claimed():
    assert bf.needs_backfill({"targetType": "", "targetKinfolkId": "kf1"}) is True
    assert bf.needs_backfill({"targetType": "   ", "targetKinfolkId": "kf1"}) is True


def test_any_stored_target_type_is_left_alone():
    for stored in ("HOUSEHOLD", "KINFOLK", "KIN", "something-nobody-recognises"):
        assert bf.needs_backfill({"targetType": stored}) is False


def test_backfilled_value_matches_what_the_pipeline_already_infers():
    """The script and the nightly job must agree about what an untargeted row is.

    If they drift, a row means one thing before the migration and another after,
    which is precisely the silent default issue #461 asked to be made explicit.
    """
    assert bf.LEGACY_UNTARGETED_TARGET == rc.LEGACY_UNTARGETED_TARGET == "HOUSEHOLD"
    legacy_row = {"kinfolkRef": "kf1", "content": "legacy row"}
    assert rc.resolve_target_type("note", legacy_row) == bf.LEGACY_UNTARGETED_TARGET
    # And a row the script has stamped routes to the same place it did before.
    stamped = {**legacy_row, "targetType": bf.LEGACY_UNTARGETED_TARGET}
    assert rc.resolve_target_type("note", stamped) == rc.TARGET_HOUSEHOLD


# ---------- a writing sample is not an untargeted note ----------

# The shape a voice example is stored in: it says its kind and names no household.
VOICE_EXAMPLE = {
    "title": "A visit recap",
    "content": "Hi there! Quick note from this afternoon.",
    "documentKind": "voice_example",
    "communicationType": "email",
}


def test_a_voice_example_is_recognised_by_its_kind_alone():
    assert bf.is_voice_example(VOICE_EXAMPLE) is True
    assert bf.is_voice_example({**VOICE_EXAMPLE, "documentKind": " voice_example "}) is True
    # It still says so when it also carries an anchor: not this script's to settle.
    assert bf.is_voice_example({**VOICE_EXAMPLE, "kinfolkRef": "kf1"}) is True


def test_a_note_or_an_unsorted_row_is_not_a_voice_example():
    assert bf.is_voice_example({"documentKind": "note"}) is False
    assert bf.is_voice_example({"kinfolkRef": "kf1", "content": "legacy row"}) is False
    assert bf.is_voice_example({"documentKind": ""}) is False
    assert bf.is_voice_example({"documentKind": None}) is False
    assert bf.is_voice_example({"documentKind": 7}) is False
    assert bf.is_voice_example({"documentKind": "VOICE_EXAMPLE"}) is False
    # communicationType is free text on a note and decides nothing.
    assert bf.is_voice_example({"communicationType": "voice_example"}) is False


def test_a_voice_example_with_no_target_is_never_stamped():
    """It carries no targetType on purpose, so the targetType test alone would claim it."""
    assert bf.needs_backfill(VOICE_EXAMPLE) is True
    assert bf.row_decision(VOICE_EXAMPLE) == bf.DECISION_VOICE_EXAMPLE
    assert bf.row_decision({**VOICE_EXAMPLE, "targetType": "  "}) == bf.DECISION_VOICE_EXAMPLE


def test_an_untargeted_note_is_still_stamped():
    assert bf.row_decision({"kinfolkRef": "kf1", "content": "legacy row"}) == bf.DECISION_BACKFILL
    assert bf.row_decision({"documentKind": "note", "targetType": "", "targetKinfolkId": "kf1"}) == bf.DECISION_BACKFILL
    assert bf.row_decision({"documentKind": "note", "kinfolkRef": "kf1"}) == bf.DECISION_BACKFILL


def test_rows_left_alone_for_another_reason_keep_that_reason():
    assert bf.row_decision({"_demo": True, "documentKind": "voice_example"}) == bf.DECISION_DEMO
    assert bf.row_decision({"targetType": "KIN", "targetKinId": "k1"}) == bf.DECISION_ALREADY
    assert bf.row_decision({"documentKind": "voice_example", "targetType": "HOUSEHOLD"}) == bf.DECISION_ALREADY


class _FakeRef:
    def __init__(self, store: dict, doc_id: str):
        self._store, self._id = store, doc_id

    def update(self, fields: dict) -> None:
        self._store[self._id] = {**self._store[self._id], **fields}


class _FakeDoc:
    def __init__(self, store: dict, doc_id: str):
        self.id = doc_id
        self._store = store
        self.reference = _FakeRef(store, doc_id)

    def to_dict(self) -> dict:
        return dict(self._store[self.id])


class _FakeDb:
    """Just enough of a Firestore client for `main`: one collection, streamed."""

    def __init__(self, rows: dict):
        self.rows = rows

    def collection(self, name: str):
        assert name == bf.COLLECTION
        return self

    def stream(self):
        return [_FakeDoc(self.rows, doc_id) for doc_id in list(self.rows)]


def _rows() -> dict:
    return {
        "legacy": {"kinfolkRef": "kf1", "content": "Trash goes out Tuesday night."},
        "voice": dict(VOICE_EXAMPLE),
        "kin-note": {"documentKind": "note", "targetType": "KIN", "targetKinfolkId": "kf1", "targetKinId": "k1"},
        "demo": {"_demo": True, "content": "sample"},
    }


def _run_main(monkeypatch, argv: list[str], db: _FakeDb) -> None:
    # No Firebase app, no credentials, no network: the client is the fake above.
    monkeypatch.setattr(bf, "init_firebase", lambda allow_prod: db)
    monkeypatch.setattr(bf.sys, "argv", ["backfill_tribal_intel_target_type.py", *argv])
    bf.main()


def test_a_committed_run_stamps_the_legacy_note_and_leaves_the_voice_example(monkeypatch, capsys):
    db = _FakeDb(_rows())
    _run_main(monkeypatch, ["--allow-prod"], db)

    assert db.rows["legacy"]["targetType"] == "HOUSEHOLD"
    assert "_targetTypeBackfillAt" in db.rows["legacy"]
    # Exactly what it was: no target, no marker, still a voice example.
    assert db.rows["voice"] == VOICE_EXAMPLE
    assert db.rows["kin-note"] == _rows()["kin-note"]
    assert db.rows["demo"] == _rows()["demo"]

    out = capsys.readouterr().out
    assert "PROD WRITE COMMITTED" in out
    assert "total docs scanned            : 4" in out
    assert "already have a targetType     : 1" in out
    assert "_demo (skipped)               : 1" in out
    assert "voice examples (skipped)      : 1" in out
    assert "UNTARGETED (-> HOUSEHOLD) : 1" in out
    assert "legacy: targetType (absent)" in out
    assert "voice: targetType" not in out


def test_a_dry_run_reports_the_same_counts_and_writes_nothing(monkeypatch, capsys):
    db = _FakeDb(_rows())
    _run_main(monkeypatch, [], db)

    assert db.rows == _rows()
    out = capsys.readouterr().out
    assert "DRY RUN (no writes)" in out
    assert "voice examples (skipped)      : 1" in out
    assert "UNTARGETED (-> HOUSEHOLD) : 1" in out


def test_a_second_committed_run_finds_nothing_to_do(monkeypatch, capsys):
    db = _FakeDb(_rows())
    _run_main(monkeypatch, ["--allow-prod"], db)
    after_first = {k: dict(v) for k, v in db.rows.items()}
    capsys.readouterr()

    _run_main(monkeypatch, ["--allow-prod"], db)
    assert db.rows == after_first
    out = capsys.readouterr().out
    assert "voice examples (skipped)      : 1" in out
    assert "UNTARGETED (-> HOUSEHOLD) : 0" in out
