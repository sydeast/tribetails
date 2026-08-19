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
