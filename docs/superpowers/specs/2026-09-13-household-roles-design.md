# Household roles: Primary kinfolk, Secondary kinfolk, Emergency Contact

Issue #829. Operator rulings 2026-09-13. Status: draft, awaiting operator approval. No code until approved.

## The rulings this implements

| Role | Portal access | Messages | Who |
|---|---|---|---|
| Primary kinfolk | Yes | Yes | Household admin |
| Secondary kinfolk | Only if the primary grants it | Whatever the primary sets when editing their access | Household member |
| Emergency Contact | Never | Never | Required. Someone outside the household, called when neither kinfolk answers |

- "Secondary contact" (PR #817 admin, PR #828 portal) is removed. A secondary kinfolk covers it.
- A secondary kinfolk can be added **without** an invite. The primary grants portal access later, or never.
- Up to **two** Emergency Contacts per household, in call order.
- Emergency Contacts are edited by admin, the primary, and a secondary kinfolk who has portal access **and** has been given permission by the primary to edit household details.
- Ruling 2026-09-13 (second round): **an Emergency Contact is required**, and **cannot be a household member**. "Emergency contacts usually travel together" with the household, so the person called must be someone else.
- Ruling 2026-09-13 (second round): **a secondary kinfolk's communications are set by the primary** when editing that secondary's access.

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

**One write path.** A new callable `saveEmergencyContacts({ kinfolkId, contacts })` in `mytribe/functions`, used by all five clients. It validates with a strict schema (max 2, name and phone required, no unknown keys) and replaces the array whole, so reordering is one write. Gate: staff; or the household's PRIMARY; or an ACTIVE SECONDARY whose permissions include `home_access` (section 3). A read callable `listEmergencyContacts` uses the same gate plus any ACTIVE member for reading.

**Required.** A household must have at least one Emergency Contact.
- `saveEmergencyContacts` refuses an empty list (`failed-precondition`, "A household needs at least one Emergency Contact").
- Creating a household (admin Add Kinfolk on all three admin clients) requires one before the household saves.
- The 5 of 13 prod households with none are not blocked from unrelated edits. Admin sees a "No Emergency Contact" flag on the household and in the directory. The primary sees a prompt on the portal Tribe screen until one is added.

**Not a household member.** The callable refuses a contact whose phone matches the primary's or any secondary kinfolk's phone (compared after normalising with `libphonenumber-js`, already a functions dependency), or whose name matches a member's name exactly (case and spacing ignored). The message says why: "An Emergency Contact has to be someone outside the household." The clients show the same check before saving.

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

**Communications are the primary's call.** When editing a secondary kinfolk's access, the primary also sets what that person receives (the existing `messaging_direct` and `messaging_group` flags, plus notifications), independent of whether they have portal access.
- With portal access: delivery works as it does for members today.
- Without portal access: the notification dispatcher addresses members by uid, and this person has none. Delivering to them means sending by SMS or email to the phone and email on the person record. That is new dispatcher work, scoped in PR 2, and those toggles stay hidden for a no-access secondary until it ships, per "feature flags ship functional".

Uid-keyed members and every gate stay untouched. The alternative (member docs with optional uid and a new status) touches every member lookup in the backend and was rejected for that reason.

### 3. The permission: reuse `home_access`, no new flag

Operator question 2026-09-13: "isn't home_access the same as the intended household_edit". It is. `home_access` ("Sees the household home details, including entry notes") already gates `saveHomeAccess` (gate code, key location, Wi-Fi password, home-details custom fields, where the portal Android app keeps the after-hours emergency vet) and the home-details half of `getMyTribeProfile`. Emergency Contacts are household details of the same kind, so they go behind the same flag. No seventh permission, no schema change, no backfill.

- `saveEmergencyContacts` and `listEmergencyContacts` gate on `requireKinfolkPerm(uid, kinfolkId, 'home_access', ...)`, which already lets staff and the primary through.
- The description widens on all five clients to "Sees and edits the household home details: entry notes and Emergency Contacts."
- Trade-off, accepted by reusing it: a secondary allowed to edit Emergency Contacts also sees the gate code and Wi-Fi password.
- Found alongside: `saveTribeProfile` checks only household membership (`resolveKinfolkAccess`), not a permission, so today any secondary can write the portal's `emergencyContact*` custom fields. That write path is removed by section 1.

### 4. Clients (all five)

| Client | Change |
|---|---|
| Admin React web (`auntieos-admin/src`) | Household Members: "Add secondary contact" becomes "Add secondary kinfolk", plus "Give portal access". Kinfolk profile and edit: Emergency Contact becomes a two-slot ordered editor over the callable. |
| Admin Android | Same, on `HouseholdMembers` and `EditKinfolkScreen` / `AddKinfolkScreen`. |
| Admin desktop console (`auntieos-admin/web/composeApp`) | Same on `KinfolkEditScreen` and members. Kept working as the fallback. |
| Portal web (`mytribe/web`) | Tribe profile: contacts card becomes secondary kinfolk; Emergency Contact card writes through the callable, editable only with `home_access`. |
| Portal Android (`mytribe/src`) | Same on `TribeScreen`. |

Copy keeps "Add secondary kinfolk" and "Give portal access" visibly separate, so nobody thinks adding a person grants access. Emergency Contact copy says they are called only when no kinfolk can be reached.

### 5. Rules and removals

- `firestore.rules`: rename the closed `contacts` match to `secondaryKinfolk`, still closed to clients. Edit in `mytribe/`, re-mirror to `auntieos-admin/`.
- Tests retired or rewritten: `household-members.cy.ts`, `TribeProfile.contacts.test.tsx`, `HouseholdContactsCardTest.kt`, `HouseholdContactsPortalApiTest.kt`, `mytribe/functions/test/householdContacts.test.ts`, `auntieos-admin/src/api/householdContacts.test.ts`.

## Delivery

Two PRs, each a full vertical (callables, rules, all five clients, tests), neither stacked on the other:

1. **Emergency Contact**: storage, callables gated on `home_access`, five clients, audience-builder tests, migration script (dry run in the PR, write run by the operator after release).
2. **Secondary kinfolk**: person record, access grant, `acceptInvite` link, five clients, removal of secondary contact.

## Answered questions

1. **"Emergency contacts priority"** (free-text on Household Data) stays as a note. Operator answer: "Emergency Contact still needs to remain". Read as keep; the two ordered slots still carry who is called first.
2. **Secondary kinfolk communications** are set by the primary when editing access (section 2).
