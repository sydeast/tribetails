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

## What is here (Phase 1)

- `/signin` sign-in (enter submits, show/hide password, friendly inline errors,
  password-reset email with the mockup's toast states)
- `/claim?invite=<id>` invite-claim funnel (also parses legacy `#/claim/<id>`
  and `/claim/<id>` link forms)
- `/account/secure-reset?oobCode=...&email=...` flagged-reset flow (signed out,
  hits the public `confirmSecureReset` endpoint)
- `/home` placeholder shell: renders `getMyHome` displayName, shows the
  launch-error screen on failure, and the add-to-home-screen helper
- Typed API for `getMyAccess`, `getMyHome`, `getInvitePreview`,
  `claimInviteSignup`, `acceptInvite` (`src/api/`); the remaining callables are
  listed in `src/api/callables.ts` for Phase 2/3

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

## Deploy (later)

Not wired yet. The build output in `dist/` is static and can go to Firebase
Hosting on the same project. Before first deploy: confirm the hosting domain
is in the Auth authorized domains and in the functions' CORS allowlist
(`functions/src/lib/cors.ts`), then point the invite and reset email links at
the new URLs.
