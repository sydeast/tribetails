# Admin and Auntie as separate access levels

Issue #944. Operator ruling 2026-09-22. Closes #942.

This is the design the code in this PR implements: the claim, the Firestore
rules and the server callables. It does not cover the admin clients. Hiding
controls on web, Android and desktop is a separate PR, and section 11 says
exactly what is left for it, including one item that blocks the role being
usable at all.

## 1. The ruling

Recorded from the operator, 2026-09-22:

- **admin** is the owner. Gets all business things.
- **auntie** is the caretaker: a contractor, an employee.
  - Household info: **yes**. An Auntie must see it to do the job.
  - Money: **no**. "do you really think a fucking contractor should be seeing
    money shit, no of course not." Invoices, payments, balances, payouts,
    Stripe, pricing: all admin only.
  - Dossiers: **admin only**.
  - 411s: **an Auntie can see them.**
  - Data the Auntie adds, such as KinTales, still feeds these records exactly
    as it does today.

## 2. The role model

| Role | Who | Signal |
| --- | --- | --- |
| Owner | The business owner. One account today. | `admin: true` |
| Auntie | Caretaker. Contractor or employee. | `staffRole: 'auntie'` |
| Kinfolk | A household member using the portal. | `role: 'kinfolk'` + `kinfolkId` |

The Stage-0I test admin (`testTribeId`) is unchanged and is not a staff role.
It stays hard-scoped to one sandbox household by the rules it already has.

## 3. The claim shape, and why this one

**An Auntie carries `staffRole: 'auntie'` and does NOT carry `admin`.**

The alternative was to keep `admin: true` on both roles and distinguish them
with a second field. That is rejected, and the reason is the whole safety
argument for this PR.

116 live rule sites and 62 server expressions read the admin claim today. Under
a shared `admin: true`, every one this PR failed to revisit would silently
grant an Auntie owner power, and the failure would be invisible. Two of those
sites are `setAdminClaim` and `listAdmins` in
`auntieos-admin/web/functions/index.js`, so the miss that costs the most is the
one letting an Auntie mint herself the owner claim.

With the claim split, an unrevisited site reads `admin == true` on a token that
does not carry it, and refuses. Every grant an Auntie receives is a line
someone wrote on purpose, and the review question narrows from "did we find all
116?" to "is each opening correct?"

The cost is that the Auntie role is invisible to any code not taught about it.
Section 11 lists what that creates.

Three further properties:

- **`staffRole`, not `role`.** `role` is the kinfolk claim
  (`mytribe/functions/src/lib/kinfolkClaim.ts`). Reusing it would collide.
- **An account holding both claims degrades to Auntie.** `isOwner()` requires
  `admin == true` AND not the Auntie role, so a minting mistake fails toward
  less access.
- **An unknown future `staffRole` is neither role.** A token carrying
  `staffRole: 'bookkeeper'` is refused everywhere until someone writes rules
  for it.

## 4. Existing accounts

**Nothing happens to them.** The operator holds `admin: true` and no
`staffRole`, which is `isOwner()`, which is every grant the old `isAuntie()`
gave. There is no backfill, no window where the operator is locked out, and no
ordering requirement between deploying rules and minting claims.

That property is why this claim shape was chosen. The migration is additive:
minting `staffRole: 'auntie'` on a new account is the only write anyone
performs, once per Auntie, at hire.

`AUNTIE_OPERATOR_UIDS` (`mytribe/functions/src/lib/operatorAllowlist.ts`) still
resolves to owner. It is the RULING O-6 bootstrap fallback. **An Auntie's uid
must never be added to it**, because that list carries no role and grants
owner.

### Minting an Auntie

`mytribe/functions/scripts/grant-staff-role.mjs`, run like its sibling
`grant-admin-claim.mjs`:

```
GOOGLE_CLOUD_PROJECT=auntieos-ttpc node scripts/grant-staff-role.mjs \
  --email auntie@example.com --role auntie
```

It merges the claim rather than replacing it, refuses an account already
holding `admin: true` (naming the revoke step instead of producing a
double-claimed token), creates `staff/{uid}` so the Assigned Auntie picker and
the business-admin roster gate can see the account, and prints the section 11
warning that the admin app will not yet let this account in.

## 5. The money boundary

A rule or callable is owner-only if it touches invoices, payments, credits,
balances, payouts, pricing or Stripe.

Whole collections that are money, owner-only in full: `invoices` (flat),
`families/{fid}/invoices` (retired nested, section 9), `payments`,
`stripeEvents`, `stripePayments`, `stripeDisputes`, `promo_codes`, `expenses`,
`businessSettings`, `coverage_package_config`.

Pricing catalogs, owner-only to WRITE: `base_services`,
`supplemental_services`, `surcharges`, `discounts`, `business_hours`. Their
READ is `signedIn()` and this PR does not change it. That read already serves
every signed-in user, kinfolk included, because the portal renders price lists
from it. Narrowing it to staff would break the portal and protect nothing,
since a household can already see what it is charged. Recorded here so a
reviewer does not read it as an oversight.

### Money on documents that are not money collections

Firestore rules gate a document, never a field. Six records carry money on
something an Auntie otherwise needs. These were found by auditing the Kotlin
data models and the TS writers, not by reading collection names, and two of
them are not where you would look.

| Document | The money on it | Decision |
| --- | --- | --- |
| `families/{fid}` | **`accountBalanceCents`**, the household's real credit ledger (`mytribe/functions/src/lib/accountCredit.ts:98`). Not declared on `FamilyDoc` in `lib/schema.ts`, so TypeScript does not warn you it is there. | **Owner-only read.** An Auntie gets household information from `kinfolk/{id}`, `household_data`, `the_411` and the `families/{fid}` subcollections, all of which stay open to her. The root document is displayName plus the balance. |
| `enhanced_bookings` | **`basePrice`, `surcharges[].amount`, `discounts[]`, `promoCodeUsed`, `totalPrice`, `supplementalServices[].price`** (`.../data/model/ServiceModels.kt:236-300`) | **Owner-only read and write.** This is a priced document end to end; there is nothing to pin. Cost: the Android Schedule grid reads this collection, so an Auntie loses that grid until the follow-up points it at `kin_care_sessions` (which the web grid already uses) or at a projecting callable. Named in section 11. |
| `business_settings/{docId}` | **`serviceRates`** (the pricing catalog of record, read first by `getServiceCatalog`) and **`venmoHandle` / `paypalHandle` / `cashappHandle`** | **Owner-only read and write.** The Auntie's Android Home reads business settings through the `getBusinessSettings` callable, which projects. The direct-read grant here serves the owner and the sandbox test admin. |
| `clients/{uid}` | `stripeCustomerId`, `stripePaymentMethodId` | **Owner-only read.** An Auntie has no reason to read a payer record. |
| `kinfolk/{kinfolkId}` | **`outstandingBalance`**, a hand-edited dollar string (`.../data/model/Models.kt:185`) | **Read allowed, write pinned.** See below. |
| `families/{fid}/bookings/{batchId}/kinCares/{visitId}` | **`priceCents`**, the real per-visit price (`mytribe/functions/src/portal/requestBooking.ts:762`) | **Read allowed, write pinned.** See below. |

### The two collisions, named rather than buried

`kinfolk/{id}` is the household record the ruling explicitly grants, and it
carries one money field. `kinCares/{visitId}` is the visit the whole job runs
on, and it carries one price. Rules cannot mask a field, so the choice on each
is: deny the record (which removes the job) or grant it and say what leaks.

**The resolution is to grant the read, pin the write, and state the exposure:
an Auntie can see what a household owes and what a visit was priced at. She
cannot change either.** Hiding the two numbers needs a projecting callable on
the client read path, or moving `outstandingBalance` off the household record.
Both are follow-up work, listed in sections 11 and 12. This is a consequence of
the ruling meeting a Firestore limitation, and it is written down rather than
quietly granted.

### The pinning helper, and a defect in the existing one

The file already pins money fields on writes, to stop a restricted household
secondary moving them:

```
function invoiceKeys() {
  return ['payment','invoiceStatus','paymentStatus','amountMinor','currency','invoiceId'];
}
function restrictedSitterKeys() {
  return ['assignedTo','assignedSitterId','sitterRate','sitterPayout'];
}
```

**Neither list names a field any writer in this tree writes onto `bookings` or
`kinCares`.** Every `invoiceKeys()` name lives on `invoices/{id}`.
`assignedTo`, `assignedSitterId`, `sitterRate` and `sitterPayout` appear
nowhere outside one test fixture (`mytribe/functions/test/getMyVisits.test.ts:155`);
the real assignment field is `assignedAuntieUid`. So
`invoiceFieldsUnchanged()` and `sitterFieldsUnchanged()` currently constrain
nothing on those two collections.

That is a pre-existing defect in the household-secondary gate. It is reported,
not fixed here: it is not this PR's boundary, and changing what a household
secondary may write is a different ruling. **Nothing is removed.** The caretaker
branch instead gets its own list, correct for the fields that exist:

```
function caretakerMoneyKeys() {
  return ['priceCents', 'billing', 'outstandingBalance',
          'payment','invoiceStatus','paymentStatus','amountMinor','currency','invoiceId',
          'assignedTo','assignedSitterId','sitterRate','sitterPayout'];
}
```

The stale names are carried forward deliberately: they cost nothing, and if a
writer ever starts producing them the caretaker gate already refuses.

## 6. Dossiers and 411s

Standing ruling ("Three record banks"): dossier, 411 and household bank, routed
by target, no fan-out. The 2026-09-22 ruling splits them for the Auntie:

| Bank | Target | Auntie read | Auntie write |
| --- | --- | --- | --- |
| `dossiers/{kinfolkId}` | the kinfolk | no | no |
| `the_411/{kinfolkId}` | the kin | **yes** | no |
| `household_bank/{householdId}` | the household | no | no |

`household_bank` is owner-only on both counts, and the reason is that nobody
ruled on it. Despite the name it holds no money: it is prose and reconcile
fields, the household's peer of a dossier (`.../data/model/Models.kt:336-353`).
It therefore sits exactly between a record the operator denied and a record the
operator granted, and guessing which way is not safe. Section 12 asks for the
ruling.

### Why an Auntie needs no write on any of the three

This is the "data the Auntie adds still feeds these records" clause. It holds
without granting a single write, because the feed never ran through the client.

An Auntie writes a KinTale as a direct client write to `kin_care_reports`
(`auntieos-admin/src/api/kinTalesWrite.ts:182`, Android
`KinCareRepository.kt:679`, desktop `FirestoreInterop.jvm.kt:424`; there is no
save callable). That write fires `onKinTaleCreate`
(`mytribe/functions/src/triggers/onKinTaleCreate.ts:145`), which seeds
`reconcileStatus: 'pending'` (`mytribe/functions/src/lib/reconcileStatus.ts:50`).
The nightly Python reconcile (`auntieos-admin/web/functions-python/reconcile_comms.py`,
03:00 America/Chicago) picks up every pending report and writes
`dossiers/{kinfolkId}` (`:471`), `the_411/411_{kinId}` (`:578`) and
`household_bank/{householdId}` (`:664`).

Every downstream write runs on the Admin SDK, which does not evaluate these
rules. The Auntie's KinTale keeps updating exactly the fields it updates today
while she holds no grant on any of the three banks. Section 13's emulator test
proves it rather than asserting it.

**One thing must not be narrowed, or sending a KinTale breaks on every client.**
All three admin clients write `reportIds`, `sentReportCount` and
`autoCompleteEligible` onto `kin_care_sessions` in the same batch that sends the
report (`kinTalesWrite.ts:234`, `KinCareRepository.kt:799`,
`JvmFirestoreRest.kt:541`). The `kin_care_sessions` update grant stays open to a
caretaker for that reason.

## 7. How the rules say it

`isAuntie()` is **deleted**, not renamed in place. Today it means "the owner",
and after this ruling the word means the other role. Leaving the name attached
to the owner's grant is how the next person reads a rule backwards. Three
helpers replace it:

```
function isOwner() {
  return request.auth != null
      && request.auth.token.admin == true
      && !hasAuntieRole();
}

function hasAuntieRole() {
  return 'staffRole' in request.auth.token
      && request.auth.token.staffRole == 'auntie';
}

function isCaretaker() {
  return request.auth != null && hasAuntieRole();
}

function isStaff() { return isOwner() || isCaretaker(); }
```

**The `in` guard is load-bearing, and was not in the first draft of this spec.**
Written the obvious way, `request.auth.token.staffRole != 'auntie'`, the rename
commit took down 47 of the 270 existing rules tests with "Property staffRole is
undefined on object". In Firestore rules, reading a key a token does not carry
is an error, not a null, and an error inside a condition denies the request. No
token in this project carries `staffRole` yet, the operator's included, so that
spelling would have turned every owner grant in the file into a refusal on the
deploy that shipped it: precisely the lockout section 4 promises cannot happen.

It is the same trap `kinfolkLocationSharingOn()` already documents further down
this rules file, where `.data.get(key, default)` exists for the same reason.
The existing suite caught it because those 270 tests sign in as an owner
carrying no `staffRole` on nearly every path, which is also why the no-lockout
test in section 13 earns its place over any other test here.

Deleting the old name is what forces the walk: every site stops resolving until
someone picks one of the three.

### Counts

`grep -c 'isAuntie()' mytribe/firestore.rules` reports 128, which is the number
in #944. That counts lines. Broken down: 11 are prose in comments, 1 is the
function definition on line 20, and **116 are live rule lines** carrying 117
grant occurrences (line 1016, `promo_codes`, has two on one line).

116 is the number of decisions in section 8.

### The reviewer's decision procedure

Apply in order to any rule site. The first match decides it.

1. Is the collection in the money list in section 5? Then `isOwner()`.
2. Is it `dossiers` or `household_bank`? Then `isOwner()`.
3. Is it `the_411`? Then read `isStaff()`, write `isOwner()`.
4. Does the document carry a money field although the collection is not a money
   collection (section 5's table)? Then either `isOwner()`, or a caretaker
   branch pinned with `caretakerMoneyFieldsUnchanged()`. Never a bare
   `isStaff()` write.
5. Does the Auntie's job require it: household and kin records, visits,
   KinTales, home access, media, the household conversation, her own schedule?
   Then `isStaff()`, except that a destructive `delete` stays `isOwner()`.
6. Is it business administration, claims, security, audit oversight, marketing,
   or the business phone? Then `isOwner()`.
7. None of the above: `isOwner()`, and add the collection to section 12.

Rule 5's delete carve-out is deliberate. An Auntie records care; she does not
retire a household's records. Every `allow delete` an Auntie does not hold was
decided by that clause, not missed.

## 8. The 116 rule sites

Line numbers are against `mytribe/firestore.rules` at `789f939`. Totals: **64
lines owner-only** (65 occurrences), **47 lines any staff**, **4 lines pinned**,
**1 line to `if false`**.

The table is generated and checked against the file, so it cannot drift into
listing a site that does not exist or omitting one that does.

| line | site | decision | why |
| --- | --- | --- | --- |
| 127 | `meta/stateOfTheUnion write` | `isOwner()` | business status page |
| 165 | `enhanced_bookings read+write` | `isOwner()` | carries basePrice/surcharges/discounts/totalPrice (ServiceModels.kt:236) |
| 255 | `business_settings read` | `isOwner()` | serviceRates + venmo/paypal/cashapp handles |
| 256 | `business_settings write` | `isOwner()` | same document |
| 264 | `coverage_package_config read` | `isOwner()` | priced visit menu |
| 265 | `coverage_package_config write` | `isOwner()` | priced visit menu |
| 331 | `kinfolk read` | `isStaff()` | the household record; job requires it |
| 340 | `kinfolk create` | `isOwner()` | onboarding a client |
| 342 | `kinfolk update` | pinned | pinned off outstandingBalance (Models.kt:185) |
| 346 | `kinfolk delete` | `isOwner()` | destructive |
| 351 | `kin read` | `isStaff()` | the kin; job requires it |
| 354 | `kin create` | `isStaff()` | recording care |
| 355 | `kin update` | `isStaff()` | recording care |
| 356 | `kin delete` | `isOwner()` | destructive |
| 360 | `invoices read` | `isOwner()` | money |
| 404 | `kin_care_reports read` | `isStaff()` | KinTales are the Auntie output |
| 405 | `kin_care_reports create` | `isStaff()` | direct client write, the job |
| 406 | `kin_care_reports update` | `isStaff()` | direct client write, the job |
| 407 | `kin_care_reports delete` | `isOwner()` | destructive |
| 410 | `kin_care_reports/comments read` | `isStaff()` | job |
| 496 | `kin_care_sessions read` | `isStaff()` | visits; invoiceId is an FK with no amount |
| 500 | `kin_care_sessions create` | `isStaff()` | the job |
| 503 | `kin_care_sessions update` | pinned | pinned; also keeps bookingTerminalFieldsUntouched() |
| 505 | `kin_care_sessions delete` | `isOwner()` | destructive |
| 537 | `breadcrumbs read` | `isStaff()` | her own visit GPS |
| 545 | `breadcrumbs write` | `isStaff()` | her own visit GPS |
| 554 | `clients read` | `isOwner()` | stripeCustomerId + stripePaymentMethodId |
| 599 | `families/{fid} read` | `isOwner()` | accountBalanceCents, the household credit ledger (accountCredit.ts:98) |
| 633 | `families/{fid}/members read` | `isStaff()` | household roster, clean |
| 659 | `families/{fid}/kin read` | `isStaff()` | clean |
| 669 | `families/{fid}/kinfolk read` | `isStaff()` | clean |
| 684 | `families/{fid}/bookings read` | `isStaff()` | envelope carries billing intent, no amount |
| 690 | `families/{fid}/bookings update` | pinned | pinned |
| 701 | `kinCares read` | `isStaff()` | needed for the queue; priceCents exposure named in the spec |
| 707 | `kinCares update` | pinned | pinned, priceCents added |
| 716 | `kinCares/notes read` | `isStaff()` | job |
| 725 | `kinCares/internalNotes read` | `isStaff()` | staff notes, clean |
| 734 | `families/{fid}/ratings read` | `isStaff()` | feedback on her own work |
| 739 | `families/{fid}/visitEvents read` | `isStaff()` | job |
| 744 | `families/{fid}/bookingLocks read` | `isStaff()` | job |
| 749 | `families/{fid}/invoices read` | `isOwner()` | money |
| 750 | `families/{fid}/invoices create,update,delete` | `if false` | issue #942 |
| 771 | `families/{fid}/homeAccess read` | `isStaff()` | gate codes; cannot do the job without it |
| 776 | `families/{fid}/themeConfig read` | `isStaff()` | clean |
| 782 | `families/{fid}/mediaGallery read` | `isStaff()` | clean |
| 814 | `families/{fid}/kinTales read` | `isOwner()` | retired path, no reader |
| 815 | `families/{fid}/kinTales write` | `isOwner()` | retired path, no writer |
| 818 | `kinTales/comments read` | `isOwner()` | retired path |
| 819 | `kinTales/comments write` | `isOwner()` | retired path |
| 837 | `{path=**}/kinCares group read` | `isStaff()` | Incoming-requests queue |
| 845 | `inviteRequests read` | `isOwner()` | onboarding |
| 881 | `activity_log read` | `isOwner()` | audit oversight |
| 882 | `activity_log create` | `isStaff()` | her actions must be logged |
| 891 | `activity_log_chain_head read` | `isOwner()` | audit oversight |
| 917 | `notifications read` | `isOwner()` | unfiltered console listen; recipient branch still serves her |
| 942 | `notificationDispatch read` | `isOwner()` | same |
| 948 | `notificationDispatch/channels read` | `isOwner()` | same |
| 968 | `businessSettings read+write` | `isOwner()` | business config incl. the admins roster |
| 978 | `formSchemas create,update,delete` | `isOwner()` | schema authoring |
| 1004 | `booking_time_slots read` | `isStaff()` | her schedule |
| 1011 | `base_services write` | `isOwner()` | pricing catalog |
| 1012 | `supplemental_services write` | `isOwner()` | pricing catalog |
| 1013 | `surcharges write` | `isOwner()` | pricing catalog |
| 1014 | `discounts write` | `isOwner()` | pricing catalog |
| 1015 | `business_hours write` | `isOwner()` | business config |
| 1016 | `promo_codes read+write` | `isOwner()` | discount codes, two sites on one line |
| 1017 | `calls_log read+write` | `isOwner()` | business phone, unruled |
| 1023 | `dossiers read` | `isOwner()` | ruling: admin only |
| 1024 | `dossiers write` | `isOwner()` | ruling: admin only |
| 1026 | `dynamic_field_values read+write` | `isStaff()` | household custom field values |
| 1041 | `emails read+write` | `isOwner()` | outbound business mail |
| 1042 | `field_definitions read+write` | `isStaff()` | renders the household forms she fills in |
| 1050 | `generated_drafts read` | `isStaff()` | her KinTale composer |
| 1051 | `generated_drafts write` | `isStaff()` | her KinTale composer |
| 1053 | `household_data read+write` | `isStaff()` | household info |
| 1064 | `household_bank read` | `isOwner()` | unruled, sits between dossier and 411 |
| 1065 | `household_bank write` | `isOwner()` | unruled |
| 1070 | `kintale_templates read` | `isStaff()` | composer |
| 1071 | `kintale_templates write` | `isOwner()` | catalog authoring |
| 1073 | `location_checkpoints read+write` | `isStaff()` | her visits |
| 1074 | `location_sharing_preferences read+write` | `isStaff()` | her visits |
| 1075 | `media_albums read+write` | `isStaff()` | kin photos |
| 1108 | `media_files read` | `isStaff()` | kin photos |
| 1109 | `media_files create` | `isStaff()` | kin photos |
| 1110 | `media_files update` | `isStaff()` | kin photos |
| 1115 | `payments read` | `isOwner()` | money |
| 1116 | `payments create` | `isOwner()` | money |
| 1117 | `payments update` | `isOwner()` | money |
| 1118 | `payments delete` | `isOwner()` | money |
| 1120 | `sms_messages read+write` | `isOwner()` | business phone, unruled |
| 1121 | `the_411 read` | `isStaff()` | ruling: an Auntie can see them (write stays owner) |
| 1126 | `training_documents read` | `isStaff()` | staff training material |
| 1127 | `users read+write` | `isOwner()` | account administration |
| 1128 | `visit_logs read+write` | `isStaff()` | her visits |
| 1129 | `visit_routes read+write` | `isStaff()` | her visits |
| 1158 | `voicemails read` | `isOwner()` | business phone, unruled |
| 1159 | `voicemails create` | `isOwner()` | business phone |
| 1160 | `voicemails update` | `isOwner()` | business phone |
| 1161 | `voicemails delete` | `isOwner()` | business phone |
| 1178 | `expenses read` | `isOwner()` | money |
| 1179 | `supplies read` | `isOwner()` | grouped with expenses, unruled |
| 1180 | `expirations read` | `isOwner()` | grouped with expenses, unruled |
| 1183 | `ipRateLimits read` | `isOwner()` | security |
| 1184 | `failedLoginEmailRateLimits read` | `isOwner()` | security |
| 1187 | `unknownLoginAttempts read` | `isOwner()` | security |
| 1188 | `passwordResetEmailRateLimits read` | `isOwner()` | security |
| 1189 | `stripeEvents read` | `isOwner()` | Stripe |
| 1193 | `stripePayments read` | `isOwner()` | Stripe |
| 1198 | `stripeDisputes read` | `isOwner()` | Stripe |
| 1205 | `kinTaleNotifications read` | `isStaff()` | her KinTale send ledger |
| 1206 | `securityRateLimits read` | `isOwner()` | security |
| 1207 | `securityIncidents read` | `isOwner()` | security |
| 1213 | `audience_segments read` | `isOwner()` | marketing |
| 1214 | `broadcasts read` | `isOwner()` | marketing |
| 1227 | `conversations read` | `isStaff()` | she is the counterparty |
| 1230 | `conversations/messages read` | `isStaff()` | she is the counterparty |

## 9. Issue #942: the retired nested invoice path

`mytribe/firestore.rules:750` grants `isAuntie()` create, update and delete on
`families/{fid}/invoices`, while the live flat path at line 361 forbids all
three. ADR-0002 requires every invoice write to go through a callable so the
state classifier stamps it.

Harmless while "Auntie" meant the owner. Under this ruling it is an Auntie
writing an unstamped invoice, which the ruling forbids outright.

**Set to `if false`, matching the flat path. The `match` block stays.**

Removing the block was the other honest option and is rejected for now:
`mytribe/scripts/backfillNestedInvoices.ts` says in its own header that prod
must not be assumed clean, and #920's overdue-cron double-chase is evidence
nested copies existed in prod. Read stays `activeMember(fid) || isOwner()` so
whatever is down there remains inspectable until the backfill runs and reports
zero. No payment code is removed; one grant becomes a denial.

Confirmed on the tree at `789f939`: no client or script writes
`families/{id}/invoices`. Every invoice reference in `auntieos-admin/src`,
`auntieos-admin/android`, `mytribe/web/src` and `mytribe/functions/src` targets
the flat top-level collection.

## 10. Server enforcement

An admin callable runs on the Admin SDK, which does not evaluate rules at all.
A callable that moves money must refuse an Auntie itself.

### One table, not 135 edits

`wrapAdminCallable` already receives the callable's name and already wraps 135
of them. The boundary therefore lives in one file,
`mytribe/functions/src/lib/auntieAccess.ts`:

```ts
export const AUNTIE_ALLOWED_CALLABLES: ReadonlySet<string> = new Set([ ... ]);
export function auntieMayCall(name: string): boolean;
```

`wrapAdminCallable` becomes `isOwner(...) || (isCaretaker(token) &&
auntieMayCall(name))`. **A callable absent from the table is owner-only.** A
typo in the table denies rather than grants, and a callable added next month is
owner-only until someone opens it on purpose.

A reviewer reads one file to see the whole server boundary. A test asserts that
every name in the table is a callable that actually exists, so the set cannot
rot into a list of strings gating nothing.

### The portal's staff bypass

Around 50 portal callables pass `req.auth?.token?.admin === true` into
`resolveKinfolkAccess`, `requireKinfolkPerm`, `requireKinfolkPrimary` or
`resolveInvoiceWriteActor`, which is how staff act on a household's behalf. An
Auntie carries no `admin` claim, so all of them refuse her by construction.
That is the correct default and it is what the claim split buys.

Eight are called by the admin clients, so an Auntie needs them. Those read the
same table through `staffBypass(auth, fnName)`: `addBookingNote`,
`getKinTaleComments`, `submitVetClinic`, `saveEmergencyContacts`,
`listMembers`, `createShareLink`, `markNotificationRead`,
`archiveNotification`.

The rest keep the owner-only bypass. They were walked, not edited; the PR body
lists them.

`resolveInvoiceWriteActor` (`mytribe/functions/src/lib/testMode.ts:88`) is the
ADR-0002 invoice-write gate. It refuses an Auntie twice over, no `admin` claim
and no `testTribeId`, and gets an explicit test rather than relying on that.

### Naming

`mytribe/functions/src/lib/staffGate.ts` exports `isStaff`. After this change
that function means **owner**, while the rules helper `isStaff()` means owner
or Auntie. Two things named `isStaff` with different boundaries in one
repository is the CWE-863 shape RULING O-6 closed. The server function is
renamed `isOwner`.

## 11. What this PR does not do

The admin clients are untouched. The consequences are specific:

1. **An Auntie cannot sign in to the admin app.**
   `auntieos-admin/src/lib/access.ts:accessFromClaims` admits on
   `admin === true` or a `testTribeId` and returns `denied` for everyone else.
   An account minted with `staffRole: 'auntie'` authenticates and is refused at
   the gate. Until that function learns the role, the Auntie level exists on
   the server and nobody can reach it. This is item one of the follow-up, and
   `grant-staff-role.mjs` prints it at mint time so the trap cannot be walked
   into quietly.
2. **The Android Schedule grid stops loading for an Auntie**, because it reads
   `enhanced_bookings` and that collection is priced end to end. Point it at
   `kin_care_sessions`, which the web grid already uses, or at a projecting
   callable.
3. Web, Android and desktop all render controls the server now refuses. Hiding
   them is the rest of the follow-up: money screens, the dossier band on the
   kinfolk profile, `household_bank`, marketing, voicemail and calls.
4. The two named read exposures in section 5, `kinfolk.outstandingBalance` and
   `kinCares.priceCents`, want a projecting read path so an Auntie's screens
   show the record without the number.

## 12. Collections that want a ruling

Decided owner-only by step 7 of the procedure, because the operator did not
speak to them and refusing to guess is the safe state:

- `household_bank`. Holds no money; sits between a dossier (denied) and a 411
  (granted); nobody said which.
- `calls_log`, `voicemails`, `sms_messages`. The business phone. All three are
  money-clean, and an Auntie does communicate with households, so there is a
  real case for read.
- `supplies` and `expirations`. Inventory an Auntie arguably needs on a visit.
  Grouped with `expenses` for now because they share a dashboard-widget block;
  `expenses` is money and is not in question.
- Whether `kinfolk.outstandingBalance` should move off the household record, so
  the household grant and the money boundary stop fighting.

## 13. Tests

Rules, `mytribe/functions/test/rules/auntieAccess.test.ts`:

- An owner token with `admin: true` and no `staffRole` keeps every grant it has
  today. This is the no-lockout test and it must never be weakened.
- Auntie reads a household: allowed. Auntie reads an invoice: refused. Auntie
  reads a dossier: refused. Auntie reads a 411: allowed.
- Auntie writes a KinTale: allowed. Auntie writes a price onto a kinCare:
  refused. Auntie deletes a household record: refused.
- Auntie create on `families/{fid}/invoices`: refused (#942).
- A token holding both `admin: true` and `staffRole: 'auntie'` gets the Auntie
  boundary, not the owner's.

Downstream, an emulator test against the real trigger path: an Auntie writes a
KinTale, the send batch lands on `kin_care_sessions`, and the
`reconcileStatus: 'pending'` seed the nightly reconcile keys off is present.
That proves the write still feeds the record, not merely that it succeeded.

Server, `mytribe/functions/test/auntieAccess.test.ts`: every money callable
refuses an Auntie token, every allowlisted callable admits one, and every name
in the table resolves to a callable that exists.

**Every refusal test is proved to discriminate.** A test that cannot fail is
worse than no test on a security boundary. For each refusal the rule or table
entry is loosened, the suite is run, the red is read, and the change reverted.
The PR body records the output.
