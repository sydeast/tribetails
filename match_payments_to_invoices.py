"""Link the top-level `payments` ledger to `invoices` (confident-only).

Match key (no fuzzy amount guessing): same kinfolkId AND the payment's date equals one of
the invoice's embedded payments[].dateIso (the per-invoice payment dates A3 already wrote).
A payment that maps to exactly one invoice = CONFIDENT (linked). >1 = AMBIGUOUS (left blank,
fail-loud). 0 = UNLINKED (left blank).

  Dry run (default):  python3 match_payments_to_invoices.py
  Commit to prod:     GCLOUD_PROJECT=auntieos-ttpc python3 match_payments_to_invoices.py --allow-prod

Writes payments/{id}.invoiceId (invoice doc id) + invoiceNumber + _paymentInvoiceLinkAt only
for confident matches. Idempotent (skips payments that already carry invoiceId).
"""
from __future__ import annotations
import argparse, os, re, sys
from datetime import datetime, timezone
from pathlib import Path
import firebase_admin
from firebase_admin import credentials, firestore

SA = Path(__file__).resolve().parent.parent / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"
MONTHS = {m: i for i, m in enumerate(
    ["january","february","march","april","may","june","july","august","september","october","november","december"], 1)}
DATE_RE = re.compile(r"(?P<mon>[A-Za-z]+)\s+(?P<day>\d{1,2}),\s+(?P<year>\d{4})", re.I)

def to_iso(s: str):
    if not s: return None
    m = DATE_RE.search(s)
    if not m: return None
    mon = MONTHS.get(m.group("mon").lower())
    if not mon: return None
    return f"{int(m.group('year')):04d}-{mon:02d}-{int(m.group('day')):02d}"

ap = argparse.ArgumentParser()
ap.add_argument("--allow-prod", action="store_true", help="commit writes to prod")
args = ap.parse_args()
dry = not args.allow_prod
if args.allow_prod and os.environ.get("GCLOUD_PROJECT") != "auntieos-ttpc":
    sys.exit("[pay-link] Refusing prod write: GCLOUD_PROJECT != 'auntieos-ttpc'.")

firebase_admin.initialize_app(credentials.Certificate(str(SA)), {"projectId": "auntieos-ttpc"})
db = firestore.client()
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# index invoices by (kinfolkId, payment_dateIso) -> [(invoiceDocId, invoiceNumber)]
inv_by_key: dict[tuple, list] = {}
inv_count = 0
for inv in db.collection("invoices").stream():
    d = inv.to_dict() or {}
    inv_count += 1
    kf = d.get("kinfolkId") or ""
    dates = {p["dateIso"] for p in (d.get("payments") or []) if isinstance(p, dict) and p.get("dateIso")}
    for di in dates:
        inv_by_key.setdefault((kf, di), []).append((inv.id, d.get("invoiceNumber") or inv.id))

pay_total = confident = ambiguous = unlinked = no_date = already = wrote = 0
samples_c, samples_u = [], []
for pay in db.collection("payments").stream():
    d = pay.to_dict() or {}
    pay_total += 1
    if (d.get("invoiceId") or "").strip():
        already += 1; continue
    kf = d.get("kinfolkId") or ""
    pdate = to_iso(d.get("date") or "")
    if not pdate:
        no_date += 1; continue
    cands = inv_by_key.get((kf, pdate), [])
    if len(cands) == 1:
        confident += 1
        doc_id, inv_num = cands[0]
        if len(samples_c) < 12:
            samples_c.append(f"  pay {pay.id} {d.get('kinfolkName')} {d.get('date')} ${d.get('amount')} -> invoice #{inv_num} (doc {doc_id})")
        if not dry:
            pay.reference.update({"invoiceId": doc_id, "invoiceNumber": inv_num, "_paymentInvoiceLinkAt": now})
            wrote += 1
    elif len(cands) > 1:
        ambiguous += 1
    else:
        unlinked += 1
        if len(samples_u) < 10:
            samples_u.append(f"  pay {pay.id} {d.get('kinfolkName')} {d.get('date')} ${d.get('amount')} (kf={kf}) -> NO invoice payment on that date")

print(f"\n[pay-link] {'DRY RUN (no writes)' if dry else 'PROD WRITE COMMITTED'}")
print(f"invoices scanned : {inv_count}")
print(f"payments scanned : {pay_total}")
print(f"  already linked        : {already}")
print(f"  CONFIDENT (1 invoice) : {confident}  (written this run: {wrote})")
print(f"  AMBIGUOUS (>1)        : {ambiguous}")
print(f"  UNLINKED (0)          : {unlinked}")
print(f"  payment date unparsable: {no_date}")
print("\nconfident samples:")
print("\n".join(samples_c) or "  (none)")
print("\nunlinked samples:")
print("\n".join(samples_u) or "  (none)")
