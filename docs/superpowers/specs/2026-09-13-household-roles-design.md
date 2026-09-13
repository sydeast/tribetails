# Household roles: Primary kinfolk, Secondary kinfolk, Emergency Contact

Issue #829. Operator rulings 2026-09-13. Status: draft, awaiting operator approval. No code until approved.

## The rulings this implements

| Role | Portal access | Messages | Who |
|---|---|---|---|
| Primary kinfolk | Yes | Yes | Household admin |
| Secondary kinfolk | Only if the primary grants it | See open question 2 | Household member |
| Emergency Contact | Never | Never | The person admin calls when neither kinfolk answers |

- "Secondary contact" (PR #817 admin, PR #828 portal) is removed. A secondary kinfolk covers it.
- A secondary kinfolk can be added **without** an invite. The primary grants portal access later, or never.
- Up to **two** Emergency Contacts per household, in call order.
- Emergency Contacts are edited by admin, the primary, and a secondary kinfolk who has portal access **and** has been given permission by the primary to edit household details.

## What prod holds today (read-only counts, 2026-09-13)

| Store | Count |
|---|---|
| `families` docs | 13 |
| `families/*/members` docs | 4 |
| `families/*/contacts` (secondary contacts) | **0** |
| `kinfolk/{id}` with `emergencyContactName/Phone/Relation` set | **8 of 13** |
| `families/{id}.customFields` with `emergencyContact*` keys | **0** |

## Defect found while scoping

Emergency Contact lives in two unrelated places today:

- The admin clients (React web, Android, desktop console) read and write flat fields on `kinfolk/{id}`. All 8 real records are here.
- The portal (web and Android) writes `emergencyContact*` keys into `families/{id}.customFields`, via `saveTribeProfile` inside an array named `vetFields`. The admin never reads that store.

So an Emergency Contact a household enters in the portal never reaches the office. Prod shows 0 such writes, so nothing has been lost yet. This design gives Emergency Contact a single store.

## Design

### 1. Emergency Contact

**Storage.** One array field on `kinfolk/{id}`, where the 8 existing records already live:

```
emergencyContacts: [
  { name: string, phone: string, relationship: string | null, recordedAt: Timestamp, updatedAt: Timestamp }
]   // length 0..2, index 0 is called first
```

Name and phone are required. Relationship is optional and clearable, per "persisted fields must be editable".

**One write path.** A new callable `saveEmergencyContacts({ kinfolkId, contacts })` in `mytribe/functions`, used by all five clients. It validates with a strict schema (max 2, name and phone required, no unknown keys) and replaces the array whole, so reordering is one write. Gate: staff; or the household's PRIMARY; or an ACTIVE SECONDARY whose permissions include `household_edit` (section 3). A read callable `listEmergencyContacts` uses the same gate plus any ACTIVE member for reading.

**Never messaged.** Emergency Contacts are not recipients of anything. No broadcast, blast, reminder or notification audience reads `emergencyContacts`. A test on each audience builder asserts an Emergency Contact's phone never appears in the resolved recipients.

**Migration of the 8 records.** A one-shot script moves each `kinfolk/{id}` flat triple into `emergencyContacts[0]`. `recordedAt` takes the kinfolk doc's existing `updatedAt` (the closest real date the old record has), never the migration date. Dry run first, printing a per-household diff. The operator runs the write. Old flat fields stay readable until the migration is verified, then stop being read and written.

**Portal cleanup.** The portal stops writing `emergencyContact*` into `families/{id}.customFields` and stops calling that array `vetFields`. Prod holds none, so nothing to migrate.

### 2. Secondary kinfolk without an account

`families/{id}/members/{uid}` is keyed by Firebase uid, and every gate (`memberGate.ts`, `setMemberPermissions`, `removeMember`, `acceptInvite`) looks members up by uid. A person with no account has no uid, so they cannot be a member doc without changing every one of those lookups.

**Recommended: a person record separate from the access grant.**

- `families/{id}/secondaryKinfolk/{personId}`: name, phone, email (optional), `access: 'NONE' | 'INVITED' | 'ACTIVE'`, `memberUid: string | null`. This replaces `families/{id}/contacts` (0 docs in prod, so the rename is free) and reuses its strict-schema callables, renamed.
- **Add secondary kinfolk** (primary or admin) creates the person record with `access: 'NONE'`. No invite, no email.
- **Give portal access** mints the existing invite with `personId` attached. `acceptInvite` still creates `members/{uid}` exactly as today, and additionally sets the person record to `ACTIVE` with `memberUid`.
- Removing access deletes the member doc and returns the person to `NONE`. Removing the person removes both.
- The Members screen lists person records, showing access state on each row.

Uid-keyed members and every gate stay untouched. The alternative (member docs with optional uid and a new status) touches every member lookup in the backend and was rejected for that reason.

### 3. The seventh permission: `household_edit`

`MemberPermissions` has six flags today: `billing_full`, `messaging_direct`, `messaging_group`, `kin_edit`, `kintales_only`, `home_access`. None covers household details. Add `household_edit`: edit the household's Emergency Contacts and Household Data (vets, supply locations, emergency notes). It is named for the whole screen so a later field does not need an eighth flag.

- `FULL_PERMISSIONS` (primary) gets `true`. New secondaries default to `false`. A missing field reads as `false`, so the 4 existing member docs need no backfill.
- The primary toggles it on the secondary's permissions, beside the existing six.

### 4. Clients (all five)

| Client | Change |
|---|---|
| Admin React web (`auntieos-admin/src`) | Household Members: "Add secondary contact" becomes "Add secondary kinfolk", plus "Give portal access". Kinfolk profile and edit: Emergency Contact becomes a two-slot ordered editor over the callable. |
| Admin Android | Same, on `HouseholdMembers` and `EditKinfolkScreen` / `AddKinfolkScreen`. |
| Admin desktop console (`auntieos-admin/web/composeApp`) | Same on `KinfolkEditScreen` and members. Kept working as the fallback. |
| Portal web (`mytribe/web`) | Tribe profile: contacts card becomes secondary kinfolk; Emergency Contact card writes through the callable, editable only with `household_edit`. |
| Portal Android (`mytribe/src`) | Same on `TribeScreen`. |

Copy keeps "Add secondary kinfolk" and "Give portal access" visibly separate, so nobody thinks adding a person grants access. Emergency Contact copy says they are called only when no kinfolk can be reached.

### 5. Rules and removals

- `firestore.rules`: rename the closed `contacts` match to `secondaryKinfolk`, still closed to clients. Edit in `mytribe/`, re-mirror to `auntieos-admin/`.
- Tests retired or rewritten: `household-members.cy.ts`, `TribeProfile.contacts.test.tsx`, `HouseholdContactsCardTest.kt`, `HouseholdContactsPortalApiTest.kt`, `mytribe/functions/test/householdContacts.test.ts`, `auntieos-admin/src/api/householdContacts.test.ts`.

## Delivery

Two PRs, each a full vertical (callables, rules, all five clients, tests), neither stacked on the other:

1. **Emergency Contact**: storage, callables, `household_edit`, five clients, audience-builder tests, migration script (dry run in the PR, write run by the operator after release).
2. **Secondary kinfolk**: person record, access grant, `acceptInvite` link, five clients, removal of secondary contact.

## Open questions for the operator

1. **"Emergency contacts priority"** is a free-text field on Household Data today. With call order built into the two slots, remove it, or keep it as a note?
2. **Does a secondary kinfolk with no portal access get notifications** (texts, emails), or nothing until access is granted?
