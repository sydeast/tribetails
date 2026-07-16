# AuntieOS — Retire n8n into Firebase Functions

**Status:** Proposed · **Date:** 2026-06-10 · **Owner:** Auntie

## The problem

AuntieOS's generation, send, and profile-refresh features currently route through an
n8n instance that runs in Docker on a local Debian server, exposed via a Cloudflare
tunnel at `n8n.tribetails.com`. That server depends on home power and connectivity.
When it loses power, the tunnel drops and **the live app loses core functionality** —
these n8n webhooks are not background automation, they are synchronous endpoints the
web, desktop, and Android apps call and wait on in real time.

The data layer already moved to Firebase (Firestore); the live workflow exports read
and write Firestore, not Baserow. So the only thing still tied to the local server is
**n8n's compute**. Everything it talks to — Firestore, Claude, Twilio, SendGrid — is
already a cloud API. There is no data to migrate; there is only orchestration to move.

## Guiding principle — AuntieOS functionality must be preserved, end to end

This migration changes *where* the logic runs, not *what the app can do*. Every feature
that works today must work identically after cutover, on **all three platforms — web
(Wasm), desktop (JVM), and Android** — per the project's full-vertical-slice rule. The
plan is explicitly designed so that:

- No AuntieOS feature is dropped, degraded, or "temporarily" disabled during the move.
- The request/response contracts the apps depend on stay byte-compatible, so clients
  keep working through cutover.
- n8n stays running as a hot fallback until each replacement function is proven in
  production, so there is never a window where functionality is at risk.
- If anything regresses, we roll back to n8n in one config flip — no data loss, no
  feature loss.

Reliability is the goal, but **not at the cost of capability**. We are not simplifying
AuntieOS; we are making the existing AuntieOS more available.

## Current state (verified against the repo)

The Firebase Functions project at `web/functions/` (Node 22, `firebase-admin` +
`firebase-functions` v2) **already exists and already touches Firestore**:

- `writeDraft`, `getDraft`, `getTrainingDoc` — Firestore I/O the workflows call.
- `sendMessage` — already a Function wired via `firebase.json`
  (`/api/send-message → sendMessage`), but today it merely **proxies** to
  `https://n8n.tribetails.com/webhook/auntie-send-message`. The HTTP entrypoint is on
  Firebase; the logic still lives on the local box.

Three live n8n webhooks remain the orchestration layer:

| Workflow (n8n ID) | Webhook path | What it does |
|---|---|---|
| Auntie OS — Generate (`SIg2KsWn0oyRkSzR`) | `auntie-generate` | Read Firestore context → build prompt → call Claude → write draft → respond |
| Auntie OS — Send Message (`PqlFQHKjoB04rRN2`) | `auntie-send-message` | Route a message over Twilio (SMS), SendGrid (email), or FCM; log to Firestore |
| Auntie OS — Update Profiles (`lYa1YFtBIoTgA0t3`) | `auntie-update-profiles` | Fire-and-forget profile/dossier refresh after a draft |

App clients that must keep working unchanged in behavior:

- **Web + Desktop:** `web/composeApp/src/commonMain/.../data/N8nClient.kt` (shared
  `commonMain`, so one change covers both Wasm and JVM targets).
- **Android:** `android/app/src/main/java/.../data/api/N8nApi.kt`.

## Target architecture

Replace the three n8n webhooks with three `onRequest` Firebase Functions co-located in
`web/functions/`, alongside the Firestore functions they already share. Each new
function runs *inside the same Firebase project as the data*, so Firestore access is
local (admin SDK) — no tunnel, no cross-network auth, no Baserow.

- `auntie-generate` → new `generate` function (Claude call inlined).
- `auntie-send-message` → stop proxying; **inline** the Twilio/SendGrid/FCM routing into
  the existing `sendMessage` function.
- `auntie-update-profiles` → new `updateProfiles` function.

Expose them through `firebase.json` rewrites mirroring the existing
`/api/send-message` pattern (`/api/generate`, `/api/update-profiles`), then repoint the
clients from `n8n.tribetails.com` to the Firebase app domain. The local Debian server
is decommissioned once all three are verified.

## The only legitimate blocker: external secrets

Per the project's rules, the one thing that can't be self-built is third-party
credentials. These already exist (n8n uses them) and must be present in Firebase
Functions secrets before the corresponding function goes live:

- **Anthropic API key** — for `generate`.
- **Twilio** account SID, auth token, and from-number — for SMS in `sendMessage`.
- **SendGrid API key** (and verified sender) — for email in `sendMessage`.

Action: confirm each is loaded via `firebase functions:secrets:set` (or reuse existing
secret bindings — `writeDraft` already uses `N8N_SHARED_SECRET`). Nothing else here is
blocked; everything else we build.

## Migration plan — phased, fallback-protected

Each phase is a full vertical slice: **backend function + input validation + client
wiring (web, desktop, android) + routes + error handling + tests (unit, integration,
e2e; happy, sad, negative, error)**. We migrate one workflow at a time so functionality
is never exposed.

**Phase 0 — Prep.** Load the secrets above into Functions. Confirm `web/functions/`
deploys cleanly. Add a per-endpoint feature flag (env/remote-config) so each client call
can point at "function" or "n8n" without a rebuild. Snapshot current n8n behavior
(request/response samples for happy + error paths) as the conformance fixtures.

**Phase 1 — Send Message (lowest risk; entrypoint already on Firebase).** Inline the
Twilio/SendGrid/FCM routing into `sendMessage`, replacing the `N8N_SEND_URL` proxy. Keep
the exact JSON contract (`{ channel, message_body, kinfolk_id?, recipient_phone?,
recipient_email? }` → same status codes, always `application/json`). Test all channels
plus negative cases (bad channel, empty recipient, unknown kinfolk). Ship behind the
flag, verify in prod, then make it default. No client change needed — the rewrite
already points at the function.

**Phase 2 — Generate.** Build the `generate` function: validate the `GenerateRequest`
contract (`communication_type`, `recipient`, `raw_notes`, optional `tone_hint`,
`max_length`), read Firestore context, build the prompt, call Claude, write the draft
(reuse `writeDraft` logic), return `GenerateResponse` (`generated_copy`,
`communication_type`, `kinfolk_name`, `kinfolk_id`, `draft_id`, `model`) byte-compatibly.
Add `/api/generate` rewrite. Repoint `N8nClient.kt` (covers web + desktop) and
`N8nApi.kt` (android) behind the flag. Test happy + sad (Claude error, missing context,
malformed input) on all three platforms.

**Phase 3 — Update Profiles.** Build `updateProfiles` (fire-and-forget; must not block
the UI). Add `/api/update-profiles` rewrite, repoint both clients. Test that failures
stay non-fatal to the calling flow.

**Phase 4 — Cutover & decommission.** With all three defaulting to Functions and
verified in production for an agreed soak period, remove the n8n host references from
the clients, delete the feature flags, and shut down the local Debian server, Docker
stack, and Cloudflare tunnel. Clean up dead Baserow-era artifacts (`create_n8n_workflows.py`,
the `BASEROW_*` vars in `.env`) that no longer reflect reality.

## Cutover safety & rollback

- n8n stays live and reachable through Phases 1–3; the feature flag lets us flip any
  single endpoint back to n8n instantly if a regression appears.
- Conformance fixtures from Phase 0 are the pass/fail bar — a function is "done" only
  when its responses match n8n's on every captured happy and error path.
- Rollback is a flag change, not a redeploy. No data is touched, so there is nothing to
  restore.

## Verification matrix

Before each phase defaults to Functions:

- **Unit:** validation, prompt building, channel routing, error mapping.
- **Integration:** real Firestore reads/writes; mocked Claude/Twilio/SendGrid.
- **E2E:** the app calls the endpoint on **web, desktop, and android** — happy path plus
  Claude failure, provider failure, malformed input, and unknown-recipient cases.
- **Contract:** response shape and status codes match the n8n fixtures exactly.

## Cost

Effectively zero net new cost. Firebase Functions invocations for this volume sit inside
the free tier; Firestore usage is unchanged. Claude, Twilio, and SendGrid were already
billed directly by n8n's HTTP calls, so those bills don't move. We *remove* the cost and
upkeep of the local server. No managed n8n subscription is needed.

## Open questions

1. Are the Anthropic, Twilio, and SendGrid secrets already in Firebase Functions
   secrets, or do they need to be set from the operator's copies?
2. Is the Functions project under `web/functions/` the canonical backend home, or should
   these land in the MyTribe functions directory referenced in `CLAUDE.md`? (Both deploy
   to the same Firebase project; this only affects file layout.)
   RESOLVED 2026-06: MyTribe/functions/ is canonical.
3. Desired production soak time per endpoint before flipping the default and before final
   server decommission?
