"""Migrate legacy visit_logs → canonical kin_care_reports.

Reads every doc in visit_logs, converts to KinCareReport shape, writes to
kin_care_reports w/ deterministic doc ID = "legacy_{visit_log.id}" so re-runs
are idempotent (Firestore .set() overwrites by ID).

Orphans (visit_logs whose journalId does NOT match any kin_care_sessions doc)
are STILL migrated, but tagged sentVia="legacy_orphan" with sessionId="" so
admin UI can fail-loud surface them. Per fail-loud policy: do not silently
drop docs.

createdAt is the ORIGINAL creation instant, recovered from visit_logs.submitted,
and it is never the ingest date. Per the operator's ruling of 2026-08-04:

    "createdAt is incorrect when we migrated historical data. the old data's
     actual createdAt should be its original creation as in from the old system
     not the date that it was migrated"

This field has now been wrong in two different directions and both are worth
naming, because the second was a deliberate fix that overshot.

  1. It was the RAW free text, "September 3, 2025 2:02pm". Firestore orders
     strings by UTF-8 byte, so letters beat digits: the whole imported block
     sorted above every real row, and among itself ALPHABETICALLY BY MONTH NAME.
  2. Punchlist F7 (2026-08-01) fixed the sort by writing the INGEST instant
     instead. Sortable, and a lie about every one of the 83 rows: each claimed
     to have been created the day it was imported.

Both are fixed by the same move. `submitted` is PARSED to a real ISO instant, so
it sorts correctly, and it is written where it belongs. The ingest instant keeps
_migratedAt, the field that was always named for it, so nothing is lost.

createdAtSource says which of the two `createdAt` actually is, and it is what
stops "imported that day" and "created that day" from being the same bytes. It
is "original" when `submitted` parsed, "import" when it did not. Nothing is ever
guessed: a row with neither is refused, not stamped with now.

The repair for rows already in production is
mytribe/scripts/backfillKinTaleCreatedAtProvenance.ts. This file is the source
fix, so a re-run of the migration cannot put either defect back.

Refuses prod write without --allow-prod AND explicit GCLOUD_PROJECT env var.
Pattern matches MyTribe/scripts/seedNotificationTemplates.ts gate.

Run:
    # dry-run (no writes, prints diff plan)
    python3 migrate_visit_logs_to_kin_care_reports.py --dry-run

    # prod write (requires both flags)
    GCLOUD_PROJECT=auntieos-ttpc python3 migrate_visit_logs_to_kin_care_reports.py --allow-prod
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

MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"]

# The one grammar visit_logs.submitted uses: "September 3, 2025 2:02pm".
# All 83 rows this script produced in May 2026 match it exactly. Minutes are
# optional because the sibling arrival/departure fields use the bare-hour form.
_LEGACY_STAMP = re.compile(
    r"^(" + "|".join(MONTHS) + r") (\d{1,2}), (\d{4}) (\d{1,2})(?::(\d{2}))?(am|pm)$"
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_legacy_stamp(raw: str) -> str | None:
    """'September 3, 2025 2:02pm' -> '2025-09-03T14:02:00Z', else None.

    Deliberately narrow and anchored. A full English month name with a 4-digit
    year cannot be ambiguous the way '03/09/2025' is, which is the only reason
    parsing this text is defensible. Anything else returns None and is reported;
    it is never coerced by a permissive parser.

    The source records NO timezone, so none can be recovered. The wall clock is
    rendered as Zulu, the convention this corpus already accepted
    (cleanup_prod_data_pass1.normalize_iso_zulu: "Treats naive local timestamps
    as Zulu"). Every stamp shifts by the same unknown offset, so the ORDER this
    field exists to carry is exact even though the instant is approximate.
    """
    if not isinstance(raw, str):
        return None
    m = _LEGACY_STAMP.match(raw.strip())
    if not m:
        return None
    month = MONTHS.index(m.group(1)) + 1
    day, year = int(m.group(2)), int(m.group(3))
    raw_hour = int(m.group(4))
    minute = int(m.group(5)) if m.group(5) else 0
    if not 1 <= raw_hour <= 12 or minute > 59:
        return None
    hour = (raw_hour % 12) + (12 if m.group(6) == "pm" else 0)
    try:
        # Rejects "February 30, 2026" rather than rolling it into March.
        dt = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
    except ValueError:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def init_firebase(allow_prod: bool):
    if not allow_prod and not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.exit("[migrate] Refusing to run: no --allow-prod and no FIRESTORE_EMULATOR_HOST set.")
    if allow_prod:
        proj = os.environ.get("GCLOUD_PROJECT", "")
        if proj != EXPECTED_PROJECT:
            sys.exit(f"[migrate] Refusing prod write: GCLOUD_PROJECT='{proj}' != expected '{EXPECTED_PROJECT}'. "
                     f"Set explicitly: GCLOUD_PROJECT={EXPECTED_PROJECT}")
    if not SERVICE_ACCOUNT.exists():
        sys.exit(f"[migrate] Service account JSON not found at {SERVICE_ACCOUNT}.")
    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


def first_nonblank(*vals: str) -> str:
    for v in vals:
        if v and v.strip():
            return v
    return ""


def created_at_stamp(submitted_iso: str | None, ingest: str) -> tuple[str, str]:
    """Returns (createdAt, createdAtSource) for one imported row.

    THE WRITE PATH FOR THIS IMPORT, in one place, so the field and the marker
    that says whether to believe it cannot be written apart from each other.
    Mirrors `resolveMigratedCreatedAt` in mytribe/scripts/createdAtProvenance.ts,
    which is the same contract for the TypeScript side.

    A parsed submit stamp is the row's real creation instant -> "original".
    Nothing parsed means the source recorded no date this script can read, so
    createdAt falls back to the ingest instant and is MARKED "import": it is a
    true fact about the row, it is not a creation date, and a reader can tell.
    """
    if submitted_iso:
        return submitted_iso, "original"
    return ingest, "import"


def convert(visit_log_id: str, vl: dict, session_ids: set[str],
            ingested_at: str | None = None) -> tuple[str, dict, bool]:
    """Returns (new_doc_id, kin_care_report_dict, is_orphan).

    `ingested_at` is the ONE ingest instant for the whole run, so every row this
    pass produces shares a single `_migratedAt` rather than drifting by however
    long the loop took. Defaults to now for callers that do not care.
    """
    journal_id = vl.get("journalId", "")
    is_orphan  = journal_id not in session_ids
    timestamp  = first_nonblank(vl.get("submitted", ""), vl.get("arrival", ""), vl.get("departure", ""))
    new_doc_id = f"legacy_{visit_log_id}"
    ingest     = ingested_at or utc_now_iso()
    submitted  = parse_legacy_stamp(vl.get("submitted", ""))
    created_at, created_at_source = created_at_stamp(submitted, ingest)
    report = {
        "sessionId":         "" if is_orphan else journal_id,
        "kinfolkId":         vl.get("kinfolkId", ""),
        "kinfolkName":       "",  # journalId is FK, not name
        "kinIds":            [],
        "serviceType":       vl.get("serviceType", ""),
        # visitDate / sentAt / arrivedAt / departedAt stay EXACTLY as the source
        # recorded them, deliberately. They are the human original, and nothing
        # here can improve them without inventing information: the visit date
        # cannot be derived from a submit stamp (see `_legacySubmittedAt` below),
        # and arrival/departure are bare clock times carrying no date at all
        # ("8:37pm"), several of which run backwards across midnight. Free text
        # that is honestly free text is not the defect this file had.
        "visitDate":         timestamp,
        "arrivedAt":         vl.get("arrival", ""),
        "departedAt":        vl.get("departure", ""),
        "visitRouteId":      "",
        "templateId":        "",
        "bodyCopy":          vl.get("auntieNotes", ""),
        "fieldResponses":    {},
        "petMoodSelections": {},
        "mediaFileIds":      [],
        "status":            "SENT",
        "sentAt":            timestamp,
        "sentVia":           "legacy_orphan" if is_orphan else "legacy_visit_logs",
        "deliveryReceiptId": vl.get("rawStagingRef", ""),
        # THE ORIGINAL CREATION INSTANT, parsed from visit_logs.submitted.
        #
        # Per the operator's 2026-08-04 ruling: a report written in September
        # 2025 was created in September 2025, whatever day this script happened
        # to run. `_migratedAt` below carries the ingest instant, so both facts
        # are on the row, in fields named for what they are.
        #
        # PARSED, not the raw text. The raw form is "September 3, 2025 2:02pm",
        # and Firestore orders strings by UTF-8 byte, so letters beat digits:
        # writing it unparsed sorted every imported row above every ISO row in a
        # `createdAt desc` query, and sorted them among themselves ALPHABETICALLY
        # BY MONTH NAME. `parse_legacy_stamp` is what makes this both true and
        # sortable, and it refuses anything it cannot read rather than coercing
        # it.
        #
        # `createdAtSource` travels with it, always. See `created_at_stamp`.
        "createdAt":         created_at,
        "createdAtSource":   created_at_source,
        "updatedAt":         ingest,
        # The human submit stamp, rendered sortable. It is NOT written into
        # `visitDate`: measured against the live corpus, 18 of the 83 rows record
        # an `arrivedAt` clock time LATER in the day than the submit time, so the
        # visit demonstrably began on the previous calendar day and this stamp is
        # a submit time, not a visit date. It is kept under a name that says so,
        # where it carries no claim it cannot support. Blank when the text does
        # not match the one known grammar; nothing is guessed.
        "_legacySubmittedAt": submitted or "",
        # provenance — separate from deliveryReceiptId for clarity
        "_migratedFrom":     f"visit_logs/{visit_log_id}",
        "_migratedAt":       ingest,
    }
    return new_doc_id, report, is_orphan


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="no writes; print plan only")
    ap.add_argument("--allow-prod", action="store_true", help="required for prod write")
    args = ap.parse_args()

    db = init_firebase(args.allow_prod)

    # 1. Load all session IDs (FK target set)
    print("[migrate] Loading kin_care_sessions IDs ...")
    session_ids = {doc.id for doc in db.collection("kin_care_sessions").stream()}
    print(f"[migrate]   {len(session_ids)} sessions")

    # 2. Pre-flight: count existing kin_care_reports — must be 0 for clean migration
    existing = list(db.collection("kin_care_reports").limit(1).stream())
    if existing and not args.dry_run:
        sys.exit("[migrate] kin_care_reports is NOT empty. Aborting. Inspect first; re-run only if intentional overwrite.")

    # 3. Stream visit_logs
    print("[migrate] Streaming visit_logs ...")
    visit_logs = list(db.collection("visit_logs").stream())
    print(f"[migrate]   {len(visit_logs)} visit_logs")

    matched = 0
    orphans = []
    unparsed = []
    # ONE ingest instant for the whole run, so every row shares a createdAt
    # rather than drifting by however long the loop took.
    ingested_at = utc_now_iso()
    write_batch = db.batch() if not args.dry_run else None
    batch_count = 0

    for snap in visit_logs:
        vl = snap.to_dict()
        new_id, report, is_orphan = convert(snap.id, vl, session_ids, ingested_at)
        if is_orphan:
            orphans.append((snap.id, vl.get("journalId", "")))
        else:
            matched += 1
        if not report["_legacySubmittedAt"]:
            unparsed.append((snap.id, vl.get("submitted", "")))
        if args.dry_run:
            tag = "ORPHAN" if is_orphan else "MATCH"
            print(f"  [{tag}] visit_logs/{snap.id} -> kin_care_reports/{new_id} (sessionId='{report['sessionId']}')")
        else:
            ref = db.collection("kin_care_reports").document(new_id)
            write_batch.set(ref, report)
            batch_count += 1
            if batch_count >= 400:
                write_batch.commit()
                write_batch = db.batch()
                batch_count = 0
    if write_batch is not None and batch_count > 0:
        write_batch.commit()

    print()
    print(f"[migrate] FINAL: total={len(visit_logs)} matched={matched} orphans={len(orphans)} "
          f"created_at_original={len(visit_logs) - len(unparsed)} "
          f"created_at_import={len(unparsed)} ingest={ingested_at} "
          f"mode={'DRY' if args.dry_run else 'WRITE'}")
    if unparsed:
        print("[migrate] Submit stamps that did NOT match the known grammar. These rows carry "
              "createdAtSource='import': their createdAt is the ingest instant, NOT a creation "
              "date, and _legacySubmittedAt is left blank. Nothing was guessed:")
        for vid, raw in unparsed:
            print(f"  visit_logs/{vid}  submitted='{raw}'")
    if orphans:
        print("[migrate] Orphans (journalId not in kin_care_sessions):")
        for vid, jid in orphans:
            print(f"  visit_logs/{vid}  journalId='{jid}'")


if __name__ == "__main__":
    main()
