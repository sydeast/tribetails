# Decisions

One place for the rulings the code obeys. Code that follows a ruling points
here with one line instead of restating it:

    // D-NO-REFUNDS (docs/DECISIONS.md): credit the account balance, never the card.

The ID is the contract. `git grep D-NO-REFUNDS` finds this entry and every
place that obeys it, so:

- Never reuse or renumber an ID. Do not link by heading anchor; link by ID.
- A reversed ruling keeps its entry and gains a "Superseded by" line. The new
  ruling gets a new ID and a "Supersedes" line.
- IDs the code already used (R1, R5, O-6, O-3, OWNER-1, AO-12, A1, A3, W2-1,
  W3-1, Q3, P2, 953-C*, ADR-*) are kept as spelled. New IDs are
  `D-YYYY-MM-DD-SLUG` for a dated ruling, `D-<issue>-SLUG` for one made on an
  issue, `D-SLUG` for one with no date on record.
- Quotes in "Ruling" are the operator's words as the code recorded them.
- "Enforced in" names files, not lines. Line numbers rot.

Longer records keep their own files: `docs/adr/` for architecture decisions,
`mytribe/docs/RULING_O-6_OPERATOR_TRUST_2026-07-13.md` and
`mytribe/docs/O3_APP_CHECK_RULING_2026-07-13.md`. They get a short entry here
so the ID resolves.

## Index

| ID | Date | Ruling | Area |
|---|---|---|---|
| D-NO-REFUNDS | 2026-07-20 | No refunds, ever | Money and payments |
| D-2026-08-04-GROSS-TIP-AND-FEE | 2026-08-04 | Store gross tip and processor fee, display gross | Money and payments |
| D-KINFOLK-NEVER-SEE-FEES |  | Kinfolk never see processor fees | Money and payments |
| D-2026-08-04-ONE-PAYMENT-ONE-INVOICE | 2026-08-04 | One payment, one invoice | Money and payments |
| D-408-BOUND-LINE-MONEY |  | A visit's money is not typeable on the invoice | Money and payments |
| D-409-METHOD-OFF |  | Turning a payment method off affects new invoices only | Money and payments |
| WALK-2026-08-17-M17 | 2026-08-17 | Payment options are explicit toggles | Money and payments |
| D-2026-08-18-QUOTE-FROZEN | 2026-08-18 | A quote is editable until accepted | Money and payments |
| D-OVERDUE-NOT-A-STATE |  | Overdue is derived, not stored | Money and payments |
| AO-12 |  | Invoice buckets come from the server classifier | Money and payments |
| D-INVOICE-FAIL-SOFT |  | An unreadable settlement state reads as partial | Money and payments |
| D-902-MISSING-AMOUNTDUE |  | Missing amountDue is reported, never written | Money and payments |
| W3-1 |  | Money callables log loudly and return, they do not throw | Money and payments |
| D-FEATURE-FLAGS-FUNCTIONAL | 2026-07-31 | Feature flags ship functional | Money and payments |
| D-DO-NOT-DELETE-PAYMENT-CODE | 2026-07-28 | Payment code is reported, not deleted | Money and payments |
| D-2026-09-27-CREDIT-IS-ADMIN-CHOSEN | 2026-09-27 | Credit is admin-chosen, not automatic | Money and payments |
| D-2026-09-27-PAID-INVOICE-NO-PAYMENT | 2026-09-27 | A paid invoice takes no payment | Money and payments |
| R1 |  | A KinCare session covers every Kin in the household | Households, kinfolk and kin |
| D-2026-08-18-THREE-BANKS | 2026-08-18 | Three admin-only record banks | Households, kinfolk and kin |
| D-2026-08-06-ONE-TRIBE | 2026-08-06 | One kinfolk, one tribe | Households, kinfolk and kin |
| D-2026-08-04-WHO-INVITES-WHOM | 2026-08-04 | The admin invites the primary; the primary invites the secondary | Households, kinfolk and kin |
| D-SECONDARY-PERMISSIONS |  | The primary sets the secondary's permissions | Households, kinfolk and kin |
| D-2026-09-28-BILLING-ACCESS-PAYS | 2026-09-28 | Billing access includes paying | Households, kinfolk and kin |
| D-2026-09-28-VISIT-PRICES-ARE-BILLING | 2026-09-28 | Visit prices are billing information | Households, kinfolk and kin |
| D-SECONDARY-EMAIL-VERIFY |  | Secondaries verify their email too | Households, kinfolk and kin |
| D-684-NO-TYPED-PRIMARY-INVITE |  | No typed-email primary invite | Households, kinfolk and kin |
| D-2026-09-12-CONTACT-NOT-INVITE | 2026-09-12 | A contact is not a portal user | Households, kinfolk and kin |
| D-2026-09-13-HOUSEHOLD-ROLES | 2026-09-13 | Three household people roles | Households, kinfolk and kin |
| D-2026-09-27-HOUSEHOLD-CONTACTS | 2026-09-27 | Up to three household contacts, spelled out | Households, kinfolk and kin |
| D-829-EMERGENCY-CONTACT |  | An Emergency Contact is required, but never blocks edits | Households, kinfolk and kin |
| D-2026-08-04-NO-VISIT-ADDRESS | 2026-08-04 | A visit has no address of its own | Households, kinfolk and kin |
| D-2026-08-25-GEOCODE-ON-FILE | 2026-08-25 | Geocode the address on file | Households, kinfolk and kin |
| D-2026-08-01-VET-ON-HOUSEHOLD | 2026-08-01 | The vet lives on household data | Households, kinfolk and kin |
| D-2026-07-25-VET-PICKER-PARITY | 2026-07-25 | The vet is picked from the clinic catalog | Households, kinfolk and kin |
| D-2026-08-01-NEAR-MATCH-CHOICE | 2026-08-01 | A near-match clinic is a choice, never a substitution | Households, kinfolk and kin |
| D-VET-SCREEN-USE-EXISTING-CALLABLES |  | Vet Clinics retire, never delete | Households, kinfolk and kin |
| D-713-TAG-DELETE |  | A deleted tag goes away completely | Households, kinfolk and kin |
| D-2026-07-31-MEDIA-NOT-OWNED | 2026-07-31 | Kinfolk do not own media | Households, kinfolk and kin |
| D-2026-09-22-AUNTIE-ROLE | 2026-09-22 | Owner and Auntie are separate roles | Staff roles and access |
| O-6 | 2026-07-13 | Operator trust | Staff roles and access |
| D-2026-07-15-RULES-SOURCE | 2026-07-15 | mytribe/firestore.rules is the source of truth | Staff roles and access |
| O-3 | 2026-07-13 | App Check | Staff roles and access |
| D-2026-09-28-APP-CHECK-ONLY-LOGS | 2026-09-28 | App Check only logs | Staff roles and access |
| OWNER-1 | 2026-07-14/15 | No public app store, ever | Staff roles and access |
| D-2026-07-16-REMOVE-APK-MIGRATION | 2026-07-16 | No migration tooling in the admin APK | Staff roles and access |
| D-2026-08-24-SECRET-MANAGER | 2026-08-24 | Secret Manager is the source of secrets | Staff roles and access |
| D-2026-08-26-DESKTOP-PORTAL-EMAIL-ONLY | 2026-08-26 | Desktop portal sign-in is email and password | Staff roles and access |
| A1 |  | One callable seam | Staff roles and access |
| W2-1 |  | KinCare and invoice writes go through callables | Staff roles and access |
| A3 |  | The test sandbox reaches terminal session statuses through the callable | Staff roles and access |
| R5 | 2026-08-03 | Notifications are mail, not delivery state | Notifications and comms |
| RULING-7 | 2026-06-08 | alwaysEnabled is advisory | Notifications and comms |
| D-HOUSEHOLD-SEND-GATE | 2026-09-22 | Household notifications are off until switched on | Notifications and comms |
| D-2026-09-22-NO-DEFAULT-HOUR | 2026-09-22 | No scheduled notification job runs by default | Notifications and comms |
| D-2026-09-22-INVOICE-EDIT-SILENT | 2026-09-22 | Editing an invoice does not notify | Notifications and comms |
| D-866-OFFICE-COPY |  | The office copy rides every send | Notifications and comms |
| D-2026-08-23-FALLBACK-TEMPLATE | 2026-08-23 | Email and push fall back, SMS does not | Notifications and comms |
| D-2026-07-15-SENDGUARD-FAIL-OPEN | 2026-07-15 | The send guard fails open | Notifications and comms |
| D-468-NO-TEMPLATE-SEED | 2026-08-18 | Templates arrive by importer or authoring, never a seed script | Notifications and comms |
| D-2026-08-18-TEMPLATE-DELETE | 2026-08-18 | The operator may delete templates | Notifications and comms |
| D-706-NOTIFICATION-CTAS |  | Fewer notification actions | Notifications and comms |
| D-718-ONE-GATE-ENTRY |  | One way to the notification gate | Notifications and comms |
| D1-INBOX |  | The Inbox is message threads only | Notifications and comms |
| D-2026-09-12-BLASTS-UNDER-COMMUNICATE | 2026-09-12 | Marketing blasts live under Communicate | Notifications and comms |
| D-2026-09-13-BLASTS-UNDER-250 | 2026-09-13 | Size blasts for about 250 recipients | Notifications and comms |
| D-KINTALE-NOT-BROADCAST |  | KinTale is a format, not a channel | Notifications and comms |
| D-2026-08-11-CHICAGO | 2026-08-11 | The business runs on America/Chicago | Notifications and comms |
| D-2026-08-23-DATES-ENUMERATED | 2026-08-23 | Visit dates are listed, not summarised | Notifications and comms |
| D-700-DECLINE-NO-REASON |  | Declining a booking needs no reason | Notifications and comms |
| M18-CHECKED-ONLY | 2026-08-23 | Client KinTales show ticked checklist items only | KinTales and templates |
| Q3-NO-GHOST-KINTALE |  | A KinTale nobody wrote never reaches Firestore | KinTales and templates |
| D-2026-09-10-KINTALE-FROM-KINCARE | 2026-09-10 | A KinTale starts from a Kin Care | KinTales and templates |
| D-2026-08-04-GENERATED-DRAFTS | 2026-08-04 | Generated drafts are KinTale drafts | KinTales and templates |
| P2-SHARE-CONTROLS |  | Share controls on a KinTale | KinTales and templates |
| D-2026-08-26-GUEST-THREAD | 2026-08-26 | Guests see the comment thread | KinTales and templates |
| WALK-2026-08-17-M23 | 2026-08-17 | No canned KinTale email message | KinTales and templates |
| D-394-431-TEMPLATE-DEFAULT |  | KinTale template strings default to empty | KinTales and templates |
| 953-CTRL |  | Controller rulings on the email editor | KinTales and templates |
| 953-C1 |  | Visual templates can still be dragged to a category | KinTales and templates |
| 953-C2 |  | Conversion warns about what it dropped | KinTales and templates |
| 953-C4 |  | Stored markup round-trips byte-exact | KinTales and templates |
| 953-C5 |  | Block helpers lock their block | KinTales and templates |
| 953-C7 |  | The editor callout matches the email | KinTales and templates |
| 953-C9 |  | Merge tokens only in href | KinTales and templates |
| 953-C10 |  | Keep only the processed email image | KinTales and templates |
| 953-C13 |  | An unknown format opens read-only | KinTales and templates |
| D-2026-08-04-CREATEDAT-PROVENANCE | 2026-08-04 | Migrated records keep their original creation date | Data and migration |
| D-593-VIDEO-STRIP-ASYNC |  | Video metadata is stripped after upload | Data and migration |
| D-2026-08-24-FIELD-HAS-CONSUMER | 2026-08-24 | Every stored settings field is read and editable | Data and migration |
| D-DEFAULT-IS-HINT |  | A settings default is a placeholder, never a saved value | Data and migration |
| D-SAVE-OR-FAIL-VISIBLY |  | A save stores or fails visibly | Data and migration |
| D-2026-07-31-HOLIDAY-RECURRENCE | 2026-07-31 | Holiday closures recur by their real rule | Data and migration |
| WALK-2026-08-17-M15 | 2026-08-17 | A KinCare type has three columns | Data and migration |
| D-MOCK-IS-SPEC |  | The mock is the spec | UI and design |
| D-2026-09-11-GLASS-WORLD | 2026-09-11 | The mock glass world is the default skin | UI and design |
| D-2026-09-11-SUBTITLES-ARE-TOOLTIPS | 2026-09-11 | No explanatory copy under panel titles | UI and design |
| D-2026-09-13-INFO-TIP-ON-TAP | 2026-09-13 | Info tips open on a tap | UI and design |
| D-2026-09-12-SLOW-WAIT | 2026-09-12 | Every wait shows a cue and offers a sync | UI and design |
| D-2026-08-06-04-CARDS | 2026-08-06 | Entity lists are card grids | UI and design |
| D-2026-08-08-NO-DISCLOSURE | 2026-08-08 | Forms do not fold fields away | UI and design |
| D-BACK-BUTTON |  | Back goes to the last page | UI and design |
| D-BOOKINGS-NO-TABS |  | Bookings has no filter tabs | UI and design |
| D-703-SESSIONS-UI |  | Sessions follows the mock | UI and design |
| D-2026-09-11-ROUTE-MAP | 2026-09-11 | The Auntie Time detail has a basemap | UI and design |
| D-2026-08-21-PORTAL-BASEMAP | 2026-08-21 | The portal route map has a basemap | UI and design |
| D-2026-09-11-SIGNIN-MOCK | 2026-09-11 | The sign-in mock wins | UI and design |
| D-2026-09-10-TZ-IN-PROFILE | 2026-09-10 | Time zone sits in the profile box | UI and design |
| WALK-2026-08-17-M16 | 2026-08-17 | Weather sits with the business profile | UI and design |
| D-683-ADMIN-NOTES |  | Admin Notes pin to the bottom | UI and design |
| D-686-TAG-PILLS |  | Tags are pills beside the name | UI and design |
| D-692-MEDIA-GRID |  | The gallery uses the mock's fluid grid | UI and design |
| D-2026-08-26-INTEGRATION-ROWS | 2026-08-26 | Integration rows stay, unbuilt | UI and design |
| D-2026-09-12-MOBILE-WEB-FIELD-FALLBACK | 2026-09-12 | Mobile web is the field backup | Platform and clients |
| D-805-SIGNOUT-CLEARS-CACHE |  | Sign-out clears the offline cache | Platform and clients |
| D-WEB-CLOCKIN-TRACKS |  | Web clock-in tracks the route | Platform and clients |
| D-DESKTOP-PARITY-PAUSED |  | Desktop gets no new features | Platform and clients |
| D-2026-08-26-DESKTOP-CONSOLE-FALLBACK | 2026-08-26 | Keep the desktop console working | Platform and clients |
| D-RELEASE-PORTAL-ANDROID-PARITY |  | Both Android apps ship with the web | Platform and clients |
| D-2026-09-12-PORTAL-DIRECT-READS | 2026-09-12 | The portal reads Firestore directly | Platform and clients |
| D-FULL-RELEASE-INCLUDES-ADMIN-FUNCTIONS | 2026-08-04 | A full release ships every codebase | Release and ops |
| D-PREDEPLOY-KEEP-ZERO |  | Skip the pre-deploy prune | Release and ops |
| D-2026-09-30-RELEASE-SCHEDULE | 2026-09-30 | The scheduled release runs Monday and Thursday | Release and ops |
| D-2026-09-14-NIGHTLY-OFF | 2026-09-14 | The nightly release stays off | Release and ops |
| D-2026-08-29-NO-STAGING | 2026-08-29 | One Firebase project, no staging | Release and ops |
| D-2026-08-29-MAIN-CHANNEL | 2026-08-29 | Main publishes to a fixed hosting channel | Release and ops |
| D-2026-09-11-NO-SELF-HOSTED-RUNNERS | 2026-09-11 | CI runs on GitHub-hosted runners only | Release and ops |
| D-2026-09-14-DESKTOP-CI-DISPATCH-ONLY | 2026-09-14 | Desktop CI runs on dispatch only | Release and ops |
| D-2026-08-22-MERGE-COMMITS | 2026-08-22 | Merge commits, never squash | Release and ops |
| D-2026-08-18-NO-VISUAL-GOLDENS | 2026-08-18 | No visual goldens | Release and ops |
| D-2026-09-02-CYPRESS-OVER-PLAYWRIGHT | 2026-09-02 | Cypress stays | Release and ops |
| D-2026-09-01-CYPRESS-UI-ONLY | 2026-09-01 | Cypress specs drive and assert from the UI | Release and ops |
| D-SMOKE-SUITE-SMALL |  | The e2e smoke suite stays small | Release and ops |
| D-WALK-DUPLICATES-SHOWN |  | Walk-to-issues shows duplicates | Release and ops |
| ADR-0001 |  | Generated callable contracts | Architecture records |
| ADR-0002 |  | Invoice writes are callable-only | Architecture records |
| ADR-0003 |  | Booking callables stay out of the generated contracts, for now | Architecture records |
| ADR-0004 |  | The fleet default returns to cpu 1 | Architecture records |

---

## Money and payments

### D-NO-REFUNDS: No refunds, ever
- Date: 2026-07-20 (credits), widened 2026-08-06 (everything).
- Ruling: "there is no refunds and will never be." Money owed back (an unused credit, an overpayment, a paid visit that was cancelled) goes to the account balance and nowhere else. A dispute or chargeback is not a refund.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/InvoiceRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/MoneyIdempotency.kt`, `auntieos-admin/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/MoneyIdempotency.kt`, `mytribe/functions/src/admin/recordPayment.ts`, `mytribe/functions/src/portal/redeemCredit.ts`

### D-2026-08-04-GROSS-TIP-AND-FEE: Store gross tip and processor fee, display gross
- Date: 2026-08-04
- Ruling: "store both, and display the latter. itll help with taxes." A Venmo or PayPal payment records the gross tip and the processor fee; the admin shows the gross, and net is derived.
- Why: the operator takes the fee out of the tip and needs both for taxes.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/domain/InvoiceLedgerRow.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/domain/PaymentMoney.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/invoices/InvoiceDetailScreen.kt`

### D-KINFOLK-NEVER-SEE-FEES: Kinfolk never see processor fees
- Date: standing
- Ruling: portal invoice payloads never carry a fee field.
- Enforced in: `auntieos-admin/src/api/settings.ts`, `mytribe/functions/src/lib/paymentMethods.ts`, `mytribe/src/commonMain/kotlin/com/kinfolk/portal/portal/InvoiceDtos.kt`, `mytribe/web/src/api/types.ts`

### D-2026-08-04-ONE-PAYMENT-ONE-INVOICE: One payment, one invoice
- Date: 2026-08-04
- Ruling: a payment applies to exactly one invoice. It is never split across invoices.
- Enforced in: `auntieos-admin/src/api/invoicesWrite.ts`, `mytribe/functions/src/admin/getInvoiceLedger.ts`, `mytribe/functions/src/admin/listPayments.ts`, `mytribe/functions/src/admin/recordPayment.ts`

### D-408-BOUND-LINE-MONEY: A visit's money is not typeable on the invoice
- Source: #408
- Ruling: an invoice line bound to a priced visit takes its amount from the visit. The invoice editor does not let anyone type over it.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/InvoiceRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/domain/InvoiceLineItems.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AdminDataViewModel.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/UninvoicedVisitsPicker.kt`

### D-409-METHOD-OFF: Turning a payment method off affects new invoices only
- Source: #409
- Ruling: switching a payment method off stops offering it on invoices created after the switch. Invoices already sent keep the methods they were sent with.
- Enforced in: `auntieos-admin/src/screens/settings/sections.tsx`, `mytribe/functions/src/admin/createInvoice.ts`, `mytribe/functions/src/admin/reviewAndSendDraftInvoice.ts`, `mytribe/functions/src/lib/payMethodSnapshot.ts`

### WALK-2026-08-17-M17: Payment options are explicit toggles
- Date: 2026-08-17 walk, mark 17
- Ruling: "Retitle name to Payment Options and make it a true toggle for different payment option". Each method has its own on/off flag in `business_settings.paymentOptions`; a blank handle does not mean off.
- Enforced in: `auntieos-admin/src/screens/settings/sections.tsx`, `mytribe/functions/src/lib/paymentMethods.ts`

### D-2026-08-18-QUOTE-FROZEN: A quote is editable until accepted
- Date: 2026-08-18. Source: #448
- Ruling: a quote can be edited until the household accepts it, then it is frozen. A decline is a step in the conversation: the quote can be revised and resent.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/InvoiceRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/invoices/InvoiceDetailScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/invoices/InvoiceDetailViewModel.kt`, `auntieos-admin/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/booking/BookingScreen.kt`

### D-OVERDUE-NOT-A-STATE: Overdue is derived, not stored
- Ruling: overdue is not an invoice state. It is computed from `dueDate` on invoices that are still open.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/domain/InvoiceActions.kt`, `auntieos-admin/src/lib/invoiceFormat.ts`, `auntieos-admin/src/components/InvoiceDetail.test.tsx`

### AO-12: Invoice buckets come from the server classifier
- Ruling: which bucket an invoice sits in ("paid" and the rest) is decided by the server's classifier. A client never derives one bucket as the negation of another.
- Enforced in: `auntieos-admin/src/api/tribalIntel.ts`, `auntieos-admin/src/screens/Invoices.tsx`, `mytribe/functions/src/lib/invoiceEditPolicy.ts`, `auntieos-admin/src/components/InvoiceDetail.test.tsx`

### D-INVOICE-FAIL-SOFT: An unreadable settlement state reads as partial
- Source: ADR-0001 adoption
- Ruling: when a client cannot read an invoice's settlement state it shows "partial" (money may be owed). It never recomputes the state itself.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/domain/InvoiceActions.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/invoices/InvoiceDetailScreen.kt`, `mytribe/functions/scripts/contracts/emitKotlin.ts`

### D-902-MISSING-AMOUNTDUE: Missing amountDue is reported, never written
- Source: #902
- Ruling: a legacy invoice with a total but no `amountDue` is reported by the reminder jobs. They do not write a value onto it.
- Enforced in: `mytribe/functions/src/lib/invoiceChase.ts`, `mytribe/functions/src/scheduled/invoiceRemindersCron.ts`, `mytribe/functions/test/invoiceChase.test.ts`, `mytribe/scripts/test/backfillInvoiceAmountDue.test.ts`

### W3-1: Money callables log loudly and return, they do not throw
- Ruling: after a non-idempotent money write has happened, a later failure in the same callable is logged loudly and the call returns. Throwing would invite a retry that repeats the write.
- Enforced in: `mytribe/functions/src/admin/archiveInvoice.ts`, `mytribe/functions/src/admin/createInvoice.ts`, `mytribe/functions/src/admin/createQuote.ts`, `mytribe/functions/src/admin/reviewAndSendDraftInvoice.ts`

### D-FEATURE-FLAGS-FUNCTIONAL: Feature flags ship functional
- Date: 2026-07-31
- Ruling: "flags should be shipped fully functional for when the flag is flipped." A flag that turns on a feature with no backing is a defect. Build the backing or delete the flag.
- Enforced in: `mytribe/functions/src/admin/recordPayment.ts`

### D-DO-NOT-DELETE-PAYMENT-CODE: Payment code is reported, not deleted
- Date: 2026-07-28
- Ruling: payment readers, repository methods and the archived Payments screen stay, even when a call-graph sweep finds no caller. Report orphaned payment code; do not delete it.

### D-2026-09-27-CREDIT-IS-ADMIN-CHOSEN: Credit is admin-chosen, not automatic
- Date: 2026-09-27. Source: #977
- Ruling: "1) any overpayment made by the kinfolk, it is assumed the extra is all tip. since we dont charge kinfolk the service fees around payments, I take service fees out of the tip when recording the payments. 2) I as admin should be able to decide if any money remains as credit and how much. 3) credits are usually 'rewards' given by the biz or the remaining balance+ should admin leave any."
- Why: point 1 restates D-2026-08-04-GROSS-TIP-AND-FEE. Points 2 and 3 are new: whether a leftover becomes credit, and how much, is the admin's call, not an automatic computation.
- Supersedes: automatic leftover-to-credit (the `autoApply` tick in `mytribe/functions/src/admin/recordPayment.ts`, which credits any positive leftover to the household's account balance with no admin decision). #977 fixed the leftover arithmetic on that automatic path; this ruling goes further and says the automatic path itself should not decide the credit.

### D-2026-09-27-PAID-INVOICE-NO-PAYMENT: A paid invoice takes no payment
- Date: 2026-09-27. Source: docket Q5
- Ruling: "Invoices shouldn't allow payment once marked as paid."
- Enforced in: `mytribe/functions/src/lib/invoicePaidGate.ts`, `mytribe/functions/src/portal/payInvoice.ts`, `mytribe/functions/src/portal/redeemCredit.ts`, `mytribe/functions/src/portal/getMyInvoices.ts`

## Households, kinfolk and kin

### R1: A KinCare session covers every Kin in the household
- Ruling: "all KinCare sessions covers ALL KIN in the family." Kin are never picked per visit.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/LocationModels.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/domain/KinfolkProfileFeeds.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/scheduling/BookingWizard.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/scheduling/NewBookingWizard.kt`, `auntieos-admin/CLAUDE.md`

### D-2026-08-18-THREE-BANKS: Three admin-only record banks
- Date: 2026-08-18
- Ruling: "kin are children of households and kinfolk are owners of the household. kinfolk data go to kinfolks' dossiers, kin data goes into the kins' 411s. and then household gets its own bank." Records route by target to exactly one bank, with no fan-out. Kinfolk never see any of them ("KINFOLK NEVER SEES DOSSIERS OR 411S", 2026-08-09).
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/TribalIntelTarget.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicateScreen.kt`

### D-2026-08-06-ONE-TRIBE: One kinfolk, one tribe
- Date: 2026-08-06 in code (memory records 2026-08-07)
- Ruling: "only admin can select a tribe or be assigned to one of more tribes for now." A kinfolk account with two or more tribes is a data defect. Clients refuse to guess rather than route it.
- Updated 2026-09-27: an Auntie (the `staffRole` claim) may also be assigned several tribes, the same as the owner. A kinfolk account with two or more tribes stays a defect; only staff (owner or Auntie) may legitimately hold more than one. Most portal callables still gate on the raw `admin` claim rather than the Auntie-aware `staffBypass`, so an Auntie assigned to 2+ tribes can hit this same one-tribe refusal; see #984.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/members/HouseholdMembersScreen.kt`, `auntieos-admin/src/api/members.ts`, `mytribe/functions/src/lib/kinfolkClaim.ts`, `mytribe/functions/src/lib/resolveNonStaffKinfolkId.ts`

### D-2026-08-04-WHO-INVITES-WHOM: The admin invites the primary; the primary invites the secondary
- Date: 2026-08-04
- Ruling: the admin invites a household's primary kinfolk only. The primary invites the secondary. "admin can edit permissions but not like primary's".
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/BookingRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/MembersRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/members/HouseholdMembersScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/members/HouseholdMembersViewModel.kt`

### D-SECONDARY-PERMISSIONS: The primary sets the secondary's permissions
- Ruling: "Primary kinfolk is allowed to set the permissions of the secondary". A primary may grant a secondary any permission, billing included, except the one excluded in `members.ts`. What a secondary receives depends on the primary's settings, whether or not the secondary has portal access.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/MembersRepository.kt`, `auntieos-admin/src/api/members.ts`, `auntieos-admin/web/firestore.rules`, `mytribe/firestore.rules`

### D-2026-09-28-BILLING-ACCESS-PAYS: Billing access includes paying
- Date: 2026-09-28. Source: docket Q7
- Ruling: "Yes: billing access includes paying, using credit, answering quotes and saved cards." A secondary the primary granted billing access can pay an invoice, redeem account credit, accept or decline a quote, and manage saved cards, not only see them.
- Enforced in: `mytribe/functions/src/lib/memberGate.ts`, `mytribe/functions/src/portal/payInvoice.ts`, `mytribe/functions/src/portal/redeemCredit.ts`, `mytribe/functions/src/portal/quoteDecision.ts`, `mytribe/functions/src/portal/billing.ts`, `mytribe/functions/src/billing/stripeWebhook.ts`, `mytribe/src/commonMain/kotlin/com/kinfolk/portal/screens/account/AccountSettingsScreen.kt`

### D-2026-09-28-VISIT-PRICES-ARE-BILLING: Visit prices are billing information
- Date: 2026-09-28. Source: docket Q8
- Ruling: "Yes: visit prices are billing information; hide them from members without billing access."
- Enforced in: `mytribe/functions/src/lib/memberGate.ts`, `mytribe/functions/src/portal/getServiceCatalog.ts`, `mytribe/firestore.rules`, `mytribe/web/src/api/bookingApi.ts`, `mytribe/web/src/screens/BookingWizard.tsx`, `mytribe/src/commonMain/kotlin/com/kinfolk/portal/portal/ServiceCatalogDtos.kt`, `mytribe/src/commonMain/kotlin/com/kinfolk/portal/screens/schedule/BookingWizardScreen.kt`

### D-SECONDARY-EMAIL-VERIFY: Secondaries verify their email too
- Ruling: "secondary needs email verification as well."
- Enforced in: `mytribe/functions/src/membership/acceptInvite.ts`, `mytribe/src/commonMain/kotlin/com/kinfolk/portal/screens/claim/ClaimFlow.kt`, `mytribe/web/src/lib/authErrors.ts`, `mytribe/web/src/screens/ClaimInvite.tsx`

### D-684-NO-TYPED-PRIMARY-INVITE: No typed-email primary invite
- Source: #684
- Ruling: "Invite a primary by email is unnecessary." The typed-email primary invite is gone from the members screen.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/MembersRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/members/HouseholdMembersScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/members/HouseholdMembersViewModel.kt`, `auntieos-admin/src/screens/HouseholdMembers.tsx`

### D-2026-09-12-CONTACT-NOT-INVITE: A contact is not a portal user
- Date: 2026-09-12
- Ruling: "a secondary contact does not have to be a portal user." Adding a contact mints no invite.
- Superseded by: D-2026-09-13-HOUSEHOLD-ROLES, then fully superseded by D-2026-09-27-HOUSEHOLD-CONTACTS (2026-09-27 operator ruling: "none of it stands"). The "secondary contact" this entry names is gone; a household now has at most a Primary Kinfolk, a Secondary Kinfolk and an Emergency Contact. Code still citing this ID for a "secondary contact" concept is stale and should move to D-2026-09-27-HOUSEHOLD-CONTACTS.
- Enforced in (historical): `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/MembersRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/members/HouseholdMembersScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/members/HouseholdMembersViewModel.kt`. `auntieos-admin/src/api/householdContacts.ts` and the other contact list code were removed in #1042.

### D-2026-09-13-HOUSEHOLD-ROLES: Three household people roles
- Date: 2026-09-13. Source: #829
- Ruling: "get rid of secondary contact. Since the secondary kinfolk could be the secondary contact." A household has a Primary kinfolk (portal access, household admin), Secondary kinfolk (portal access only if the primary grants it) and an Emergency Contact (no access, no communication, and never a household member: "they usually travel together").
- Supersedes: D-2026-09-12-CONTACT-NOT-INVITE
- Refined by: D-2026-09-27-HOUSEHOLD-CONTACTS

### D-2026-09-27-HOUSEHOLD-CONTACTS: Up to three household contacts, spelled out
- Date: 2026-09-27
- Ruling: "there is no true 'Contact List'. There can be up to 3 ppl's contact info to a household: Primary Kinfolk (PK), Secondary Kinfolk (SK), and Emergency Contact (EC). PK: contact info required, portal access required. SK: contact info optional, portal access optional. EC: contact info required, portal access never. EC's contact info is a household item."
- Why: there is no separate "Contact List" feature. A household carries at most these three people's contact info, each with its own required/optional shape. Refines D-2026-09-13-HOUSEHOLD-ROLES with the exact required/optional rules per role.
- Supersedes: D-2026-09-12-CONTACT-NOT-INVITE, fully. None of that entry's "secondary contact" model stands.

### D-829-EMERGENCY-CONTACT: An Emergency Contact is required, but never blocks edits
- Source: #829
- Ruling: creating a household requires an Emergency Contact. The No-Emergency-Contact flag never blocks other edits, and clearing a contact never blocks the household save.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/DirectoryViewModel.kt`, `auntieos-admin/src/api/kinfolkProfileWrite.ts`, `auntieos-admin/src/screens/KinfolkEdit.tsx`, `auntieos-admin/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt`

### D-2026-08-04-NO-VISIT-ADDRESS: A visit has no address of its own
- Date: 2026-08-04
- Ruling: a booking or visit carries no address. The address lives on the household.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/BookingRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/scheduling/BookingWizard.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/EditKinfolkScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/KinfolkProfileScreen.kt`

### D-2026-08-25-GEOCODE-ON-FILE: Geocode the address on file
- Date: 2026-08-25
- Ruling: a household's location is the geocode of the address already on file, stored with the household.
- Enforced in: `mytribe/functions/src/lib/householdLocation.ts`

### D-2026-08-01-VET-ON-HOUSEHOLD: The vet lives on household data
- Date: 2026-08-01
- Ruling: "vet info lives on household data". The vet is a catalog clinic id on `household_data`, read-only on the kinfolk and kin records.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/DynamicFields.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/DirectoryFieldChanges.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/DirectoryViewModel.kt`

### D-2026-07-25-VET-PICKER-PARITY: The vet is picked from the clinic catalog
- Date: 2026-07-25. Source: #13
- Ruling: "Vets are not a open string." Every client searches and selects from the clinic catalog; there is no free text.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/DirectoryViewModel.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/EditKinfolkScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/VetClinicSearch.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/members/HouseholdMembersScreen.kt`

### D-2026-08-01-NEAR-MATCH-CHOICE: A near-match clinic is a choice, never a substitution
- Date: 2026-08-01
- Ruling: when a new clinic nearly matches one in the catalog, the operator is offered the choice and must make it. Nothing is substituted silently.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AdminSettingsScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/VetClinicsViewModel.kt`

### D-VET-SCREEN-USE-EXISTING-CALLABLES: Vet Clinics retire, never delete
- Ruling: the Vet Clinics screen uses the callables that exist. A clinic is archived, never deleted.
- Enforced in: `auntieos-admin/src/screens/VetClinics.tsx`

### D-713-TAG-DELETE: A deleted tag goes away completely
- Source: #713
- Ruling: "IF THE TAG IS DELETED THEN IT GOES AWAY COMPLETELY." Deleting a tag removes it from every record that carried it.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/TagModels.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AdminSettingsScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AdminSettingsViewModel.kt`

### D-2026-07-31-MEDIA-NOT-OWNED: Kinfolk do not own media
- Date: 2026-07-31
- Ruling: kin, business and company uploads carry no `kinfolkId`. The uploader chooses which household an upload belongs to.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/DynamicFields.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/domain/GalleryFilters.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/domain/MediaScope.kt`

## Staff roles and access

### D-2026-09-22-AUNTIE-ROLE: Owner and Auntie are separate roles
- Date: 2026-09-22. Source: #944, PR #948
- Ruling: the admin is the owner and sees everything. An Auntie is "the caretaker, a contractor, a fucking employee": they see households, kin, visits and 411s, never money or dossiers. The Auntie role is the `staffRole` claim, never `admin`, and one account never holds both.
- Enforced in: `auntieos-admin/src/api/communicateGenerate.ts`, `auntieos-admin/src/lib/access.ts`, `auntieos-admin/web/firestore.rules`, `auntieos-admin/web/functions/index.js`, `mytribe/functions/src/lib/staffGate.ts`

### O-6: Operator trust
- Date: 2026-07-13. Record: `mytribe/docs/RULING_O-6_OPERATOR_TRUST_2026-07-13.md`
- Ruling: one staff signal, the `admin` custom claim (the env allowlist is a logged fallback). `kinfolkId` is derived on the server and never trusted from the caller. Staff cross-tenant reads are existence-checked and audited. The gate was `isStaff`; #944 renamed it `isOwner`.
- Updated 2026-09-22 (#944): staff split into two roles, Owner and Auntie. The owner reaches everything this ruling ever granted staff. An Auntie sees households and 411s, never money or dossiers (D-2026-09-22-AUNTIE-ROLE). The check this ruling built is `isOwner` (renamed from `isStaff`); a caretaker-scoped check is a separate function (`staffBypass`, `auntieMayCall`) layered on top, not a rewrite of this ruling's owner boundary.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`, `auntieos-admin/src/api/kinTaleDetail.ts`, `auntieos-admin/src/api/vetClinicsWrite.ts`, `auntieos-admin/web/functions/index.js`, `mytribe/functions/src/lib/staffGate.ts`

### D-2026-07-15-RULES-SOURCE: mytribe/firestore.rules is the source of truth
- Date: 2026-07-15
- Ruling: `mytribe/firestore.rules` is the only rules file that deploys. `auntieos-admin/web/firestore.rules` is a mirror, held byte-identical by a test and the pre-commit hook.
- Enforced in: `auntieos-admin/web/firestore.rules`, `mytribe/firestore.rules`, `scripts/safe-deploy.sh`, `auntieos-admin/web/functions/test/rules-mirror.test.js`

### O-3: App Check
- Date: 2026-07-13. Record: `mytribe/docs/O3_APP_CHECK_RULING_2026-07-13.md`
- Ruling: Phase 1 is monitor-only. O-3 D1 (spelled "D1" in code and the record; not D1-INBOX) made Play Integrity the Android provider and ruled out SafetyNet. D2 sets the enforcement order and the kill switch.
- Updated 2026-09-27: D1 no longer stands for Android. OWNER-1's permanent no on Play Console registration means Play Integrity can never ship there, so Android drops App Check and relies on sign-in and rate limits instead; the failing Play Integrity request stops. The web half of D1 is unchanged: reCAPTCHA Enterprise stays the web provider.
- Updated 2026-09-28 (#987): a callable any Compose or Android client can reach never joins the enforced cohort, whatever the mode. Only callables named by the web apps alone are eligible, and none of the portal's are, so the cohort is empty and `enforce` refuses nothing until the operator adds a web-only admin callable. Sign-in and rate limits stay the protection for Android and desktop, per R3.
- Superseded in part by: D-2026-09-28-APP-CHECK-ONLY-LOGS. D2's enforcement is gone: no L2 `enforce` mode, no L3 platform `enforceAppCheck`, and no cohort ever enforced, including the web-only admin callables the #987 update above left eligible. D1's web provider and the L1 telemetry stand.
- Enforced in: `mytribe/functions/src/lib/appCheckPolicy.ts`, `mytribe/functions/scripts/clientCallables.ts`, `mytribe/functions/test/appCheckComposeReachable.test.ts`, `auntieos-admin/src/lib/boot.ts`, `auntieos-admin/src/lib/firebase.ts`

### D-2026-09-28-APP-CHECK-ONLY-LOGS: App Check only logs
- Date: 2026-09-28. Source: docket Q9, #1050
- Ruling: "No: App Check only logs. Sign-in and rate limits protect every function."
- What it means: App Check never refuses a request. Every callable still logs `appCheck: valid | invalid | absent`. `APP_CHECK_COHORT` stays empty, web-only callables included. The `enforce` mode is removed, so `business_settings/security.appCheckMode` accepts only `off` or `log`; a stored `enforce` reads as `log` and logs an `appCheck.enforceIgnored` warning (only when read, and with the cohort empty the field is never read). No function sets the platform `enforceAppCheck` option.
- Supersedes: O-3 D2's enforcement layers (L2 `enforce`, L3 platform enforcement) and its cohort 1 to 3 enforcement order.
- Enforced in: `mytribe/functions/src/lib/appCheckPolicy.ts`, `mytribe/functions/src/lib/wrapCallable.ts`, `mytribe/functions/test/appCheckCohortEmpty.test.ts`, `mytribe/functions/test/appCheckPolicy.test.ts`, `mytribe/functions/test/wrapCallable.test.ts`

### OWNER-1: No public app store, ever
- Date: 2026-07-14/15 (`mytribe/docs/DEVELOPMENT_PLAN_2026-07-10.md`), restated 2026-08-25
- Ruling: "NO, permanent. The app will never be in a public store. Android stays APK-sideload only... Never present Play Console registration as an option again." Applies to `com.tribetails.auntieos` and `com.kinfolk.portal`. Play Integrity needs Play Console registration, so neither app can attest with it.
- Enforced in: `auntieos-admin/android/app/build.gradle.kts`, `mytribe/build.gradle.kts`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/AuntieOSApp.kt`, `mytribe/src/androidMain/kotlin/com/kinfolk/portal/KinfolkPortalApplication.kt`, `mytribe/src/jvmTest/kotlin/com/kinfolk/portal/attestation/AppCheckWiringTest.kt`

### D-2026-07-16-REMOVE-APK-MIGRATION: No migration tooling in the admin APK
- Date: 2026-07-16. Status: done.
- Ruling: the bundled April migration and restore tooling is removed from the admin APK.
- Why: it shipped client dossiers inside every APK.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AdminSettingsScreen.kt`

### D-2026-08-24-SECRET-MANAGER: Secret Manager is the source of secrets
- Date: 2026-08-24 (first stated 2026-08-23)
- Ruling: "SECRETS MANAGER, ALL OUR SHIT IS IN THERE." Client build config and server secrets come from Secret Manager. A secret missing from the repo is not a missing secret.
- Enforced in: `scripts/client-secrets.mjs`, `scripts/release.sh`

### D-2026-08-26-DESKTOP-PORTAL-EMAIL-ONLY: Desktop portal sign-in is email and password
- Date: 2026-08-26. Source: #397
- Ruling: desktop kinfolk sign in with email and password only, until custom account fields exist.
- Enforced in: `mytribe/functions/src/portal/getMyKinTales.ts`, `mytribe/src/jvmMain/kotlin/com/kinfolk/portal/firebase/RestAuthBackend.kt`, `mytribe/web/src/screens/Account.tsx`

### A1: One callable seam
- Ruling: every web callable goes through the one typed client (`lib/fns.ts`), lifted from the portal. Do not build a second one.
- Enforced in: `auntieos-admin/src/lib/fns.ts`

### W2-1: KinCare and invoice writes go through callables
- Ruling: the invoice and KinCare writes move off direct Firestore writes onto callables. See ADR-0002.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/KinCareRepository.kt`

### A3: The test sandbox reaches terminal session statuses through the callable
- Ruling: extends ADR-0002 to KinCare sessions. The test admin sandbox drives the in-visit lifecycle directly but reaches COMPLETED and CANCELLED through `transitionBookingStatus`, the audited path production uses.
- Enforced in: `mytribe/functions/test/rules/testAdminSandbox.test.ts`

## Notifications and comms

### R5: Notifications are mail, not delivery state
- Date: 2026-08-03
- Ruling: "Channels, trigger, and dispatched are activity log not" notification fields. Status, mode and channels come off the notification document (pipeline state moves to a work-order collection), the Activity Log is its own surface, and call-to-action buttons and forensic fields depend on who is reading.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/admin/AdminModels.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/NotificationDelivery.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/ActivityLogScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/NotificationsScreen.kt`

### RULING-7: alwaysEnabled is advisory
- Date: 2026-06-08. Code spells it "ruling #7".
- Ruling: warn-but-allow-off. A catalog entry's `alwaysEnabled` flag is advisory; nothing enforces it at send time and a household may turn any channel off.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/NotificationMatrix.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/NotificationProvenance.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AdminSettingsScreen.kt`, `auntieos-admin/src/lib/myNotificationsFormat.ts`

### D-HOUSEHOLD-SEND-GATE: Household notifications are off until switched on
- Date: 2026-09-22. Source: PR #943
- Ruling: every household-bound notification through the dispatcher is suppressed unless `business_settings.householdNotificationsLive === true`. Absent reads as off. Staff and operator alerts are not gated.
- Enforced in: `mytribe/functions/src/notifications/`, `docs/runbooks/household-notifications.md`

### D-2026-09-22-NO-DEFAULT-HOUR: No scheduled notification job runs by default
- Date: 2026-09-22
- Ruling: no scheduled notification job runs until the operator switches it on in Settings. There is no default hour.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/LocationModels.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/NotificationSchedulePanel.kt`, `auntieos-admin/src/api/settings.ts`, `auntieos-admin/src/screens/settings/NotificationScheduleSection.tsx`

### D-2026-09-22-INVOICE-EDIT-SILENT: Editing an invoice does not notify
- Date: 2026-09-22. Source: #906
- Ruling: "if i'm editing an invoice it doesn't need to notified the household until i send it as an open invoice." `invoice.new` on send is the household's first notice; `invoice.updated` has no emitter.
- Enforced in: `mytribe/functions/src/notifications/provenance.ts`

### D-866-OFFICE-COPY: The office copy rides every send
- Source: #866
- Ruling: the office copy goes out on every enqueue. When the household recipient is unticked, the household is never told.
- Enforced in: `mytribe/functions/src/admin/recordPayment.ts`, `mytribe/functions/src/lib/paymentAppliedOwner.ts`, `mytribe/functions/src/notifications/catalog.ts`, `mytribe/functions/src/triggers/onInvoicesWrite.ts`

### D-2026-08-23-FALLBACK-TEMPLATE: Email and push fall back, SMS does not
- Date: 2026-08-23
- Ruling: "if there is going to be a dumbass blocker, then" use a generic fallback. A missing template sends a generic email or push instead of failing. SMS gets no fallback, because of cost.
- Enforced in: `mytribe/functions/src/notifications/fallbackTemplate.ts`, `mytribe/functions/src/notifications/senders/smsChannel.ts`, `mytribe/functions/test/smsChannel.test.ts`

### D-2026-07-15-SENDGUARD-FAIL-OPEN: The send guard fails open
- Date: 2026-07-15
- Ruling: `SEND_SUPPRESS` unset means a real send; `SEND_SUPPRESS=1` suppresses. Every non-prod target must bind it.
- Why: fail-closed would stop every customer notification the first time a prod deploy went out without the variable.
- Enforced in: `mytribe/functions/src/lib/sendGuard.ts`

### D-468-NO-TEMPLATE-SEED: Templates arrive by importer or authoring, never a seed script
- Date: 2026-08-18. Source: #468
- Ruling: "we should have a importer and allow creation of templates in the ui". No step that makes a notification work may be "run the seed script". On 2026-09-13 (#847) email-template seeding was removed outright ("email templates" only); the notification-template importer stays.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/TemplateRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/TemplateImportScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/TemplatesScreen.kt`, `auntieos-admin/src/api/templateImport.ts`

### D-2026-08-18-TEMPLATE-DELETE: The operator may delete templates
- Date: 2026-08-18
- Ruling: "I should be able to delete templates without being yelled at." Warn and name what breaks, then let the delete through.
- Enforced in: `mytribe/functions/src/admin/deleteTemplate.ts`, `mytribe/functions/src/notifications/catalog.ts`, `auntieos-admin/src/screens/TemplateEditor.test.tsx`, `mytribe/functions/test/deleteTemplate.test.ts`

### D-706-NOTIFICATION-CTAS: Fewer notification actions
- Source: #706
- Ruling: "most of these don't need most of these ctas". Notifications carry only the actions that apply.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/NotificationsScreen.kt`, `auntieos-admin/src/lib/notificationActions.ts`, `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/NotificationContextTest.kt`, `auntieos-admin/src/components/NotificationQuickActions.test.tsx`

### D-718-ONE-GATE-ENTRY: One way to the notification gate
- Source: #718. Supersedes an earlier navigation ruling that gave it a rail entry.
- Ruling: there is exactly one way to reach the notification gate; the rail entry is removed.
- Enforced in: `auntieos-admin/src/lib/nav.ts`, `auntieos-admin/src/routes/SettingsView.tsx`, `auntieos-admin/src/lib/nav.test.ts`

### D1-INBOX: The Inbox is message threads only
- Code spells it "product ruling D1". Not O-3 D1.
- Ruling: the Inbox shows message threads. Notifications live on the Notifications screen and do not feed the Inbox badge.
- Enforced in: `auntieos-admin/src/screens/Inbox.tsx`, `auntieos-admin/src/screens/Inbox.test.tsx`

### D-2026-09-12-BLASTS-UNDER-COMMUNICATE: Marketing blasts live under Communicate
- Date: 2026-09-12
- Ruling: marketing blasts "should stay with communication". No dashboard tile and no ninth navigation entry.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/Navigation.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AdminDashboardScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicateScreen.kt`, `auntieos-admin/src/router.tsx`

### D-2026-09-13-BLASTS-UNDER-250: Size blasts for about 250 recipients
- Date: 2026-09-13
- Ruling: "250 is just the max I think I'll be ever sending at any time". `MAX_AUDIENCE = 5000` is a constant, not usage. Do not file scale work from code limits alone.

### D-KINTALE-NOT-BROADCAST: KinTale is a format, not a channel
- Ruling: KinTale is one compose format. It is never a broadcast channel.
- Enforced in: `auntieos-admin/src/lib/personalizeCompose.ts`

### D-2026-08-11-CHICAGO: The business runs on America/Chicago
- Date: 2026-08-11
- Ruling: schedules and business hours use America/Chicago. A blank or unparseable zone falls back to it.
- Enforced in: `mytribe/functions/src/lib/businessHours.ts`, `mytribe/functions/src/lib/notificationSchedule.ts`, `mytribe/functions/src/lib/quoteDecision.ts`, `mytribe/functions/src/scheduled/invoiceRemindersCron.ts`

### D-2026-08-23-DATES-ENUMERATED: Visit dates are listed, not summarised
- Date: 2026-08-23
- Ruling: messages list each visit date. They never collapse dates into a span.
- Enforced in: `mytribe/functions/src/notifications/visitDates.ts`, `mytribe/functions/test/assignmentAssignedOnce.test.ts`, `mytribe/functions/test/bookingSeriesConfirmed.test.ts`

### D-700-DECLINE-NO-REASON: Declining a booking needs no reason
- Source: #700
- Ruling: "I DONT OWE KINFOLK A FUCKING REASON". Turning down a booking request asks for no reason.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/scheduling/EnhancedSchedulingViewModel.kt`, `mytribe/functions/src/admin/cancelRequests.ts`, `mytribe/functions/src/admin/rescheduleRequests.ts`, `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/scheduling/EnhancedSchedulingViewModelVisitRequestsTest.kt`

## KinTales and templates

### M18-CHECKED-ONLY: Client KinTales show ticked checklist items only
- Date: 2026-08-23 (ruled "intentional" 2026-08-26). Source: #397. Code spells it "M18".
- Ruling: a client sees only the checked items. An item left undone on purpose must not read as done.
- Enforced in: `auntieos-admin/src/lib/kinTaleChecklist.ts`, `auntieos-admin/src/screens/KinTaleCompose.tsx`, `mytribe/functions/src/portal/getMyKinTales.ts`, `mytribe/src/commonMain/kotlin/com/kinfolk/portal/portal/KinTaleDtos.kt`

### Q3-NO-GHOST-KINTALE: A KinTale nobody wrote never reaches Firestore
- Code spells it "Auntie's Q3" or "the Q3 ruling".
- Ruling: a new KinTale is scaffolded in memory and saved on its first content change.
- Enforced in: `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/kintales/KinTaleAutosaveTest.kt`, `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/kintales/KinTaleDraftSaveTest.kt`

### D-2026-09-10-KINTALE-FROM-KINCARE: A KinTale starts from a Kin Care
- Date: 2026-09-10. Source: #676
- Ruling: a KinTale is only started from a Kin Care session. The profile "New KinTale" entry is removed.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/Navigation.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/KinTaleLogsScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/KinDetailScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/KinfolkProfileScreen.kt`

### D-2026-08-04-GENERATED-DRAFTS: Generated drafts are KinTale drafts
- Date: 2026-08-04
- Ruling: "generated drafts are just drafts of the kintales". They appear in the KinTales Drafts bucket.
- Enforced in: `auntieos-admin/src/api/drafts.ts`, `auntieos-admin/src/lib/kinTaleList.ts`, `auntieos-admin/src/screens/KinTales.tsx`, `auntieos-admin/src/screens/KinTales.test.tsx`

### P2-SHARE-CONTROLS: Share controls on a KinTale
- Code spells it "P2 ruling".
- Ruling: "send them; do not widen" the share payload. Sharing sends expiry, passcode and revoke options, and revoke lives on the featured card.
- Enforced in: `mytribe/web/src/api/kinTalesApi.ts`, `mytribe/web/src/screens/KinTales.tsx`, `mytribe/src/composeUiTest/kotlin/com/kinfolk/portal/screens/kintales/ShareKinTaleModalTest.kt`, `mytribe/web/src/api/kinTalesApi.test.ts`

### D-2026-08-26-GUEST-THREAD: Guests see the comment thread
- Date: 2026-08-26. Source: #624
- Ruling: "Show guests the thread" on shared KinTale pages.
- Enforced in: `mytribe/functions/src/share/getSharedKinTalePage.ts`, `mytribe/functions/src/share/sharedKinTaleComments.ts`

### WALK-2026-08-17-M23: No canned KinTale email message
- Date: 2026-08-17 walk, mark 23
- Ruling: the default email message on a KinTale template is blank, so Auntie writes the story of this visit instead of sending a canned one.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/KinTaleTemplate.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/kintales/KinTaleTemplateEditorViewModel.kt`, `auntieos-admin/src/lib/kinTale/model.ts`, `auntieos-admin/src/lib/kinTaleTemplateEdit.ts`

### D-394-431-TEMPLATE-DEFAULT: KinTale template strings default to empty
- Source: #394, #431
- Ruling: string fields on a KinTale template default to "".
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/kintales/KinTaleTemplateEngine.kt`, `auntieos-admin/web/composeApp/src/commonTest/kotlin/com/tribetails/auntieos/web/KinTaleModelsTest.kt`

### 953-CTRL: Controller rulings on the email editor
- Source: #953
- Ruling: saving an old-format template converts it; the shared email frame uses the neutral variant; the structural guard lives in the editor extensions.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/MarkdownTemplate.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/TemplateBankScreen.kt`, `auntieos-admin/src/components/emailEditor/EmailEditorDialogs.tsx`, `auntieos-admin/src/components/emailEditor/extensions.ts`

### 953-C1: Visual templates can still be dragged to a category
- Ruling: the drag saves through, with an in-flight cue.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/MarkdownTemplate.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/TemplateBankScreen.kt`, `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/data/repository/TemplateRepositoryVisualTest.kt`, `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/TemplateBankCategoryDragSaveTest.kt`

### 953-C2: Conversion warns about what it dropped
- Ruling: format conversion returns non-blocking `warnings` naming what it could not carry over.
- Enforced in: `auntieos-admin/src/api/templatesWrite.ts`, `auntieos-admin/src/components/emailEditor/ConvertCompare.tsx`

### 953-C4: Stored markup round-trips byte-exact
- Ruling: void elements are stored in the sanitizer's form; every seed round-trips byte-exact; lock and unlock emit no update.
- Enforced in: `auntieos-admin/src/components/emailEditor/EmailContentEditor.tsx`, `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/EmailBlockEditTest.kt`, `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/EmailContentRoundTripTest.kt`, `auntieos-admin/src/components/emailEditor/EmailContentEditor.test.tsx`

### 953-C5: Block helpers lock their block
- Ruling: a block helper locks its block, with a round-trip safety net under the visual editor. List items repeat once per entry of a list field.
- Enforced in: `auntieos-admin/src/components/emailEditor/extensions.ts`, `auntieos-admin/src/lib/emailContent.ts`, `auntieos-admin/src/lib/emailRoundTrip.ts`, `auntieos-admin/src/lib/useTemplateEditorSeed.ts`

### 953-C7: The editor callout matches the email
- Ruling: the editor's Callout is styled exactly as the email frame styles it.
- Enforced in: `auntieos-admin/src/components/emailEditor/EmailContentEditor.test.tsx`

### 953-C9: Merge tokens only in href
- Ruling: the server refuses a `{{` merge token in any attribute except `href`.
- Enforced in: `auntieos-admin/src/components/emailEditor/EmailEditorDialogs.tsx`, `auntieos-admin/src/components/emailEditor/EmailEditorDialogs.test.tsx`

### 953-C10: Keep only the processed email image
- Ruling: an email image upload keeps the processed image and discards the original.
- Enforced in: `auntieos-admin/src/api/emailImageUpload.ts`

### 953-C13: An unknown format opens read-only
- Ruling: a stored `format` this client does not know opens read-only, not as the old format.
- Enforced in: `auntieos-admin/src/lib/templateFormat.ts`, `auntieos-admin/src/screens/TemplateEditor.tsx`, `auntieos-admin/src/screens/Templates.tsx`

## Data and migration

### D-2026-08-04-CREATEDAT-PROVENANCE: Migrated records keep their original creation date
- Date: 2026-08-04
- Ruling: "the old data's actual createdAt should be its original creation as in from the old system not the date that it was migrated". `createdAtSource` records where each date came from.
- Supersedes: the 2026-08-01 createdAt ruling, which stamped the ingest date.
- Enforced in: `auntieos-admin/migrate_visit_logs_to_kin_care_reports.py`, `auntieos-admin/src/api/kinTales.ts`, `auntieos-admin/src/lib/createdAtProvenance.ts`, `auntieos-admin/src/screens/KinTales.tsx`

### D-593-VIDEO-STRIP-ASYNC: Video metadata is stripped after upload
- Source: #593
- Ruling: video metadata is stripped asynchronously after upload, and the window before the strip finishes is accepted.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/media/MediaUploadManager.kt`, `auntieos-admin/src/api/mediaUpload.ts`, `auntieos-admin/src/lib/mediaFormat.ts`, `auntieos-admin/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/MediaModels.kt`

### D-2026-08-24-FIELD-HAS-CONSUMER: Every stored settings field is read and editable
- Date: 2026-08-24
- Ruling: every settings field has a consumer, and every field a client decodes has an admin control. A stored-and-unread or decoded-but-uneditable field is a defect ("I need all that was mentioned", #519).
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/BusinessRulesPanels.kt`, `auntieos-admin/src/screens/settings/VisitsTrackingSection.tsx`, `auntieos-admin/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/settings/BusinessRulesPanels.kt`, `auntieos-admin/src/screens/settings/BookingRulesSection.test.tsx`

### D-DEFAULT-IS-HINT: A settings default is a placeholder, never a saved value
- Ruling: a default shows as a placeholder on both clients. It is never written as the field's value.
- Enforced in: `mytribe/web/src/screens/TribeProfile.test.tsx`

### D-SAVE-OR-FAIL-VISIBLY: A save stores or fails visibly
- Ruling: a save either stores the data or shows a failure. It never shows "Saved." over a write that did not happen.
- Enforced in: `mytribe/functions/src/portal/saveTribeProfile.ts`, `mytribe/functions/test/saveTribeProfile.test.ts`

### D-2026-07-31-HOLIDAY-RECURRENCE: Holiday closures recur by their real rule
- Date: 2026-07-31
- Ruling: a US national holiday closure recurs every year by its real rule (eleven one-click presets). It is never a one-off date.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AdminSettingsScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/ClosureRecurrence.kt`, `auntieos-admin/src/lib/closureRecurrence.ts`, `auntieos-admin/src/screens/settings/TimeOffEditor.tsx`

### WALK-2026-08-17-M15: A KinCare type has three columns
- Date: 2026-08-17 walk, mark 15
- Ruling: a KinCare type has a name, a duration and a price. Durations sit in `serviceDurations` beside `serviceRates`; a blank duration writes no key.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/KinCareTypesEditor.kt`, `auntieos-admin/src/api/settings.ts`, `auntieos-admin/src/screens/settings/KinCareRatesEditor.tsx`, `auntieos-admin/src/screens/settings/KinCareRatesEditor.test.tsx`

## UI and design

### D-MOCK-IS-SPEC: The mock is the spec
- Ruling: where code widened behaviour past the mock (for example the Auntie Time window), the narrower mock wins. Mocks are page-specs and ui-ideas; renders under `visual/` are not a design source.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AuntieTimeWindow.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/KinCareSessionsScreen.kt`, `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/AuntieTimeWindowTest.kt`, `auntieos-admin/e2e/cascade.spec.ts`

### D-2026-09-11-GLASS-WORLD: The mock glass world is the default skin
- Date: 2026-09-11. Source: #751
- Ruling: the default skin is the mocks' glass world: gradient, not tint, and DARK, not SYSTEM. The 2026-08-09 selectable-theme spec (admin default, per-account override on every client) stays in scope for parity.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/components/GlassSurface.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/theme/Theme.kt`, `auntieos-admin/scripts/make-icons.mjs`, `auntieos-admin/vite.config.ts`

### D-2026-09-11-SUBTITLES-ARE-TOOLTIPS: No explanatory copy under panel titles
- Date: 2026-09-11. Source: #752, #758
- Ruling: "at most they can be tool tips, otherwise they are making the ui too busy with unneccessary text". A heading is a title and an icon. Values (a count, a date, a name) go on `detail`.
- Refined by: D-2026-09-13-INFO-TIP-ON-TAP
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AdminSettingsScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/KinCareSessionsScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/formschemas/FormSchemaEditorScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/components/DenScreenKit.kt`

### D-2026-09-13-INFO-TIP-ON-TAP: Info tips open on a tap
- Date: 2026-09-13. Source: #829
- Ruling: guidance that used to be a subtitle goes in an info tip (DenInfoTip, KinInfoTip, InfoTip), which opens on a tap.
- Enforced in: `auntieos-admin/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/ui/components/AuntieInfoTip.kt`, `mytribe/src/commonMain/kotlin/com/kinfolk/portal/components/KinInfoTip.kt`, `mytribe/src/commonMain/kotlin/com/kinfolk/portal/screens/tribe/EmergencyContactsCard.kt`, `auntieos-admin/web/composeApp/src/jvmTest/kotlin/com/tribetails/auntieos/web/ui/components/AuntieInfoTipRenderTest.kt`

### D-2026-09-12-SLOW-WAIT: Every wait shows a cue and offers a sync
- Date: 2026-09-12
- Ruling: "nah wait for servers or a tap to sync option if server access is taking too long and any waits/delays/etc need to have some sort of loading icon". Taps stay pessimistic (wait for the server), every wait shows a moving cue, and a slow wait escalates to a tap-to-sync option rather than a dead end.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicateScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicateViewModel.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/components/AuntieComponents.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/components/SlowWait.kt`

### D-2026-08-06-04-CARDS: Entity lists are card grids
- Date: 2026-08-06
- Ruling: "04 CARDS: One rule for list shape". Entity lists render as the card grid.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/TemplateBankScreen.kt`, `auntieos-admin/src/components/EntityCardGrid.tsx`, `auntieos-admin/src/screens/Templates.tsx`, `auntieos-admin/android/app/src/test/java/com/tribetails/auntieos/ui/admin/TemplateCardFieldsTest.kt`

### D-2026-08-08-NO-DISCLOSURE: Forms do not fold fields away
- Date: 2026-08-08
- Ruling: wizards and forms never hide fields behind a disclosure. Mocks draw every field expanded.
- Enforced in: `auntieos-admin/src/components/WizardModal.tsx`, `auntieos-admin/src/routes/FormSchemasView.tsx`, `auntieos-admin/src/screens/FormSchemaEditor.tsx`, `auntieos-admin/src/screens/KinTaleTemplates.tsx`

### D-BACK-BUTTON: Back goes to the last page
- Ruling: "the back btn should go back to the user's last page".
- Enforced in: `auntieos-admin/src/lib/useHistoryBack.ts`

### D-BOOKINGS-NO-TABS: Bookings has no filter tabs
- Ruling: the Bookings screen has no filter tabs. Bulk reschedule asks for a time per visit.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/ScheduleViewScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/scheduling/EnhancedSchedulingViewModel.kt`, `auntieos-admin/src/components/BulkRescheduleDialog.tsx`, `auntieos-admin/src/lib/bookingReschedule.ts`

### D-703-SESSIONS-UI: Sessions follows the mock
- Source: #703
- Ruling: "we are not following the correct ui for" Sessions. The screen follows the mock, including its narrower Auntie Time window.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AuntieTimeWindow.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/KinCareSessionsScreen.kt`, `auntieos-admin/src/lib/sessionFormat.ts`, `auntieos-admin/src/screens/KinTales.tsx`

### D-2026-09-11-ROUTE-MAP: The Auntie Time detail has a basemap
- Date: 2026-09-11. Source: #760
- Ruling: the Auntie Time detail shows the route on a basemap, modelled on the old system's visit report. Arrived, departed and completed are separate events; completed means the office has ruled the visit billable.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/KinCareDetailScreen.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/KinCareRouteMap.kt`, `auntieos-admin/src/api/bookingsWrite.ts`, `auntieos-admin/src/api/sessions.ts`

### D-2026-08-21-PORTAL-BASEMAP: The portal route map has a basemap
- Date: 2026-08-21. Source: #520. Admin twin: D-2026-09-11-ROUTE-MAP
- Ruling: the portal route map draws streets under the route, so a kinfolk sees where their Kin was walked.
- Enforced in: `mytribe/src/commonMain/kotlin/com/kinfolk/portal/components/RouteMap.kt`, `mytribe/web/src/components/RouteMap.tsx`

### D-2026-09-11-SIGNIN-MOCK: The sign-in mock wins
- Date: 2026-09-11. Source: #780
- Ruling: the sign-in card is a kit glass card, as the mock draws it.
- Enforced in: `auntieos-admin/src/styles/tokenUsage.test.ts`

### D-2026-09-10-TZ-IN-PROFILE: Time zone sits in the profile box
- Date: 2026-09-10 walk, mark 36
- Ruling: "Time Zone needs to be in the profile box; not its own block."
- Enforced in: `auntieos-admin/src/screens/Settings.tsx`, `auntieos-admin/src/screens/settings/BusinessProfileSection.tsx`

### WALK-2026-08-17-M16: Weather sits with the business profile
- Date: 2026-08-17 walk, mark 16
- Ruling: the weather setting moved into the account and business profile fields, and both clients show the same set.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AccountSettingsScreen.kt`, `auntieos-admin/src/screens/Account.tsx`, `auntieos-admin/src/screens/Settings.tsx`, `auntieos-admin/src/screens/settings/sections.tsx`

### D-683-ADMIN-NOTES: Admin Notes pin to the bottom
- Source: #683
- Ruling: "Admin Notes should be pin to the bottom", and the panel does not render when empty.
- Enforced in: `auntieos-admin/src/components/AuntieNotesPanel.tsx`, `auntieos-admin/src/components/AuntieNotesPanel.test.tsx`

### D-686-TAG-PILLS: Tags are pills beside the name
- Source: #686
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/directory/KinDetailScreen.kt`, `auntieos-admin/src/screens/KinView.tsx`

### D-692-MEDIA-GRID: The gallery uses the mock's fluid grid
- Source: #692
- Ruling: the gallery grid uses the mock's auto-fill columns.
- Enforced in: `auntieos-admin/src/screens/Gallery.tsx`, `auntieos-admin/src/screens/Media.tsx`

### D-2026-08-26-INTEGRATION-ROWS: Integration rows stay, unbuilt
- Date: 2026-08-26, confirmed 2026-08-29
- Ruling: "i want the ui reminders but until i feel the apps as a whole are in a good place, i am not in a hurry to build out zapier, make, or tasks". The rows stay visible as planned work. This is not a feature flag, so D-FEATURE-FLAGS-FUNCTIONAL does not apply.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/AdminSettingsScreen.kt`

## Platform and clients

### D-2026-09-12-MOBILE-WEB-FIELD-FALLBACK: Mobile web is the field backup
- Date: 2026-09-12
- Ruling: web and Android stay at parity. Mobile web is the fallback when Android fails on the job, and for iOS kinfolk it is the only client. Both PWAs install and run offline, and the service worker falls back to the cached shell after two seconds.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/marketing/MarketingBlastsScreen.kt`, `auntieos-admin/src/api/sessionsWrite.ts`, `auntieos-admin/src/components/AppShell.tsx`, `auntieos-admin/src/components/InstallPrompt.tsx`

### D-805-SIGNOUT-CLEARS-CACHE: Sign-out clears the offline cache
- Source: #805
- Enforced in: `mytribe/web/src/offlineLaunch.test.tsx`, `mytribe/web/src/screens/Schedule.slowWait.test.tsx`

### D-WEB-CLOCKIN-TRACKS: Web clock-in tracks the route
- Ruling: clocking in from the web tracks the visit route, as Android does.
- Enforced in: `auntieos-admin/src/lib/visitTracking.ts`

### D-DESKTOP-PARITY-PAUSED: Desktop gets no new features
- Ruling: desktop parity is paused by owner ruling (`auntieos-admin/CLAUDE.md`). New features target web and Android.
- Confirmed 2026-09-27, consistent with D-2026-08-26-DESKTOP-CONSOLE-FALLBACK: "paused" keeps its plain word, no new features. It does not mean "leave broken"; broken desktop code still gets fixed.
- Enforced in: `auntieos-admin/web/composeApp/src/jvmMain/kotlin/com/tribetails/auntieos/web/data/AuthInterop.jvm.kt`

### D-2026-08-26-DESKTOP-CONSOLE-FALLBACK: Keep the desktop console working
- Date: 2026-08-26. Source: #615
- Ruling: "its good incase the app messes up and i have to do web". Desktop console code that is unreachable today is fixed, never deleted. It is the escape hatch if the app breaks.
- Confirmed 2026-09-27: consistent with D-DESKTOP-PARITY-PAUSED, not in tension with it. "Paused" is about new features; a security gap or a broken path in existing desktop code is fixed regardless. #955 (fixed during the pause) is the case in point: the desktop console silently dropped failed-login reports and password resets, and that gets fixed as a security fix, not read as a new feature.
- Enforced in: `auntieos-admin/web/composeApp/src/jvmMain/kotlin/com/tribetails/auntieos/web/data/JvmFirestoreRest.kt`

### D-RELEASE-PORTAL-ANDROID-PARITY: Both Android apps ship with the web
- Ruling: each operating system has a web app and an Android app, and one release ships all four. Desktop is held off.
- Enforced in: `scripts/release.sh`

### D-2026-09-12-PORTAL-DIRECT-READS: The portal reads Firestore directly
- Date: 2026-09-12
- Ruling: the kinfolk portal gets the admin's direct-read treatment instead of routing every screen through callables. Sequenced after the admin latency work.

## Release and ops

### D-FULL-RELEASE-INCLUDES-ADMIN-FUNCTIONS: A full release ships every codebase
- Date: 2026-08-04, done 2026-09-13 as `release/2026.09.13-92786e7`
- Ruling: a full release sets `RELEASE_INCLUDE_ADMIN_FUNCTIONS=1`, so the AuntieOS `default` and `reconcile` codebases ship with `mytribe`.
- Why: anything behind an `/api/` hosting rewrite keeps running the last deployed code otherwise.
- Enforced in: `scripts/release.sh`, `docs/RUNBOOK.md`

### D-PREDEPLOY-KEEP-ZERO: Skip the pre-deploy prune
- Ruling: every release sets `RELEASE_PREDEPLOY_KEEP=0`.
- Why: batching the functions deploy is what keeps it under the Cloud Run CPU quota; the pre-deploy prune does not help. Step 8 still prunes after verification.
- Enforced in: `scripts/release.sh`, `.github/workflows/nightly-release.yml`

### D-2026-09-14-NIGHTLY-OFF: The nightly release stays off
- Date: 2026-09-14. Source: #850, #851
- Ruling: `NIGHTLY_RELEASE=off`. Releases run by hand from the operator Mac until the hosted runner can authenticate (#851), then `preflight` for a few nights before `on`.
- Enforced in: `.github/workflows/nightly-release.yml`, `docs/RUNBOOK.md`
- Superseded by: D-2026-09-30-RELEASE-SCHEDULE for the schedule. The hosted runner authenticates since 2026-09-30 (#851); the mode is still the operator's to set.

### D-2026-09-30-RELEASE-SCHEDULE: The scheduled release runs Monday and Thursday
- Date: 2026-09-30. Source: #1062
- Ruling: "lets change from nightly to every 3-4 days as I will most likely releasing as needed anyway." The cron is 01:00 UTC Monday and Thursday. The operator is the only tester. `NIGHTLY_RELEASE` still picks `off`, `preflight` or `on`.
- Supersedes: the nightly schedule in D-2026-09-14-NIGHTLY-OFF
- Enforced in: `.github/workflows/nightly-release.yml`, `scripts/nightly-release.test.sh`, `docs/RUNBOOK.md`

### D-2026-08-29-NO-STAGING: One Firebase project, no staging
- Date: 2026-08-29
- Ruling: drop staging, and do not raise it again. `auntieos-ttpc` is the only project. Click-testing happens on the local emulators; the main channel and previews can be walked but never submitted against, because their backend is production.
- Why: a second project doubles the Cloud Run fleet, the bill, and the Twilio, OAuth and reCAPTCHA setup.

### D-2026-08-29-MAIN-CHANNEL: Main publishes to a fixed hosting channel
- Date: 2026-08-29. Source: PR #649
- Ruling: every merge touching a web app publishes main's HEAD to one fixed Hosting channel per app. Merging deploys nothing to production.
- Enforced in: `.github/workflows/main-channel.yml`

### D-2026-09-11-NO-SELF-HOSTED-RUNNERS: CI runs on GitHub-hosted runners only
- Date: 2026-09-11
- Ruling: the self-hosted runners stopped when the repo went public. Do not register or start one. `CI_RUNNER` is deleted.
- Supersedes: the 2026-08-20 self-hosted runner setup and the 2026-08-29 one-runner ruling.
- Enforced in: `.github/workflows/ci.yml`, `docs/runbooks/ci-on-linux.md`

### D-2026-09-14-DESKTOP-CI-DISPATCH-ONLY: Desktop CI runs on dispatch only
- Date: 2026-09-14
- Ruling: "desktop CI not yet". The `kotlin` job runs only on `workflow_dispatch`. A PR touching `composeApp` runs `:composeApp:jvmTest` locally and cites the counts.
- Enforced in: `.github/workflows/ci.yml`

### D-2026-08-22-MERGE-COMMITS: Merge commits, never squash
- Date: 2026-08-22
- Ruling: every PR lands with `gh pr merge --merge`.
- Why: commit messages here carry the reasoning, one per commit. Squashing loses it.

### D-2026-08-18-NO-VISUAL-GOLDENS: No visual goldens
- Date: 2026-08-18
- Ruling: "I want them gone and whatever is creating them. no more goldens until we are where we need to be in development." Do not propose re-recording them.

### D-2026-09-02-CYPRESS-OVER-PLAYWRIGHT: Cypress stays
- Date: 2026-09-02
- Ruling: "I want Cypress tho. I don't trust Playwright rn." Do not port Cypress specs to Playwright or consolidate on Playwright.

### D-2026-09-01-CYPRESS-UI-ONLY: Cypress specs drive and assert from the UI
- Date: 2026-09-01, extended to the portal suite 2026-09-27. Supersedes the 2026-08-27 smoke-only ruling for `auntieos-admin/cypress`, and (2026-09-27) supersedes D-SMOKE-SUITE-SMALL for `mytribe/web/cypress` too.
- Ruling: feature specs are allowed when designed in session. Each drives and asserts through the UI, with assertions that prove an outcome rather than presence or visibility alone; `cy.intercept` is fine for callables and Cloudinary; persistence stays real. Email is smtp2go, not SendGrid. No account-deletion tests.
- The portal Cypress suite (`mytribe/web/cypress`) follows the same rules as the admin suite. There is no separate, smaller rulebook for it.
- Enforced in: `auntieos-admin/src/api/mediaUpload.ts`, `auntieos-admin/cypress/e2e/account-photo.cy.ts`, `auntieos-admin/cypress/e2e/account.cy.ts`, `auntieos-admin/cypress/e2e/email-editor.cy.ts`

### D-SMOKE-SUITE-SMALL: The e2e smoke suite stays small
- Ruling: the smoke suite was kept small on 2026-08-27, after a suite that only checked presence and visibility passed once while nothing underneath it worked, a false green.
- Superseded by: D-2026-09-01-CYPRESS-UI-ONLY (extended 2026-09-27 to `mytribe/web/cypress`). Feature specs are allowed again, admin and portal alike, provided each one proves a real outcome rather than presence or visibility. The dedicated smoke spec stays as one small suite alongside the feature specs; it does not set the rule for the rest of the suite anymore.
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/admin/TemplatesScreen.kt`, `auntieos-admin/cypress/e2e/smoke.cy.ts`, `mytribe/web/cypress/e2e/smoke.cy.ts`, `.github/workflows/ci.yml`

### D-WALK-DUPLICATES-SHOWN: Walk-to-issues shows duplicates
- Ruling: the walk-to-issues tool shows a duplicate issue; it never skips one.
- Enforced in: `scripts/walk-to-issues/index.mjs`, `scripts/walk-to-issues/issues.mjs`

## Architecture records

### ADR-0001: Generated callable contracts
- Record: `docs/adr/0001-generated-callable-contracts.md`
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/InvoiceRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/invoices/InvoiceDetailViewModel.kt`, `auntieos-admin/src/api/bookingsWrite.ts`

### ADR-0002: Invoice writes are callable-only
- Record: `docs/adr/0002-callable-only-invoice-writes.md`
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/Models.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/InvoiceRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/domain/InvoiceActions.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/domain/InvoiceLedgerRow.kt`

### ADR-0003: Booking callables stay out of the generated contracts, for now
- Record: `docs/adr/0003-booking-callables-deferred-from-codegen.md`
- Enforced in: `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/BookingRepository.kt`, `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/KinCareRepository.kt`, `mytribe/functions/scripts/contracts/artifacts.ts`

### ADR-0004: The fleet default returns to cpu 1
- Record: `docs/adr/0004-functions-runtime-shape.md`
- Enforced in: `mytribe/functions/scripts/runtimeOptions/cli.ts`, `mytribe/functions/scripts/runtimeOptions/deployedShape.ts`, `mytribe/functions/scripts/runtimeOptions/model.ts`, `mytribe/functions/scripts/runtimeOptions/types.ts`, `mytribe/functions/src/index.ts`

---

## Not rulings

Three walk marks the code cites read as findings, not decisions, so they have
no entry: WALK-2026-08-17-M3 ("cannot upload media"), WALK-2026-08-17-M10
("why green box when there was a failure") and WALK-2026-08-17-M12 (filed as
"generator down"). A comment citing one of them is describing the bug a fix or
test covers.
