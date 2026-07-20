"""Baserow auth helper for Auntie OS.

Loads creds from .env at the project root, hands back valid auth headers,
and transparently refreshes the JWT when it expires.

Priority when getting a fresh access token:
  1. Cached access_token in .env (if not expired) — used directly.
  2. Refresh token (if access token expired but refresh still valid) —
     calls /api/user/token-refresh/, caches the new access token.
  3. Email + password login (if refresh token also expired) —
     calls /api/user/token-auth/, caches BOTH tokens.

Usage:
    from baserow_auth import BaserowClient
    bw = BaserowClient()                       # loads .env
    bw.get("/database/rows/table/630/?user_field_names=true&size=1")
    bw.post_jwt("/database/tables/database/201/", {"name": "new_table"})
    bw.post_token("/database/rows/table/622/batch/?user_field_names=true",
                  {"items": [...]})

Two header modes:
  - Token header (BASEROW_TOKEN): row CRUD only.
  - JWT header (auto-refreshed): schema ops and everything else.
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent
ENV_PATH = PROJECT_ROOT / ".env"

# 60s safety window — refresh if the JWT is within 60s of expiry.
JWT_EXPIRY_GRACE = 60


def _load_env(path: Path = ENV_PATH) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()
    return env


def _write_env(updates: dict[str, str], path: Path = ENV_PATH) -> None:
    """Update keys in-place, preserving comments, blank lines, and order.
    Appends any keys that weren't in the file."""
    lines = path.read_text().splitlines() if path.exists() else []
    remaining = dict(updates)
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            out.append(line)
            continue
        k = stripped.split("=", 1)[0].strip()
        if k in remaining:
            out.append(f"{k}={remaining.pop(k)}")
        else:
            out.append(line)
    for k, v in remaining.items():
        out.append(f"{k}={v}")
    path.write_text("\n".join(out) + "\n")


def _jwt_exp(jwt: str) -> int | None:
    """Extract `exp` (unix seconds) from a JWT payload, or None on failure."""
    try:
        payload_b64 = jwt.split(".")[1]
        # urlsafe base64 needs padding
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
        return int(payload.get("exp")) if "exp" in payload else None
    except Exception:
        return None


def _jwt_is_valid(jwt: str | None, grace: int = JWT_EXPIRY_GRACE) -> bool:
    if not jwt:
        return False
    exp = _jwt_exp(jwt)
    if exp is None:
        return False
    return exp - int(time.time()) > grace


class BaserowAuthError(RuntimeError):
    pass


class BaserowClient:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        self.env = env if env is not None else _load_env()
        self.base_url = self.env.get("BASEROW_URL", "http://localhost:51001").rstrip("/")
        self.api = self.base_url + "/api"
        self.db_token = self.env.get("BASEROW_TOKEN", "")
        self._jwt = self.env.get("BASEROW_JWT", "")
        self._refresh = self.env.get("BASEROW_REFRESH", "")

    # ---- public API ----------------------------------------------------
    def token_headers(self) -> dict[str, str]:
        if not self.db_token:
            raise BaserowAuthError("BASEROW_TOKEN missing from .env")
        return {
            "Authorization": f"Token {self.db_token}",
            "Content-Type": "application/json",
        }

    def jwt_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"JWT {self._ensure_jwt()}",
            "Content-Type": "application/json",
        }

    def get(self, path: str, *, jwt: bool = False) -> Any:
        return self._request("GET", path, None, jwt=jwt)

    def post_token(self, path: str, body: Any) -> Any:
        return self._request("POST", path, body, jwt=False)

    def post_jwt(self, path: str, body: Any) -> Any:
        return self._request("POST", path, body, jwt=True)

    def patch_jwt(self, path: str, body: Any) -> Any:
        return self._request("PATCH", path, body, jwt=True)

    def delete_jwt(self, path: str) -> Any:
        return self._request("DELETE", path, None, jwt=True)

    def delete_token(self, path: str) -> Any:
        return self._request("DELETE", path, None, jwt=False)

    # ---- internals -----------------------------------------------------
    def _request(self, method: str, path: str, body: Any, *, jwt: bool) -> Any:
        url = self.api + path if path.startswith("/") else f"{self.api}/{path}"
        headers = self.jwt_headers() if jwt else self.token_headers()
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read()
                if not raw:
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            # If JWT path and we got 401, try refreshing once and retry.
            if jwt and e.code == 401:
                self._jwt = ""  # force refresh
                headers = self.jwt_headers()
                req = urllib.request.Request(url, data=data, method=method, headers=headers)
                with urllib.request.urlopen(req) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else None
            # Bubble up with body for easier debugging.
            body_txt = e.read().decode(errors="replace") if hasattr(e, "read") else ""
            raise BaserowAuthError(f"HTTP {e.code} {method} {path}: {body_txt}") from e

    def _ensure_jwt(self) -> str:
        if _jwt_is_valid(self._jwt):
            return self._jwt
        # Try refresh token first.
        if self._refresh:
            try:
                self._jwt = self._do_refresh(self._refresh)
                _write_env({"BASEROW_JWT": self._jwt})
                return self._jwt
            except BaserowAuthError:
                pass  # fall through to password login
        # Full login.
        access, refresh = self._do_login()
        self._jwt = access
        self._refresh = refresh
        _write_env({"BASEROW_JWT": access, "BASEROW_REFRESH": refresh})
        return self._jwt

    def _do_refresh(self, refresh_token: str) -> str:
        url = self.api + "/user/token-refresh/"
        req = urllib.request.Request(
            url,
            data=json.dumps({"refresh_token": refresh_token}).encode(),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req) as resp:
                payload = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body_txt = e.read().decode(errors="replace") if hasattr(e, "read") else ""
            raise BaserowAuthError(f"token-refresh failed: HTTP {e.code} {body_txt}") from e
        access = payload.get("access_token") or payload.get("token")
        if not access:
            raise BaserowAuthError(f"token-refresh missing access_token: {payload}")
        return access

    def _do_login(self) -> tuple[str, str]:
        email = self.env.get("BASEROW_EMAIL", "")
        password = self.env.get("BASEROW_PASSWORD", "")
        if not email or not password:
            raise BaserowAuthError(
                "Cannot refresh JWT: BASEROW_EMAIL/BASEROW_PASSWORD not set in .env, "
                "and the refresh token is also expired/invalid. "
                "Either paste a fresh BASEROW_JWT and BASEROW_REFRESH into .env, "
                "or fill in BASEROW_PASSWORD."
            )
        url = self.api + "/user/token-auth/"
        req = urllib.request.Request(
            url,
            data=json.dumps({"email": email, "password": password}).encode(),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req) as resp:
                payload = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body_txt = e.read().decode(errors="replace") if hasattr(e, "read") else ""
            raise BaserowAuthError(f"token-auth failed: HTTP {e.code} {body_txt}") from e
        access = payload.get("access_token") or payload.get("token")
        refresh = payload.get("refresh_token")
        if not access or not refresh:
            raise BaserowAuthError(f"token-auth missing tokens: {list(payload.keys())}")
        return access, refresh


if __name__ == "__main__":
    # Quick self-test: hit something JWT-only and something token-only.
    bw = BaserowClient()
    print(f"Base URL: {bw.base_url}")
    print(f"DB token: {'set' if bw.db_token else 'MISSING'}")
    print(f"Cached JWT valid: {_jwt_is_valid(bw._jwt)}")

    # Token path
    r = bw.get("/database/rows/table/622/?user_field_names=true&size=1")
    print(f"kinfolk row count (token auth): {r['count']}")

    # JWT path
    fields = bw.get("/database/fields/table/629/", jwt=True)
    print(f"kin field count (jwt auth): {len(fields)}")

    print(f"Cached JWT valid after call: {_jwt_is_valid(bw._jwt)}")
