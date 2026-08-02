"""Unit tests for the visit_logs -> kin_care_reports migration helpers.

Covers punchlist F7's source fix: `createdAt` must be the INGEST instant, never
`visit_logs.submitted` free text, so that a re-run of this migration cannot
reintroduce the two-format defect that
mytribe/scripts/backfillKinTaleCreatedAt.ts exists to repair.
"""
from migrate_visit_logs_to_kin_care_reports import convert, parse_legacy_stamp


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


class TestConvertCreatedAt:
    def test_created_at_is_the_ingest_instant_not_the_submit_text(self):
        _, report, _ = convert("57", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert report["createdAt"] == "2026-05-16T20:36:39Z"
        assert report["createdAt"] != VL["submitted"]

    def test_created_at_equals_migrated_at_by_construction(self):
        _, report, _ = convert("57", VL, {"j1"}, "2026-05-16T20:36:39Z")
        # The redate migration reads _migratedAt to repair old rows. If a re-run
        # of THIS script disagreed with itself, that repair would have no anchor.
        assert report["createdAt"] == report["_migratedAt"]

    def test_the_human_submit_stamp_survives_parsed_and_sortable(self):
        _, report, _ = convert("57", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert report["_legacySubmittedAt"] == "2025-09-03T14:02:00Z"

    def test_unparseable_submit_stamp_leaves_it_blank_never_guessed(self):
        vl = dict(VL, submitted="sometime last Tuesday")
        _, report, _ = convert("57", vl, {"j1"}, "2026-05-16T20:36:39Z")
        assert report["_legacySubmittedAt"] == ""
        # And createdAt is still the ingest instant: the two are independent.
        assert report["createdAt"] == "2026-05-16T20:36:39Z"

    def test_the_human_original_is_still_on_the_row_verbatim(self):
        _, report, _ = convert("57", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert report["visitDate"] == "September 3, 2025 2:02pm"
        assert report["sentAt"] == "September 3, 2025 2:02pm"
        assert report["arrivedAt"] == "12:03pm"
        assert report["departedAt"] == "2:11pm"

    def test_one_ingest_instant_is_shared_across_a_run(self):
        _, a, _ = convert("1", VL, {"j1"}, "2026-05-16T20:36:39Z")
        _, b, _ = convert("2", VL, {"j1"}, "2026-05-16T20:36:39Z")
        assert a["createdAt"] == b["createdAt"]

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
