# MyTribe web portal

React rebuild of the MyTribe client portal (product: MyTribe, business: Tribe Tails Pet Care).
Replaces the Compose-canvas web app. Same Firebase backend (project `auntieos-ttpc`,
callables in `us-central1`); this directory is the web client only.

## Stack

- Vite + React 19 + TypeScript (strict)
- @tanstack/react-router (history routing) + @tanstack/react-query
- Firebase JS SDK (auth + callables)
- vite-plugin-pwa (installable, no app stores)
- Plain CSS. The design system is extracted from the approved mockups in
  `../ui-ideas/*.html` (shared style block, reused verbatim):
  `src/styles/tokens.css` (palette, gradients, glass, shadows, fonts),
  `src/styles/base.css` (background washes, orbs, glass primitives, buttons),
  `src/styles/auth.css` (guest screens). Fonts are self-hosted via
  @fontsource packages (Young Serif, Bricolage Grotesque, DM Mono); no font
  CDN at runtime.

## Run

```bash
npm install
npm run dev        # dev server
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build locally
npm test           # vitest unit tests
```

## What is here

The portal is well past the Phase 1 shell this section used to describe.
`src/screens/` holds 33 screens and `src/router.tsx` defines 49 route entries,
including Invoices, InvoiceDetail, BookingWizard, BookingDetail, KinTales,
Messages, TribeHub and Account. Read `src/router.tsx` for the current map
rather than a list here, which is what went stale.

The guest funnel, which has its own quirks worth knowing before you touch it:

- `/signin` sign-in (enter submits, show/hide password, friendly inline errors,
  password-reset email with the mockup's toast states)
- `/claim?invite=<id>` invite-claim funnel (also parses legacy `#/claim/<id>`
  and `/claim/<id>` link forms)
- `/account/secure-reset` (and its alias `/account/action`) is the project's
  Firebase email action handler: the `callbackUri` in Identity Toolkit points
  here, so every Firebase auth email lands on it. It handles
  `mode=resetPassword` (a normal reset, no security incident),
  `verifyEmail`, `verifyAndChangeEmail` and `recoverEmail`. The "I did not ask
  for this reset" choice on the reset form is the flagged-reset flow, which hits
  the public `confirmSecureReset` endpoint with only the oobCode.

## Contracts to keep in sync

- `src/api/types.ts` mirrors the handlers in `../functions/src`. Each interface
  cites its source file; change them together.
- Claim funnel: `getInvitePreview` (public) -> `claimInviteSignup` (public,
  returns a custom token because client signup is project-disabled) ->
  `signInWithCustomToken` -> `acceptInvite` (authed; token email must match the
  invite). `acceptInvite` is idempotent only for the uid that claimed it.
- reCAPTCHA: `initializeRecaptchaConfig` must settle before the first sign-in
  (`src/lib/auth.ts` awaits it in every auth call; failures resolve rather than
  block).
- Service worker: navigations are network-first and backend hosts
  (cloudfunctions.net, googleapis.com, firebaseio.com) are never cached. See
  the notes in `vite.config.ts` before changing the caching strategy.

## Deploy

Wired and live. `dist/` goes to Firebase Hosting target `kinfolk_portal`
(`mytribe/firebase.json`, mapped in `mytribe/.firebaserc` to the
`kinfolk-portal` site) at kinfolk.tribetails.com. A second target,
`mytribe_beta` -> `mytribe-kinfolk-beta`, exists for beta builds.

Do not deploy it by hand. The portal ships as step 6 of the production release,
`npm run deploy:bg`; see `docs/RUNBOOK.md`. The single-target escape hatch is:

```bash
scripts/safe-deploy.sh mytribe -- firebase deploy --only hosting:kinfolk_portal
```

Adding a NEW hosting domain still needs it in the Auth authorized domains and
in the functions' CORS allowlist (`functions/src/lib/cors.ts`), with the invite
and reset email links pointed at it.
