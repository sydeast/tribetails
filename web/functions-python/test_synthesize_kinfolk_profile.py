"""Tests for the synthesize_kinfolk_profile on-demand callable.

Exercises the _synthesize helper directly (the callable delegates to it) so we
can inject a fake CallableRequest without going through the Firebase HTTP layer.

Happy path, sad paths (non-admin, missing/blank kinfolkId), and negative path
(admin=False in token) all verified; reconcile_pass is monkeypatched so no
Firestore or Claude calls happen.

Run:
    ./venv/bin/python -m pytest test_synthesize_kinfolk_profile.py -v
"""
from __future__ import annotations

import pytest
from unittest.mock import patch, MagicMock

from firebase_functions.https_fn import (
    AuthData,
    CallableRequest,
    HttpsError,
    FunctionsErrorCode,
)

# We import the helper directly.  It is NOT the decorated callable (that wraps
# the function in HTTP routing); it is the plain Python function that holds all
# the logic, making it straightforward to call in tests without a Flask app.
from main import _synthesize


# ---------- minimal fake CallableRequest helpers ----------

def _make_req(data: dict, auth: AuthData | None) -> CallableRequest:
    """Build the smallest valid CallableRequest for the handler under test."""
    return CallableRequest(
        data=data,
        raw_request=MagicMock(),  # not inspected by _synthesize
        auth=auth,
    )


def _admin_auth(uid: str = "admin-uid", admin: bool = True) -> AuthData:
    token: dict = {"uid": uid}
    if admin:
        token["admin"] = True
    return AuthData(uid=uid, token=token)


# ---------- fake db (not inspected — reconcile_pass is patched) ----------

FAKE_DB = MagicMock()


# ---------- auth / permission tests ----------

def test_no_auth_raises_permission_denied():
    req = _make_req({"kinfolkId": "kf1"}, auth=None)
    with patch("reconcile_comms.reconcile_pass") as mock_pass:
        with pytest.raises(HttpsError) as exc_info:
            _synthesize(req, FAKE_DB)
        assert exc_info.value.code == FunctionsErrorCode.PERMISSION_DENIED
        mock_pass.assert_not_called()


def test_non_admin_token_raises_permission_denied():
    req = _make_req({"kinfolkId": "kf1"}, auth=_admin_auth(admin=False))
    with patch("reconcile_comms.reconcile_pass") as mock_pass:
        with pytest.raises(HttpsError) as exc_info:
            _synthesize(req, FAKE_DB)
        assert exc_info.value.code == FunctionsErrorCode.PERMISSION_DENIED
        mock_pass.assert_not_called()


def test_admin_false_explicit_raises_permission_denied():
    """Explicit admin=False in token (not just absent) must also be denied."""
    auth = AuthData(uid="u1", token={"uid": "u1", "admin": False})
    req = _make_req({"kinfolkId": "kf1"}, auth=auth)
    with patch("reconcile_comms.reconcile_pass") as mock_pass:
        with pytest.raises(HttpsError) as exc_info:
            _synthesize(req, FAKE_DB)
        assert exc_info.value.code == FunctionsErrorCode.PERMISSION_DENIED
        mock_pass.assert_not_called()


# ---------- validation tests ----------

def test_missing_kinfolk_id_raises_invalid_argument():
    req = _make_req({}, auth=_admin_auth())
    with patch("reconcile_comms.reconcile_pass") as mock_pass:
        with pytest.raises(HttpsError) as exc_info:
            _synthesize(req, FAKE_DB)
        assert exc_info.value.code == FunctionsErrorCode.INVALID_ARGUMENT
        mock_pass.assert_not_called()


def test_blank_kinfolk_id_raises_invalid_argument():
    req = _make_req({"kinfolkId": "   "}, auth=_admin_auth())
    with patch("reconcile_comms.reconcile_pass") as mock_pass:
        with pytest.raises(HttpsError) as exc_info:
            _synthesize(req, FAKE_DB)
        assert exc_info.value.code == FunctionsErrorCode.INVALID_ARGUMENT
        mock_pass.assert_not_called()


def test_none_kinfolk_id_raises_invalid_argument():
    req = _make_req({"kinfolkId": None}, auth=_admin_auth())
    with patch("reconcile_comms.reconcile_pass") as mock_pass:
        with pytest.raises(HttpsError) as exc_info:
            _synthesize(req, FAKE_DB)
        assert exc_info.value.code == FunctionsErrorCode.INVALID_ARGUMENT
        mock_pass.assert_not_called()


# ---------- happy path ----------

def test_happy_path_calls_reconcile_pass_and_returns_result():
    req = _make_req({"kinfolkId": "kf-abc"}, auth=_admin_auth())
    with patch("reconcile_comms.reconcile_pass", return_value=3) as mock_pass:
        result = _synthesize(req, FAKE_DB)

    # reconcile_pass called exactly once with the right args
    mock_pass.assert_called_once_with(
        FAKE_DB,
        max_per_run=500,
        kinfolk_id_filter="kf-abc",
        dry_run=False,
    )
    assert result == {"processed": 3, "kinfolkId": "kf-abc"}


def test_happy_path_strips_whitespace_from_kinfolk_id():
    """kinfolkId with surrounding whitespace is accepted and stripped."""
    req = _make_req({"kinfolkId": "  kf-xyz  "}, auth=_admin_auth())
    with patch("reconcile_comms.reconcile_pass", return_value=1) as mock_pass:
        result = _synthesize(req, FAKE_DB)

    mock_pass.assert_called_once_with(
        FAKE_DB,
        max_per_run=500,
        kinfolk_id_filter="kf-xyz",
        dry_run=False,
    )
    assert result["kinfolkId"] == "kf-xyz"


def test_happy_path_zero_processed_is_valid():
    """reconcile_pass returning 0 (kinfolk had nothing pending) is valid — not an error."""
    req = _make_req({"kinfolkId": "kf-none"}, auth=_admin_auth())
    with patch("reconcile_comms.reconcile_pass", return_value=0) as mock_pass:
        result = _synthesize(req, FAKE_DB)

    assert result == {"processed": 0, "kinfolkId": "kf-none"}
    mock_pass.assert_called_once()
