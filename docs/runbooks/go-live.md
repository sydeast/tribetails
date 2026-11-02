# Go-live

The switches that stay off, or stay in test mode, until the business goes live. Each one points at the runbook that holds its steps. This file does not repeat them.

Written 2026-11-01 for #1405, from the ruling on #1279: the live portal paying through Stripe test mode is intended until go-live. The swap below is what stops it being forgotten.

Only switches the repo already records are listed. If you find another, add it here with the file that records it.

## 1. Stripe: swap to live-mode keys

Until this is done, every household payment on the live portal is a Stripe test-mode payment. No real money moves.

Two secrets change, both in Secret Manager:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

Do them in this order.

1. **Set both to live-mode values.** Command and details: `docs/runbooks/stripe.md`, step 1. The signing secret is per endpoint. Take it from the endpoint you register in live mode, not from the test-mode one. A secret from the wrong endpoint fails signature checks on every delivery, which shows as 400s in the Stripe dashboard.
2. **Check the mode.** Read the middle segment of the key, not the prefix. It must say `_live_`. Both `sk_live_` and `rk_live_` are correct production keys. `_test_` means the swap did not happen. Step 1 shows the access command.
3. **If the key is restricted,** it needs the four permissions in the table under step 1. Balance transactions is the one that fails silently.
4. **Redeploy the functions that declare the secrets.** Setting a secret changes nothing until a deploy resolves the new version. `stripe.md` step 2 names the functions and the commands. `STRIPE_WEBHOOK_SECRET` is declared on `stripeWebhook` alone.
5. **Register the webhook in live mode and subscribe the events.** Test-mode and live-mode endpoints are separate in the Stripe dashboard. Steps 3 and 4 of `stripe.md`.
6. **Turn the payment methods on in live mode.** Card must be on. Klarna and Affirm need the dashboard setting as well as the admin toggle. Step 4a of `stripe.md`.
7. **Prove the webhook is connected.** Make one real payment through the portal and check `stripeEvents`, the root `payments` document and the paid invoice, as `stripe.md` step 5 describes. A green delivery log in the Stripe dashboard is not proof. The webhook answers 202 to events it cannot use, and Stripe counts that as success.

The go-live payment is a real charge. Pick an invoice and an amount you are willing to take.

## 2. Household notifications

Households hear nothing from the platform until you open the gate. A release does not open it. This is `docs/RUNBOOK.md`, "After a release", step 5.

To open it, read `docs/runbooks/household-notifications.md` first, then switch on "Send notices to households" and choose a send hour in Settings, Notifications. The value is the `householdNotificationsLive` field on `business_settings/business_settings`. The daily jobs do not run until a send hour is chosen, so there are two locks.

The gate exists so a data re-upload cannot trigger reminders about old invoices. The reasoning is in the runbook. Open it only when that is no longer a risk.

## 3. Twilio: forwarding on the public business number

The repo records that this is not done. The comment at the top of `mytribe/functions/src/twilio/twilioVoice.ts` says the four Voice secrets in Secret Manager were placeholders and the production number's forwarding was not set up, so "Press 3" live connect has not been verified against a real call. Check the current state before you rely on that comment.

The repo does not record the forwarding steps themselves, so none are listed here. What it does record:

- The number's "A call comes in" webhook must point at the Twilio voice function, and the Voice secrets must be real values. Neither lives in the repo.
- Inbound SMS, voicemail and call webhooks are activated and proved with `docs/runbooks/twilio-webhooks.md`.
- Secrets are set and redeployed as in `docs/runbooks/secrets.md`.

## 4. Mapbox: URL restriction on the web token

The web portal map uses a URL-restricted public token. The mobile token is unrestricted on purpose, because Mapbox answers mobile SDK requests with 403 when a URL restriction is set.

The design in `docs/superpowers/specs/2026-08-21-kinfolk-real-map-design.md` records the hosts the web token is restricted to: `kinfolk.tribetails.com` and `auntie.tribetails.com`. Confirm in the Mapbox account that the token your build uses lists the hosts you actually go live on. If the live hosts differ, add them to the restriction.

The build variable `PORTAL_WEB_MAPBOX_PUBLIC_TOKEN` must hold the restricted token, never the unrestricted mobile one. Why, and how CI previews get it: the Mapbox trap paragraph in `docs/runbooks/secrets.md`.

The repo cannot show what the Mapbox account holds. Look at the account.
