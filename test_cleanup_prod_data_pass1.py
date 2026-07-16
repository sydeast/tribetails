"""Unit tests for cleanup_prod_data_pass1 helpers."""
import pytest
from cleanup_prod_data_pass1 import derive_status, needs_nan_scrub, normalize_iso_zulu


class TestDeriveStatus:
    def test_existing_valid_status_returns_none(self):
        assert derive_status({"status": "COMPLETED"}) is None

    def test_existing_cancelled_preserved(self):
        assert derive_status({"status": "CANCELLED", "completedAt": "2026-01-01T00:00:00Z"}) is None

    def test_completed_at_implies_completed(self):
        assert derive_status({"completedAt": "2026-04-16T14:00:00Z"}) == "COMPLETED"

    def test_submitted_true_implies_completed(self):
        assert derive_status({"submitted": True}) == "COMPLETED"

    def test_status_sent_implies_completed(self):
        assert derive_status({"statusSent": "Sent"}) == "COMPLETED"

    def test_no_signals_defaults_scheduled(self):
        assert derive_status({}) == "SCHEDULED"

    def test_blank_status_field_treated_as_missing(self):
        assert derive_status({"status": "", "submitted": True}) == "COMPLETED"

    def test_invalid_status_string_treated_as_missing(self):
        assert derive_status({"status": "WHATEVER"}) == "SCHEDULED"


class TestNeedsNanScrub:
    def test_literal_nan_string(self):
        assert needs_nan_scrub({"internalNotes": "NaN"}) is True

    def test_nan_with_whitespace(self):
        assert needs_nan_scrub({"internalNotes": "  NaN  "}) is True

    def test_normal_note_no_scrub(self):
        assert needs_nan_scrub({"internalNotes": "Real note"}) is False

    def test_empty_no_scrub(self):
        assert needs_nan_scrub({"internalNotes": ""}) is False

    def test_missing_field_no_scrub(self):
        assert needs_nan_scrub({}) is False


class TestNormalizeIsoZulu:
    def test_already_zulu_returns_none(self):
        assert normalize_iso_zulu("2026-04-16T13:34:00Z") is None

    def test_local_naive_converts(self):
        assert normalize_iso_zulu("2026-04-16 13:34") == "2026-04-16T13:34:00Z"

    def test_unparseable_returns_none(self):
        assert normalize_iso_zulu("yesterday") is None

    def test_non_string_returns_none(self):
        assert normalize_iso_zulu(None) is None
        assert normalize_iso_zulu(12345) is None
