# Connecting Stripe

Five steps to connect Stripe and prove it is connected, plus how the webhook treats disputes.

Moved out of `docs/RUNBOOK.md` on 2026-09-28 so the runbook holds only the release procedure. The text is the runbook's, with cross-references repointed at the new files.

## Connecting Stripe

Deploying the code is not connecting Stripe. Three of the five steps below happen
in the Stripe dashboard and none of them can be done, or verified, from this
repo. Stripe was wired but not connected for a long time, and the failure was
**silent in every direction**, so this section exists to make "connected" a thing
you can check rather than assume.

### Why a half-connection looks exactly like a working one

The webhook answers **202** to any event it cannot use: unrecognised type
(`stripeWebhook.ts`, the unhandled-type branch) or unresolvable metadata. Stripe
treats 202 as a successful delivery. So:

- The Stripe dashboard's delivery log reads **100% success**.
- `getIntegrationsHealth` reports Stripe as configured, because it checks that
  secrets are present and deliberately does not probe.
- Nothing is red anywhere.

Meanwhile the household is charged, gets Stripe's receipt, and lands on an
invoice that still says outstanding, and the reminder cron keeps chasing them.
**Do not take a green dashboard as evidence.** Use step 5.

### 1. The secrets, and which mode they are in

Both live in Secret Manager, never in `.env` (see `docs/runbooks/secrets.md` for
why, and for the redeploy trap). Set them from `mytribe/`:

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY --project auntieos-ttpc
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project auntieos-ttpc
```

Check which mode you are actually in, because test-mode keys fail in a way that
looks like nothing happening:

```bash
firebase functions:secrets:access STRIPE_SECRET_KEY --project auntieos-ttpc
```

**Read the middle segment, not the prefix.** `_live_` is production and `_test_`
is test mode, and both `sk_` (secret key) and `rk_` (restricted key) carry that
segment. Stripe now steers new integrations to restricted keys, so an `rk_live_`
is a correct production key and a check that only looks for `sk_live_` calls it
wrong.

`STRIPE_WEBHOOK_SECRET` starts `whsec_` and is **per endpoint**: a secret copied
from a different endpoint fails signature verification on every delivery, which
surfaces as 400s in the dashboard rather than as silence.

#### If it is a restricted key, these are the permissions it needs

A restricted key carries an explicit permission list, and a missing one does not
announce itself. Exactly four Stripe API calls exist in `mytribe/functions/src`,
and this is the whole list:

| Permission | Access | The call that needs it |
|---|---|---|
| Checkout Sessions | write | `stripe.checkout.sessions.create` in `portal/payInvoice.ts:261` |
| PaymentIntents | read | `stripe.paymentIntents.retrieve` in `billing/stripeWebhook.ts:455` and `billing/stripeDispute.ts:360` |
| Charges | read | `stripe.charges.retrieve` in `billing/stripeDispute.ts:399` |
| Balance transactions | read | the `expand: ['latest_charge.balance_transaction']` on that same retrieve at `billing/stripeWebhook.ts:455-456` |

**Balance transactions is the one that fails silently, and it is the one people
leave off.** It is not a call of its own; it is an expansion riding the
PaymentIntent retrieve, and it is how the REAL fee Stripe charged is captured
instead of the published rate. Without the permission the expansion comes back
empty, the retrieve itself still succeeds, and `stripeWebhook.ts` does the
honest thing with nothing: `feeCents` is **omitted from the payments document**
and `feeResolved: false` is written beside it, because a `feeCents: 0` would be
a claim that Stripe charged nothing. The only other signal is one `warn` line,
`stripe.fee.unresolved`. Every payment still applies, the invoice still reads
paid, and the fee column is empty forever. Check for that log line before
believing the fee data.

Two things need **no** permission:

- **Webhook signature verification.** `verifyStripeWebhook`
  (`mytribe/functions/src/lib/stripe.ts:44-52`) calls
  `client.webhooks.constructEvent(rawBody, signatureHeader, secret)`, which is a
  local HMAC against `STRIPE_WEBHOOK_SECRET`. It never reaches Stripe, so an API
  key permission cannot fix a signature failure and a signature failure never
  means the key is under-scoped. The SDK client it goes through is constructed
  with `STRIPE_SECRET_KEY` only because the constructor demands a key.
- **Refunds, Customers, Products and Prices.** Nothing in this codebase writes
  any of them. `payInvoice` builds its line item from inline `price_data`, so no
  Price object is created. Refunds are ignored by the standing ruling (see step
  4). Grant none of these; a key that can refund is a key that can refund by
  accident.

### 2. Redeploy the functions that declare it, and not the rest of the fleet

gcfv2 pins the secret *version* resolved at deploy time. Setting a value and not
redeploying leaves the function reading the old version, or nothing at all on a
first set. This has bitten before.

**The pin is per function, so redeploy per function.** `--only functions:mytribe`
hands the CLI the whole fleet, roughly 285 functions, against a hard 60 mutations
per minute per region (see "The quota that was actually refusing the deploy"). A
full run for one secret costs about half an hour, hits 429s, and can still finish
with a handful of functions failed. Naming the ones that declare the secret costs
under two minutes.

Ask the built artifact which functions those are, rather than grepping. The
`secrets:` arrays are built from spreads of shared constants, so a regex either
misses them or over-matches:

```bash
npm run build:functions                                        # from the repo root
node scripts/declared-secrets.js --by-function STRIPE_SECRET_KEY
```

It prints `FUNCTION<tab>SECRET` pairs. Deploy exactly the names it printed, comma
separated, each carrying the `functions:mytribe:` prefix:

```bash
scripts/safe-deploy.sh mytribe -- firebase deploy \
  --only "functions:mytribe:NAME1,functions:mytribe:NAME2"
```

`STRIPE_WEBHOOK_SECRET` is declared on `stripeWebhook` alone
(`mytribe/functions/src/billing/stripeWebhook.ts:1012`), so rotating the signing
secret is a one-function deploy:

```bash
scripts/safe-deploy.sh mytribe -- firebase deploy --only "functions:mytribe:stripeWebhook"
```

The prefix is not optional: a bare `--only functions:stripeWebhook` matches
nothing and deploys nothing, quietly. If the script cannot answer, because the
build is stale or the name resolves nowhere, deploy the full codebase rather
than guessing a shorter list, and expect the half hour.

**When a full deploy leaves functions failed with 429, retry just those.** The
failures are still serving their previous revision, so this is mixed-version, not
an outage, and a named retry of six functions finishes in a minute and a half.
"A deploy failed partway and left named functions undeployed" under *When
something breaks* has the command that lists them and the check that each one is
serving its **new** revision afterward.

### 3. Register the endpoint

There is no hosting rewrite for the webhook, so it is the bare Cloud Functions
URL:

```
https://us-central1-auntieos-ttpc.cloudfunctions.net/stripeWebhook
```

Stripe Dashboard → Developers → Webhooks → Add endpoint.

A gen-2 deploy prints the Cloud Run form of the same endpoint instead
(`https://stripewebhook-jhpz5ib3tq-uc.a.run.app`). Both route to the same
service and either works here, because Stripe signs the request **body**, not
the URL. Use the `cloudfunctions.net` form anyway: it is what every other doc in
this repo quotes, and it does not change when a service is recreated. For Twilio
the choice is not cosmetic. See `docs/runbooks/twilio-webhooks.md`,
where the URL is part of the signature.

### 4. Subscribe the events the code actually handles

This is the step that makes the difference between correct-but-dormant and
working. The handler recognises exactly these:

| Event | Why |
|---|---|
| `checkout.session.completed` | **The canonical one.** `payInvoice` creates a `mode: 'payment'` Checkout Session, and this is what a completed one emits. |
| `payment_intent.succeeded` | The same payment seen from the PaymentIntent. Both are handled, and a per-PaymentIntent claim at `stripePayments/{id}` makes sure one payment applies **once**. |
| `payment_intent.payment_failed` | Writes the critical audit entry and the `invoice.charge.failed` notification. Without it a declined card is silent. |
| `charge.dispute.created` | A chargeback. Records `stripeDisputes/{id}`, flags the invoice, writes a `critical` audit entry and sends the operator-only `invoice.payment.disputed` notification. Without it the money leaves the balance and the invoice still reads paid, with nothing anywhere saying otherwise. |
| `charge.dispute.closed` | How the operator learns the dispute was won or lost. Updates the same record and flag. |
| `charge.dispute.funds_withdrawn` | The money actually leaving the Stripe balance. Records `fundsState: 'withdrawn'` on the dispute and `disputeFundsState` on the invoice, plus a `critical` `BILLING_PAYMENT_DISPUTE_FUNDS_WITHDRAWN` audit entry. Without it nothing here distinguishes "a dispute was opened" from "the money is gone". |
| `charge.dispute.funds_reinstated` | The money coming back. Same two fields, set to `reinstated`, audited at `info`. |
| `checkout.session.expired` | An abandoned checkout. Clears `pendingCheckoutSessionId` / `pendingAt` off the invoice, and only when the stored id is the one that expired. |

`invoice.paid` and `invoice.payment_failed` are also recognised but **unreachable**:
they need a Stripe Invoice object, and `mode: 'payment'` creates none. Do not
subscribe them expecting anything.

**Do not subscribe `charge.refunded`, `refund.created` or `refund.updated`.** They
are ignored on purpose, per the standing ruling that there are no refunds and an
account balance credit is the only destination for money owed back. The webhook
answers them 202 through a named branch that logs `stripe.refund.ignored`, so a
subscription would buy a log line and nothing else. A dispute is **not** a refund
and is handled: the cardholder's bank imposes it, the operator does not grant it.

Anything else you subscribe is answered 202 and ignored. That is deliberate, but
it means an over-broad subscription buys nothing and hides nothing.

**A chargeback does not un-pay the invoice.** That was decided, deliberately, in
`billing/stripeDispute.ts`, and here is the reasoning so nobody "fixes" it.
The invoice keeps its `paid` status and `amountDue: 0`, and gains
`disputeStatus` / `disputeId` / `disputeAmountCents` / `disputeReason` /
`disputeEvidenceDueByMs` / `disputeHasEvidence` / `disputeEvidencePastDue` /
`disputeEvidenceSubmissionCount` alongside them. Flipping it
back to outstanding would restart the reminder cron against a household over
their own bank's action, and writing a reversing payment row would invent a
repayment nobody made. Where contested money ends up is the operator's call, and
`stripeDisputes/{disputeId}` plus the `critical` activity-log entries are the
record it is contested. If the dispute is later **won**, nothing needs undoing.

**A paid invoice takes no payment** (operator ruling 2026-09-27, docket Q5).
`payInvoice` and `redeemCredit` refuse a paid invoice with "This invoice is
already paid, so it cannot take another payment." (`details.code:
invoice_already_paid`), `getMyInvoices` ships no pay methods for one, and the
invoice PDF prints no "How to pay" once it is paid. When an invoice becomes paid,
the `onInvoicePaidExpireCheckouts` trigger expires every Checkout Session still
open for it (`openCheckoutSessionIds`, recorded in `closedCheckoutSessionIds`).
If a checkout still completes on a paid invoice (the household paid in the
seconds before the expire), the webhook records the charge as an **unapplied**
root `payments/{eventId}` row (`appliedTo: 'unapplied'`, `needsAdminDecision:
true`), adds the event id to the invoice's `unappliedPaymentIds`, writes a
`critical` `BILLING_PAYMENT_UNAPPLIED` audit entry and sends the business-only
`invoice.payment.unapplied` notice. It no longer credits the household account
by itself: account credit happens only when the admin enters an amount (#988),
and there are no refunds. `report:duplicate-checkout-credits` lists the charges
the old branch did credit.

**`disputeStatus` and `disputeFundsState` are two different facts, on purpose.**
`disputeStatus` mirrors Stripe's dispute lifecycle (`needs_response`,
`under_review`, `won`, `lost`): where the contest stands. `disputeFundsState`
(`withdrawn` / `reinstated`, and `fundsState` on the dispute record) says whether
the balance has actually been debited, which is an accounting fact and routinely
disagrees: a dispute sits at `needs_response` for weeks with the money already
gone. The funds events carry **no cents figure of their own**. The sum that
leaves the balance is the disputed amount plus Stripe's dispute fee, and only the
disputed amount is on the Dispute object, so a debit figure here would be wrong
by the fee. Read the real number in the Stripe balance report. Neither field is
ever cleared, for the reason above: the contest did happen.

**`disputeEvidenceDueByMs` is the deadline, and `null` means there is not one.**
Stripe's `evidence_details.due_by` is when evidence must be in to challenge the
chargeback; miss it and the dispute is lost by default, so this is the field a
`needs_response` banner counts down to. It is stored in epoch **milliseconds**,
unformatted, like every other epoch number on these records. The client renders
it in the operator's own timezone, because a date formatted on the server is
formatted in the server's.

`null` is a real and expected value, and **`0` is never stored**. Stripe sends
literal `0` when the cardholder's bank allows no response at all, so a handler
that stored it would date the deadline to 1 January 1970 and show a chargeback
half a century overdue. Both that case and a payload carrying no
`evidence_details` come through as `null`, meaning "no deadline to act on", not
"the deadline was the epoch". A screen showing `null` should say the
deadline is not stated and send the operator to the Stripe dashboard, not start
a countdown. `disputeReason` is Stripe's `reason` (`fraudulent`,
`product_not_received`, `duplicate`, …) mirrored from the dispute record so a
banner can say why. It is passed through **verbatim, with no allowlist**: the
SDK types it as a plain string, Stripe adds categories, and a reason this build
has not seen must reach the operator rather than be dropped or relabelled.

**Has the operator already answered? `disputeEvidenceSubmissionCount` says, and
the deadline cannot.** Two disputes with the same date on them read as the same
banner, and one of them may have been answered a week ago while the other has had
nothing sent at all. The first operator is waiting on Stripe and should be left
alone; the second is days from losing the money by default. Three fields separate
them, mirrored from `evidence_details` on the same lifecycle write:

- `disputeEvidenceSubmissionCount`, Stripe's `submission_count`: how many times
  evidence has actually been filed. **A count of `0` is stored as `0`**, the
  opposite of what `due_by` does with its zero: there the zero is a sentinel for
  "no deadline exists", here it is a measurement, and it is the fact that drives
  the most urgent banner on the invoice. This is the field that means "sent".
- `disputeHasEvidence`, Stripe's `has_evidence`, which says evidence has been
  **staged**, not that it has been submitted. Staged is a saved draft. A dispute
  with `disputeHasEvidence: true` and `disputeEvidenceSubmissionCount: 0` has not
  been answered, and a screen that reads the two as one would stand an operator
  down days before they lose the money.
- `disputeEvidencePastDue`, Stripe's `past_due`, meaning the **last submission
  went in after the due date** and its delivery is not guaranteed. It is not
  "the deadline has passed": Stripe documents it as defaulting to `false` when
  nothing has ever been submitted, so it stays `false` forever for the operator
  who never answered. It does not replace comparing `disputeEvidenceDueByMs`
  against the clock. It adds one state that comparison cannot produce, and only
  that one: you did answer, you answered late, do not assume it landed.

`null` on any of the three means **the payload did not say**, and it is not the
same as `false` or `0`. A screen must not render "no evidence submitted" from a
null; that sentence is an accusation, and the honest reading of a null is that
this record cannot answer the question. Only an absent `evidence_details` or a
wrong-typed value produces one.

All five fields are written on the **lifecycle** events only, exactly like
`disputeStatus`. A funds event carries the whole Dispute object, but the funds
lane orders independently of the lifecycle lane, so a late `funds_withdrawn`
writing them could put a stale deadline back on a dispute that already closed, or
tell an operator who has sent nothing that they already responded.

The funds events deliberately send **no second notification**. The operator was
already pinged by `invoice.payment.disputed` when the dispute opened, minutes
earlier, and is pinged again when it closes; the withdrawal asks nothing new of
them. The loudness lives in the audit entry and an `error`-stream log line
(`stripe.dispute.fundsWithdrawn`).

The `invoice.payment.disputed` notification needs its templates in Firestore
before the email and push copies can render (the in-app copy lands regardless).
**This is no longer a command.** The operator ruled on 2026-08-18: "no, i
shouldn't seed templates at this point, we should have a importer and allow
creation of templates in the ui" (issue #468). Templates are loaded from the
admin, and `npm run seed:notif-templates` is not part of any release procedure.
The script still exists and still reads the same seed directories, but running
it against production replaces whole documents and drops the title, category,
tags and description an operator authored in the Template Bank. The importer
merges the content fields and leaves the rest alone.
The import steps are under "Templates to import after a release" in
`docs/runbooks/after-release.md`.

### 5. Prove it is connected

**Do not skip this.** Every prior signal in this section can be green on a broken
connection. Two collections are written *only* by the webhook and *only* after it
has resolved a real payment:

- `stripeEvents/{eventId}`: one doc per event that got past the metadata gate.
  Dispute events reserve an id here too (`appliedOutcome: DISPUTE_OPENED` /
  `DISPUTE_CLOSED`), and they resolve the household through the PaymentIntent
  rather than the gate, so read `appliedOutcome` before treating a document here
  as proof a payment landed.
- root `payments/{eventId}`: carries a `stripeEventId` field.

Make one real payment through the portal, then check in the Firebase console for
`auntieos-ttpc`:

1. `stripeEvents` has a new document. **If it is empty, nothing has ever gotten
   through**, whatever the Stripe dashboard says.
2. A root `payments` doc exists with `stripeEventId` set, an `amountCents` in
   integer cents, and `feeResolved: true` alongside a `feeCents`.
3. The invoice reads paid, and the household got the `invoice.payment.applied`
   notification.

If 1 fails, the endpoint is not subscribed to the right events or the signing
secret is wrong. If 1 passes and 3 fails, the problem is downstream of delivery
and the logs will name it.

**`feeResolved: false` with no `feeCents` is a different failure from all of
those, and everything else on the checklist still passes.** The payment landed
correctly; only the fee did not resolve. On a restricted key the usual cause is
the missing Balance transactions read permission from step 1. Otherwise it is a
transient Stripe fault on that one retrieve, which the handler swallows on
purpose so a fee lookup can never fail a real payment. `stripe.fee.unresolved`
in the logs separates "it happened once" from "it happens every time", and
every time means the permission.

### Recovering payments taken while disconnected

`payInvoice` has always stamped the Checkout Session with `familyId` and
`invoiceId`, and the metadata gate returns *before* the event id is reserved. So
a payment swallowed while disconnected is recoverable: **resend the historical
`checkout.session.completed` event from the Stripe dashboard** (Developers →
Events → the event → Resend). It applies with amount, fee, audit entry and
notification, exactly as if it had arrived on time.

This is why the fix is not just forward-looking, and it is a better answer than
hand-entering the payments.
