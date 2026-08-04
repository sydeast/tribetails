"""Unit tests for the visit_logs -> kin_care_reports migration helpers.

Covers the source fix for the operator's 2026-08-04 ruling: `createdAt` must be
the ORIGINAL creation instant PARSED from `visit_logs.submitted`, never the raw
free text (which sorts by month name) and never the ingest date (which makes
every imported row claim it was created the day it was imported). A row whose
submit stamp cannot be parsed is MARKED `createdAtSource='import'` rather than
passing its ingest date off as a creation date.

Both halves matter, because this field has been wrong in both directions. The
repair for rows already in production is
mytribe/scripts/backfillKinTaleCreatedAtProvenance.ts; these tests pin the
source, so a re-run of this migration cannot reintroduce either defect.
"""
from migrate_visit_logs_to_kin_care_reports import (
    convert,
    created_at_stamp,
    parse_legacy_stamp,
)


class TestParseLegacyStamp:
    def test_the_corpus_grammar(self):
        assert parse_legacy_stamp("September 3, 2025 2:02pm") == "2025-09-03T14:02:00Z"

    def test_am_is_left_alone(self):
        assert parse_legacy_stamp("March 31, 2026 10:16am") == "2026-03-31T10:16:00Z"

    def test_midnight_hour_is_zero_not_twelve(self):
        assert parse_legacy_stamp("March 24, 2026 12:29am") == "2026-03-24T00:29:00Z"

    def test_noon_hour_is_twelve_not_zero(self):
        assert parse_legacy_stamp("August 10, 2025 12:59pm") == "2025-08-10T12:59:00Z"

    def test_bare_hour_without_minutes(self):
        assert parse_legacy_stamp("March 31, 2026 4pm") == "2026-03-31T16:00:00Z"

    def test_surrounding_whitespace_tolerated(self):
        assert parse_legacy_stamp("  April 3, 2026 11:26pm  ") == "2026-04-03T23:26:00Z"

    def test_output_sorts_lexically_in_time_order(self):
        earlier = parse_legacy_stamp("September 3, 2025 2:02pm")
        later = parse_legacy_stamp("March 31, 2026 10:16am")
        # The whole point: the free text sorted 'M' before 'S'. The parse does not.
        assert "September 3, 2025 2:02pm" > "March 31, 2026 10:16am"
        assert earlier < later

    def test_impossible_calendar_day_refused_not_rolled_over(self):
        assert parse_legacy_stamp("February 30, 2026 1:00pm") is None

    def test_hour_zero_refused(self):
        assert parse_legacy_stamp("March 1, 2026 0:30am") is None

    def test_hour_thirteen_refused(self):
        assert parse_legacy_stamp("March 1, 2026 13:30pm") is None

    def test_minute_sixty_refused(self):
        assert parse_legacy_stamp("March 1, 2026 1:60pm") is None

    def test_abbreviated_month_refused(self):
        assert parse_legacy_stamp("Sep 3, 2025 2:02pm") is None

    def test_numeric_date_refused_because_it_is_ambiguous(self):
        # 03/09/2025 is two different days depending on who wrote it.
        assert parse_legacy_stamp("03/09/2025 2:02pm") is None

    def test_iso_input_refused(self):
        assert parse_legacy_stamp("2025-12-02T19:00:00.000Z") is None

    def test_blank_and_non_string(self):
        assert parse_legacy_stamp("") is None
        assert parse_legacy_stamp(None) is None
        assert parse_legacy_stamp(12345) is None

    def test_trailing_junk_refused(self):
        assert parse_legacy_stamp("September 3, 2025 2:02pm (approx)") is None


VL = {
    "journalId": "j1",
    "kinfolkId": "kf1",
    "serviceType": "Drop-in",
    "submitted": "September 3, 2025 2:02pm",
    "arrival": "12:03pm",
    "departure": "2:11pm",
    "auntieNotes": "All good.",
}


class TestCreatedAtStamp:
    def test_a_parsed_submit_stamp_is_the_original(self):
        assert created_at_stamp("2025-09-03T14:02:00Z", "2026-05-16T20:36:39Z") == (
            "2025-09-03T14:02:00Z", "original")

    def test_no_submit_stamp_falls_back_to_ingest_and_MARKS_it(self):
        # The whole point of the marker: this createdAt is the day the row was
        # imported, it is not a creation date, and a reader can tell.
        assert created_at_stamp(None, "2026-05-16T20:36:39Z") == (
            "2026-05-16T20:36:39Z", "import")

    def test_it_never_returns_live_because_an_imported_row_was_not_created_here(self):
        for submitted in ("2025-09-03T14:02:00Z", None, ""):
            assert created_at_stamp(submitted, "2026-05-16T20:36:39Z")[1] != "live"


class TestConvertCreatedAt:
    def test_created_at_is_the_ORIGINAL_creation_instant_not_the_ingest_date(self):
        # The operator's 2026-08-04 ruling, in one assertion. A report written in
        # September 2025 was created in September 2025.
        _, report, _ = convert("57", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert report["createdAt"] == "2025-09-03T14:02:00Z"
        assert report["createdAtSource"] == "original"

    def test_created_at_is_parsed_not_the_raw_free_text(self):
        # Unparsed, "September 3, 2025 2:02pm" sorts above every ISO row by
        # UTF-8 byte and among itself alphabetically by month name.
        _, report, _ = convert("57", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert report["createdAt"] != VL["submitted"]
        assert report["createdAt"] < "2025-12-02T19:00:00Z"

    def test_the_ingest_instant_keeps_its_own_field(self):
        # Nothing is lost by moving createdAt off it: _migratedAt is the field
        # that was always named for when the row entered this system.
        _, report, _ = convert("57", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert report["_migratedAt"] == "2026-05-16T20:36:39Z"
        assert report["createdAt"] != report["_migratedAt"]

    def test_the_human_submit_stamp_survives_parsed_and_sortable(self):
        _, report, _ = convert("57", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert report["_legacySubmittedAt"] == "2025-09-03T14:02:00Z"

    def test_unparseable_submit_stamp_is_MARKED_import_never_guessed(self):
        vl = dict(VL, submitted="sometime last Tuesday")
        _, report, _ = convert("57", vl, {"j1"}, "2026-05-16T20:36:39Z")
        assert report["_legacySubmittedAt"] == ""
        # It keeps a date that is TRUE (the day it was imported) and says so,
        # rather than passing the import date off as a creation date.
        assert report["createdAt"] == "2026-05-16T20:36:39Z"
        assert report["createdAtSource"] == "import"

    def test_the_human_original_is_still_on_the_row_verbatim(self):
        _, report, _ = convert("57", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert report["visitDate"] == "September 3, 2025 2:02pm"
        assert report["sentAt"] == "September 3, 2025 2:02pm"
        assert report["arrivedAt"] == "12:03pm"
        assert report["departedAt"] == "2:11pm"

    def test_one_ingest_instant_is_shared_across_a_run(self):
        _, a, _ = convert("1", VL, {"j1"}, "2026-05-16T20:36:39Z")
        _, b, _ = convert("2", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert a["_migratedAt"] == b["_migratedAt"]

    def test_two_rows_from_different_days_no_longer_share_a_created_at(self):
        # The F7 redate collapsed all 83 rows onto one instant, which made their
        # true sequence unreadable by any query. Recovering the original restores
        # it.
        _, a, _ = convert("1", VL, {"j1"}, "2026-05-16T20:36:39Z")
        _, b, _ = convert("2", dict(VL, submitted="March 31, 2026 10:16am"), {"j1"},
                          "2026-05-16T20:36:39Z")
        assert a["createdAt"] < b["createdAt"]

    def test_orphan_tagging_is_unchanged(self):
        doc_id, report, is_orphan = convert("79", VL, set(), "2026-05-16T20:36:39Z")
        assert doc_id == "legacy_79"
        assert is_orphan is True
        assert report["sessionId"] == ""
        assert report["sentVia"] == "legacy_orphan"

    def test_matched_row_keeps_its_session(self):
        _, report, is_orphan = convert("57", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert is_orphan is False
        assert report["sessionId"] == "j1"
        assert report["sentVia"] == "legacy_visit_logs"
