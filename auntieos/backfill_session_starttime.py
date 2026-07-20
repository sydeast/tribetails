"""Backfill kin_care_sessions.startTime (ISO) from the legacy human-readable dates.

Root cause (verified 2026-06-01): the Baserow->Firestore migration never populated
`startTime`, so every date-scoped web view (Auntie Time / Schedule / Bookings History /
Home "Today's Pack") keys off an empty string and renders nothing. The real visit date
lives as a human string in `submitted`, `completedAt`, or the leading "Month D, YYYY" of
`kinCareDescription`.

This pass parses that human date into an ISO `startTime` (naive local, "YYYY-MM-DDTHH:MM:00")
so the existing `startTime.take(10)` date keys light up. It is idempotent (skips docs that
already have a non-blank startTime), reversible (writes `_startTimeBackfill` = source field +
`_startTimeBackfillAt`), and never touches `_demo:true` docs.

  Dry run (default):   python3 backfill_session_starttime.py
  Commit to prod:      GCLOUD_PROJECT=auntieos-ttpc python3 backfill_session_starttime.py --allow-prod

Source-field precedence: submitted -> completedAt -> kinCareDescription(leading date) -> createdAt.
A date with no parseable time defaults to 12:00 (noon) so it sorts mid-day, not midnight.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT    = Path(__file__).resolve().parent
SERVICE_ACCOUNT = PROJECT_ROOT.parent / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"
EXPECTED_PROJECT = "auntieos-ttpc"

MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}

# "December 14, 2025 9:59pm"  |  "August 6, 2025 6:38pm"  |  "February 17, 2026"
#  optional leading junk, optional trailing time. Captures month/day/year + optional h/m/ampm.
DATE_RE = re.compile(
    r"(?P<mon>[A-Za-z]+)\s+(?P<day>\d{1,2}),\s+(?P<year>\d{4})"
    r"(?:[^\d]{0,4}(?P<h>\d{1,2}):(?P<m>\d{2})\s*(?P<ap>[ap]m))?",
    re.IGNORECASE,
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_human_date(s: str) -> str | None:
    """Parse a human date(time) into naive-local ISO 'YYYY-MM-DDTHH:MM:00', or None."""
    if not s:
        return None
    m = DATE_RE.search(s)
    if not m:
        return None
    mon = MONTHS.get(m.group("mon").lower())
    if not mon:
        return None
    day = int(m.group("day"))
    year = int(m.group("year"))
    if not (1 <= day <= 31 and 2000 <= year <= 2100):
        return None
    hour, minute = 12, 0  # default noon when no time component
    if m.group("h"):
        hour = int(m.group("h")) % 12
        if m.group("ap").lower() == "pm":
            hour += 12
        minute = int(m.group("m"))
    try:
        # Validate the calendar date (rejects e.g. Feb 30) without imposing a tz.
        datetime(year, mon, day, hour, minute)
    except ValueError:
        return None
    return f"{year:04d}-{mon:02d}-{day:02d}T{hour:02d}:{minute:02d}:00"


def derive_start_time(d: dict) -> tuple[str | None, str | None]:
    """Returns (iso, source_field) using the precedence order, or (None, None)."""
    for field in ("submitted", "completedAt", "kinCareDescription", "createdAt"):
        raw = d.get(field)
        if isinstance(raw, str) and raw.strip():
            iso = parse_human_date(raw)
            if iso:
                return iso, field
    return None, None


def init_firebase(allow_prod: bool):
    if not allow_prod and not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        # Dry run can still read prod (ADC) but we prefer explicit. Allow read-only via SA.
        pass
    if allow_prod and os.environ.get("GCLOUD_PROJECT") != EXPECTED_PROJECT:
        sys.exit(f"[startTime] Refusing prod write: GCLOUD_PROJECT != '{EXPECTED_PROJECT}'.")
    if not SERVICE_ACCOUNT.exists():
        sys.exit(f"[startTime] Service account not found: {SERVICE_ACCOUNT}")
    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-prod", action="store_true", help="commit writes to prod")
    ap.add_argument("--limit", type=int, default=0, help="cap docs processed (0 = all)")
    args = ap.parse_args()
    dry = not args.allow_prod

    db = init_firebase(args.allow_prod)
    now = utc_now_iso()

    total = blank = already = demo = parsed = unparsed = 0
    by_source: dict[str, int] = {}
    samples: list[str] = []
    unparsed_samples: list[str] = []

    for doc in db.collection("kin_care_sessions").stream():
        total += 1
        d = doc.to_dict() or {}
        if (d.get("startTime") or "").strip():
            already += 1
            continue
        if d.get("_demo") is True:
            demo += 1
            continue
        blank += 1
        iso, src = derive_start_time(d)
        if not iso:
            unparsed += 1
            if len(unparsed_samples) < 8:
                unparsed_samples.append(
                    f"  {doc.id}: submitted={d.get('submitted')!r} completedAt={d.get('completedAt')!r} desc={str(d.get('kinCareDescription'))[:40]!r}"
                )
            continue
        parsed += 1
        by_source[src] = by_source.get(src, 0) + 1
        if len(samples) < 12:
            samples.append(f"  {doc.id}: {src}={d.get(src)!r} -> startTime={iso}")
        if not dry:
            doc.reference.update({
                "startTime": iso,
                "_startTimeBackfill": src,
                "_startTimeBackfillAt": now,
            })
        if args.limit and parsed >= args.limit:
            break

    mode = "DRY RUN (no writes)" if dry else "PROD WRITE COMMITTED"
    print(f"\n[startTime] {mode}")
    print(f"  total sessions scanned : {total}")
    print(f"  already had startTime  : {already}")
    print(f"  _demo (skipped)        : {demo}")
    print(f"  blank startTime        : {blank}")
    print(f"    -> parsed (would set): {parsed}")
    print(f"    -> UNPARSED (skipped): {unparsed}")
    print(f"  parsed by source field : {by_source}")
    print("\n  sample mappings:")
    print("\n".join(samples) if samples else "    (none)")
    if unparsed_samples:
        print("\n  UNPARSED samples (left blank, fail-loud):")
        print("\n".join(unparsed_samples))
    if dry:
        print("\n[startTime] Dry run only. Re-run with --allow-prod (and GCLOUD_PROJECT=auntieos-ttpc) to commit.")


if __name__ == "__main__":
    main()
