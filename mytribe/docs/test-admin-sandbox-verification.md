# Stage 0I test-admin sandbox - backend verification

Binding design: `AuntieOS/docs/2026-06-05-stage-0I-test-admin-sandbox.md`.

This covers the MyTribe backend slice: Firestore rules + seed script + tests.
A test admin is a real Firebase Auth user carrying the custom claim
`testTribeId: "test-kinfolk-001"` and NO `admin: true`. Rules hard-restrict it to
that one kinfolk + its related records. Live data is unreachable.

## Automated verification (already green)

- Seed pure-shape unit tests:
  `cd MyTribe/functions && npx vitest run` (includes
  `../scripts/test/seed_test_sandbox.test.ts`). 687 total.
- Rules emulator tests (real `@firebase/rules-unit-testing` against the Firestore
  emulator), `functions/test/rules/testAdminSandbox.test.ts`:
  `cd MyTribe/functions && npm run test:rules` (72 total, 13 in the sandbox file).

Both pass with the rules as written. The rules-test harness loads
`MyTribe/firestore.rules` directly, so the test exercises the deployed contract.

## What the rules tests assert

- test admin READS its own kinfolk / kin / invoices / kin_care_sessions /
  kin_care_reports / payments / media_files -> ALLOWED.
- test admin WRITES (create + update) its own scoped docs -> ALLOWED (create is
  gated on the incoming `kinfolkId == testTribeId`).
- test admin reads/writes ANOTHER tribe's docs -> DENIED.
- test admin creates a doc tagged with another tribe id -> DENIED.
- test admin reads global config (vet_clinics, business_settings,
  kintale_templates, formSchemas) -> ALLOWED.
- test admin writes global config -> DENIED.
- test admin reaches admin-only operational collections (activity_log, users,
  dossiers, training_documents, the_411) -> DENIED.

## Manual operator verification (after deploy + seed)

1. Deploy rules (see operator commands below).
2. Run the seed `--apply` (creates the Auth user + claim + sandbox docs).
3. Set the test admin password via the Firebase console (or re-run with
   `--apply --password=<pw>`).
4. Sign in as the test admin in the client and confirm:
   - Only `TEST SANDBOX` kinfolk + its 2 kin / 3 sessions / 1 invoice / 1
     payment / 1 KinTale / 1 media doc are visible.
   - No live client data appears anywhere.
   - Editing a sandbox doc succeeds; the TEST MODE banner is shown.

## Notes / scope

- AuntieOS has NO separate top-level `bookings` / `booking_requests` collection;
  the scheduled `kin_care_sessions` doc IS the booking. The seed's SCHEDULED
  session carries `kind: 'BOOKING'`. No phantom collection was fabricated.
- `firestore.rules` here is the single source of truth (see file header). After
  any change, sync to `sotu-hosting/firestore.rules` and deploy from there per
  the existing deploy convention.

## Operator commands

```sh
# 1. Deploy rules (from MyTribe, or sync + deploy from sotu-hosting):
firebase deploy --only firestore:rules --project auntieos-ttpc

# 2. Seed (dry-run first, then apply):
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/auntieos-ttpc-sa.json
cd MyTribe/functions
npx ts-node --project ../scripts/tsconfig.json ../scripts/seed_test_sandbox.ts
npx ts-node --project ../scripts/tsconfig.json ../scripts/seed_test_sandbox.ts --apply
# optional: set a password at create time
npx ts-node --project ../scripts/tsconfig.json ../scripts/seed_test_sandbox.ts --apply --password='<pw>'
```
