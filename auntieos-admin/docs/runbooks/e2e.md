# E2E Runbook: the Playwright harness against the Firebase emulator (2026-07-25)

The React admin had no browser coverage at all before this. 3270 unit tests run
under jsdom, which has no cascade, no font loading and no layout, and most
screens sit behind Firebase auth and had never been driven by anything but a
human. This harness closes that gap. Config: `e2e/playwright.config.ts`.
Emulator config: `e2e.firebase.json`.

## Run it

```bash
npm ci                  # at the repo root; refused inside auntieos-admin
cd auntieos-admin
npm run e2e:install     # once per machine: downloads Chromium
npm run e2e
```

`npm ci` belongs at the root. `auntieos-admin` is a workspace member with no
lockfile of its own, and its `preinstall` guard refuses an install run there.

`npm run e2e` does three things in order, and the order matters. It type-checks
the specs (`tsc -p e2e`), because Playwright transpiles TypeScript without
checking it and a rotted fixture import would otherwise surface as a confusing
runtime failure. Then it starts the auth and Firestore emulators via
`firebase emulators:exec`. Then Playwright boots its own vite dev server and
runs the suite. Emulators and dev server are both torn down on exit, pass or
fail.

Do not run `npx playwright test` directly. Without the emulators the run dies in
`globalSetup` with a connection refused.

There is no other setup step, and that is a deliberate property rather than an
omission: the harness does not install, build or run `mytribe/functions`. See
"Why the functions emulator is not started" for the measurements behind that.

## What it covers

| Spec | Project | What it is for |
|---|---|---|
| `auth.setup.ts` | setup | Signs the operator in through the real form, saves the session |
| `typography.spec.ts` | signed-out | Fraunces actually renders, three independent ways |
| `cascade.spec.ts` | signed-out | The two cascade fights, on computed style |
| `signin.spec.ts` | signed-out | Wrong password, kinfolk denial, admin admitted |
| `bookings.spec.ts` | operator | A real authenticated screen: rules, listener, filters, hover |
| `no-production-egress.spec.ts` | operator | Nothing in a run leaves the emulator, and an unstubbed callable says so |
| `cascade-bookings.spec.ts` | operator | The `/bookings` half of the cascade fights, on computed style |
| `breadcrumbs.spec.ts` | operator | The Den breadcrumb trail through the real router: which crumbs are links and which are buttons |
| `directory-deeplink.spec.ts` | operator | Directory sub-views are real URLs that survive a reload and unwind on Back |
| `invites.spec.ts` | operator | The invites screen is reachable from the rail and fails loud (no functions emulator, so no rows) |
| `mobile-nav.spec.ts` | operator | Navigation at a 390px phone viewport |
| `phone-layout.spec.ts` | operator | Row grids and invoice overlays at phone width |
| `template-preview.spec.ts` | operator | The Template Bank editor's live preview renders a template |

Specs not named in `SIGNED_OUT_SPECS` (`e2e/playwright.config.ts`) run in the
`operator` project. About 44 tests as of 2026-09-26; `npm run e2e` prints the
current count. The timings below are from when the suite had 17. Three
consecutive runs each way on an M-series laptop, 2026-08-01:

| | Playwright | `npm run e2e` wall |
|---|---|---|
| 14 tests, before | 23.0s / 31.3s / 32.5s | 31.2s / 43.8s / 45.0s |
| 17 tests, after | 34.4s / 37.0s / 40.2s | 42.3s / 45.4s / 48.6s |

Take the medians: about six seconds of Playwright and two of wall clock. Three
runs each because one run proves nothing here. The first pair measured came out
28.6s against 42.7s, a difference three times the real one, purely from what else
the machine was doing.

Roughly ten of the added seconds are the new spec sitting still on purpose. A
test that asserts a request did NOT happen has to outlast the effects and the
retry that would have made it, or it passes for the wrong reason.

The two headline specs were verified by mutation, not by assertion alone. With
`--font-fraunces` put back to `'Fraunces', ui-serif, Georgia, serif`, three of
the four typography tests fail and the metric one reports a Georgia delta of
exactly `0`. With `.bookings__row-main--static:hover` moved back above the rule
it cancels, and with the `.signin__card` opaque fill removed, both cascade tests
fail. If you change these specs, re-run that check. A test for a bug that cannot
fail on the bug is worse than no test, because it retires the worry.

`no-production-egress.spec.ts` was checked the same way. Delete the
`connectFunctionsEmulator` line from `src/lib/firebase.ts` and two of its three
tests fail, the first one printing the ten production POSTs by name.

## Callables never leave the machine

Read this before writing a spec that touches a screen with a callable on it.

`src/lib/firebase.ts` pins the Functions SDK at `127.0.0.1:5399` for the whole
run, and **nothing serves that port**. A callable therefore cannot resolve to a
deployed `us-central1` URL: `_url()` can only produce a loopback address. That is
the guarantee, and it is structural rather than a convention somebody has to
remember.

An unstubbed callable gets a refused connection, which `lib/fns.ts` turns into
`CallableNotStubbedError`, naming the callable and the port. `AsyncRegion` puts
that sentence on screen, so a spec that trips it fails reading like a spec
problem instead of like a backend outage.

If your spec genuinely needs a callable, stub it. It is one route, and it works
because the SDK is dialling localhost:

```ts
await page.route('**/127.0.0.1:5399/**/listSupplies', (route) =>
  route.fulfill({ json: { result: { lowCount: 0, supplies: [] } } }),
);
```

The payload goes under `result`: that is the callable wire format, not an
invention of this harness. `no-production-egress.spec.ts` executes both the
failure and the stub, so the pattern above cannot rot into documentation of
something that no longer works.

`e2e/visual/callableStubs.ts` is the one place that stubs callables in BULK, and
it is the worked example to copy from. It is the same one route as above,
registered once in `beforeEach` and dispatching on the callable's name, and it is
installed AFTER the production abort so that Playwright's reverse-order matching
gives it the callable port while the abort keeps everything else. Read it before
writing your own: it shows what a stub has to get right beyond the wire format,
which is that the answer must be shaped like the callable's real contract and
must not contradict what the seed wrote.

It is named for the visual capture surface it was written for. That surface was
removed with the visual golden system on 2026-08-18; the stubs stayed, because
`phone-layout.spec.ts` drives sixteen callables through them and is an ordinary
member of the `operator` project.

Until 2026-08-01 none of this was true. The emulator branch connected auth and
Firestore and left `functions` alone, so every `httpsCallable` in a run went to
`https://us-central1-auntieos-ttpc.cloudfunctions.net/<name>`. One visit to
`/home` fired ten of them. Nothing came back, for two reasons that were verified
rather than assumed: the emulator mints unsigned `{"alg":"none"}` JWTs, which
deployed callables reject at token verification before any handler runs, and
production's CORS preflight returns no `access-control-allow-origin` for the
dev-server origin. So no production data was ever read or written. But the
traffic was real, the only visible symptom was widgets in their error state on a
screen no assertion looked at, and "it happens to be blocked" is a property of
production's CORS allowlist, which this repo does not own.

## Ports, and why they are odd

Auth `9399`, Firestore `8385`, functions `5399`. Not the Firebase defaults, and
not the `9099`/`8085`/`5001` set `web/firebase.json` declares for its emulators. An
e2e run that silently attached to a dev emulator somebody left running would read
their seed data and report a green that meant nothing. Distinct ports turn that
into a connection refused.

`5399` is the odd one: it is reserved and permanently unserved, and the refused
connection is the point rather than an accident. Do not hand it to anything.

The dev server is `5174` with `--strictPort --host 127.0.0.1`. Without
`--strictPort`, vite walks to `5175` when `5174` is busy and the specs then
drive whatever app is on `5174`. Without the explicit host, vite binds
`localhost`, which on a dual-stack machine is `::1` only, and every request to
`127.0.0.1` is refused while the banner still says the server started.

## How the app reaches the emulator

`src/lib/firebase.ts` reads `VITE_E2E_EMULATOR`. It is set in exactly one place,
`e2e/playwright.config.ts`'s `webServer.env`. A hosting build never sees it, so
Vite folds the check to a constant false and Rollup drops the whole branch;
`dist/assets/*.js` contains no `9399`, no `5399`, no `VITE_E2E_EMULATOR`, no
`connectFunctionsEmulator` and no `CallableNotStubbedError` (re-grepped
2026-08-01). That last one matters: the emulator-only error mapping relabels
`functions/internal`, and a real production outage must not reach an operator
dressed as a test-harness problem. It should all be re-checked if the gate is
ever rewritten to read a runtime value, because a runtime read cannot be folded.

`reuseExistingServer` is `false` on purpose. A dev server that was already
running was started without that variable, so it points at production Firebase,
and the suite would sign in against real data.

## Rules and seed

The emulator loads `web/firestore.rules`, the mirror that
`mytribe/firestore.rules` keeps byte-identical under a test and a pre-commit
hook. So the authenticated specs pass the real `isOwner()` gate. A permissive
stand-in would make every one of them prove nothing, and a third copy of the
rules under `e2e/` would drift.

`e2e/seed.ts` runs once per invocation as `globalSetup`. It wipes both emulators
before writing, because emulator state survives a crashed run and a
double-seeded database reads as a broken assertion rather than as leftover
state. It talks plain REST rather than pulling in `firebase-admin`, a pattern the
older wasm harness's seed script established here first.

Two accounts, checked into `e2e/fixtures/accounts.ts`: an admin carrying
`admin: true`, and a kinfolk carrying the portal's claim shape and no admin
claim. The second one is not decoration. AuntieOS and the MyTribe portal share
one Firebase project, so a kinfolk's portal credentials authenticate here
perfectly well, and the claim check is the only thing that stops them.

The seed writes `status` in mixed casing (`SCHEDULED`, `completed`, `CANCELLED`)
and `startTime` as an ISO string against a real `createdAt` Timestamp, because
that is what production holds. Seeding uniformly would let a server-side
equality filter look correct here and drop real visits in production.

## Adding a spec

Put it in `e2e/`. That is the whole procedure for anything behind the auth gate:
`operator` is the default project and collects every `*.spec.ts` under `e2e/`,
so the file runs with the saved session and no config edit.

Only the exceptions are named. A spec that must run WITHOUT a session goes in
`SIGNED_OUT_SPECS` at the top of `e2e/playwright.config.ts`; that one constant
is both what `signed-out` matches and what `operator` ignores, so the two halves
cannot drift.

This used to be an allowlist per project, and a spec nobody added to it was
collected by NO project: it ran zero times and the suite still reported green.
`npm run e2e` now runs `e2e/spec-coverage.mjs` first, which asks Playwright
itself (`--list`) which project claims each file and fails if any spec file is
claimed by none or by two. A spec file
that declares no tests fails it too, for the same reason: it is a file that
executes nothing and passes.

If the screen calls a callable, stub it before the first `goto`, per "Callables
never leave the machine". A spec that skips this fails on
`CallableNotStubbedError` rather than passing against a half-rendered screen.

Workers are pinned to 1 and `fullyParallel` is off. One emulator, one seed, so
parallel workers would race each other's writes and an assertion about a seeded
row would stop meaning anything. Leave it at 1. If the suite gets slow enough to
hurt, the fix is a seed per worker, not a higher worker count.

## There is no visual capture surface any more

This config used to carry a fourth project, `visual`, gated behind
`VISUAL_CAPTURE=1`, which photographed nineteen screens into git-tracked PNGs for
a pixel comparison. It went on 2026-08-18 by operator ruling, along with the
goldens, the `web/visual` harness and the CI gate. `seed.ts` is now the only
`globalSetup` and every project here runs on the one database. Do not add a
screenshot-comparison project back without an explicit operator instruction.

## The Cypress suites (added 2026-08-16)

There are two Cypress suites, one per web app. Each began as a SMOKE suite: two
tests, proving the app boots in a real browser and that sign-in works, by
operator ruling on 2026-08-27. The admin suite grew past that on 2026-09-01,
under the condition that ruling set: a feature spec is designed in session,
around round trips and their timing, and agreed before it is written. The
portal suite grew the same way on 2026-09-14 (password reset, the Emergency
Contacts card at phone width).
The 2026-08-27 ruling had a diff behind it. The first version walked all 21
admin screens, crawled the portal's links and drove named workflows: 46
assertions that an element was present or visible against 2 that anything
actually happened. A suite shaped like that goes green while a callable times
out and while every screen takes fifteen seconds, because it never asks whether
the app DID anything or how long it took. Those tests were deleted rather than
kept as false comfort, and nothing of that shape comes back.
WHAT THIS LEAVES. Playwright stays narrow and deep: Fraunces renders, two
cascade fights resolve, the gate admits an operator and refuses a kinfolk.
Cypress proves the harness and the front door, and, for the admin, the screens
listed below. A test added to either suite asserts that something changed and
how long it took, or it does not go in.

```bash
npm --prefix auntieos-admin run e2e:cy    # admin
npm --prefix mytribe/web run e2e:cy       # portal
npm run e2e:cy                            # both, from the repo root
```

Each wraps `firebase emulators:exec` the same way `npm run e2e` does, boots its
own vite dev server with `VITE_E2E_EMULATOR` set, and type-checks its specs
first (`tsc -p cypress`). `e2e:cy:open` is the interactive form, and it opens
in Chrome (#1069): Cypress 16 deprecates Electron as a test browser, and the
operator watches specs in Chrome. The headless runs keep `cypress run`'s
default. No extra install step: the browser bundle comes down with `npm ci`.

**The admin suite** (`auntieos-admin/cypress/`) reuses this harness's emulators,
`e2e.firebase.json` and `e2e/seed.ts` rather than forking any of them.
`smoke.cy.ts` is the two-test front door: the app is served and mounts in a
browser, and an operator can sign in and land on `/home` with the rail rendered.
`account.cy.ts` (added 2026-09-01) is the first feature spec, designed in
session before it was written, and it is the shape any further one has to take:
every test asserts a state change on a round trip through the emulator, timed.
A wrong password is refused at the front door with the mapped line. Profile
edit saves through the real `isOwner()` rules and is read back after a
`cy.reload()`, including a name with quotes, an HTML tag and an emoji, which
must come back as text; a blank display name is refused with nothing written;
padding is trimmed. The notifications button changes the route. On the Security
panel: a short new password and a malformed new email leave their buttons
disabled; a wrong current password is refused on both forms and the original
still signs in; a real password change is proven by signing out and back in
with the new one. Values are stamped per run so the file survives being re-run
under `cypress open` against a database the seed did not just wipe. It is also
the first consumer of the `console.error` recorder: an unexpected line on any
of its screens fails the test that visited it.
`my-notifications.cy.ts` (added 2026-09-01) intercepts callables, by operator
ruling the same day. Both sides of My
Notifications are callables, and this harness pins callables at a dead port on
purpose, so the two reads and the save are answered by `cy.intercept` with the
WIRE shape the callable would return, run through the app's real decoders. What
it proves is the screen: a flipped switch is the one field the save sends, an
explicit `false` rather than an absent key; a refused save keeps the draft and
re-arms Save; Discard restores the draft without a round trip; a channel the
business forces cannot be flipped. Persistence is the deployed host's to prove.

`account-photo.cy.ts` (added 2026-09-02, PR #660) drives the Account screen's
Change photo control with a 1x1 PNG. The two hops the emulator does not have,
the `/api/cloudinary/sign-upload` hosting rewrite and Cloudinary itself, are
answered by `cy.intercept`; the `media_files` doc and the `users/{uid}.photoUrl`
write are real, and the reload at the end is what proves them. The returned
URL is a `data:` URI because `Avatar` swaps to initials on an image that fails
to load. Emulator runs only: on a deployed host it would write that URI into
the real e2e admin's profile, so it skips itself under the overrides.
The password test runs ONLY against the fixture admin (`usingFixtureAdmin()` in
`cypress/support/commands.ts`). It rotates the account's password, so an
`after()` hook restores the fixture one over the auth emulator's owner REST
surface (`resetAdminPassword` task, `setPassword` in `e2e/seed.ts`). Under the
deployed-host overrides below it is skipped: a real admin's password rotated by
a spec, with the reset pointed at an emulator that is not there, is an operator
locked out.

Since then the admin suite has grown to 17 spec files (2026-09-26). Besides
the four above: `bookings`, `schedule`, `templates`, `settings`, `packages`,
`gallery`, `kin-view`, `kinfolk-profile`, `household-members`, `auntie-time`,
`email-editor`, `form-schemas` and `notifications`, all under
`auntieos-admin/cypress/e2e/`. Each file's header says what it proves.

**The portal suite** (`mytribe/web/cypress/`) is the first browser-level test the
portal has ever had. Its ~500 vitest cases all run in jsdom, where the router
never runs and no screen is mounted end to end. `smoke.cy.ts` is the two-test
front door; `password-reset.cy.ts` drives the emulator's reset link through to
a new sign-in, and `emergency-contacts-phone.cy.ts` checks the Tribe Profile's
Emergency Contacts card at phone width (#829). 17 cases as of 2026-09-26.
Its emulators are its own, on 9499/8485 with 5499 reserved and unserved
(`mytribe/e2e.firebase.json`), so both suites can run at once without either
seeing the other's seed. Callables are pinned to that dead port and answered by
`cypress/support/callables.ts`, which stubs the ACCESS CHAIN only:
`getMyAccess`, `getMyHome`, `setActiveTribe`, the three the router's guard
cannot get past. Every other callable answers `UNIMPLEMENTED` and its screen
renders a real error state; `unstubbedCallables()` reports which ones, so the
gap shows up in the run log instead of being folded into a green. Fixtures are
typed against `src/api/types.ts`, so a backend shape change breaks
`npm run e2e:cy:tsc` rather than drifting quietly.

The reason both suites stub rather than serve callables is the measurement in
"Why the functions emulator is not started" below. It is the same functions
codebase, so the same 18 triggers would fire on either seed.

Both suites treat `console.error` as a test signal. A React screen that throws
in an effect logs there and would otherwise pass. The allowlists are in each
suite's `cypress/support/e2e.ts`, one entry per HARNESS condition with the
reason written next to it. An entry describing an app behaviour is a bug being
allowlisted.

## The real-services run (added 2026-10-02, #1089)

Operator ruling D3 (2026-10-01): the admin Cypress suite also runs against the
real `mytribe/functions`, the admin's own `web/functions`, and the real outside
services, on releases and not on
pull requests. This is a SECOND harness beside the PR-time one. Nothing above
changes: `npm run e2e:cy` still serves no functions and still pins callables at
the dead port 5399.

```bash
npm ci                                   # repo root, once
npm ci --prefix mytribe/functions        # once; the emulator serves its build
npm ci --prefix auntieos-admin/web/functions   # once; not a root workspace (#1201)
cd auntieos-admin
npm run e2e:real
```

`npm run e2e:real` runs `scripts/e2e-real/run.sh`, which:

1. builds `mytribe/functions` (the emulator serves `lib/`, not `src/`), and
   refuses by name if `web/functions` has no `node_modules`;
2. fills any unset Cloudinary, smtp2go or Google OAuth variable from Secret
   Manager by allowlisted name (`scripts/e2e-real/secret-manager.mjs`, #1264;
   "Where each value comes from" below), then runs
   `scripts/e2e-real/preflight.mjs`, which writes a `.secret.local` into
   each served codebase (`mytribe/functions` and `web/functions`) and refuses
   to start, writing neither, if a Stripe value is
   not a test-mode key (`sk_test_`, `rk_test_`, `pk_test_`, `whsec_`), if any
   Twilio value names a number in the business line's or the private line's
   area code, or if a spec under `cypress/e2e-real/` names Google Calendar
   Disconnect;
3. starts auth (9399), Firestore (8385) and functions (5398) under the project
   id `demo-auntieos-e2e` (`e2e.real.firebase.json`), and runs
   `cypress.real.config.ts` against a dev server pointed at all three. The
   functions emulator serves two codebases, as production does: `mytribe` and
   the admin's `default` (`signCloudinaryUpload`, `generateAuntieCopy`). The
   dev server stands in for `firebase.json`'s two `/api/*` hosting rewrites by
   proxying `/api/cloudinary/sign-upload` and `/api/generate` to those
   functions on 5398 (`scripts/e2e-real/api-proxy.mjs`, #1201). `/api/generate`
   is proxied but no spec calls it: its voice files are gitignored and absent
   from a checkout, so it would answer 500;
4. deletes both `.secret.local` files whatever happened. The file is in `.gitignore` too,
   in case a killed run leaves it behind. The next run replaces a file it wrote
   and refuses to replace one it did not.

It cannot run at the same time as `npm run e2e:cy` or `npm run e2e`: they share
the auth and Firestore ports, and the second one fails on a taken port.

The seed's per-call deadline is raised to 60s for this run
(`E2E_SEED_TIMEOUT_MS`): every seeded account now goes through the real
`beforeSignIn` and `onAuthUserCreate`, and their cold starts took the first
`signUp` past the 10s default on a loaded laptop.

### Why two locks on secrets

The functions emulator reads a function's secrets from `.secret.local`. A key
that is missing or empty there, it fetches from Secret Manager under the
emulator's project id (firebase-tools 15.18.0, `resolveSecretEnvs`). With the
production id and a developer's ADC, that is a production secret handed to a
test. So the project id is a `demo-` id that names no real project, and the
preflight writes every secret each codebase declares (read from their
`__endpoint` metadata: 22 in `mytribe/functions` on 2026-10-02, 5 in
`web/functions` on 2026-10-30) with a non-empty value, so no lookup happens at
all. Either one is enough. The file is per codebase: the emulator reads the one
in the function's own source directory, so each codebase gets a complete one.

Credentials are not hidden from the emulator, and on a developer machine it
warns that it found them. Hiding them does not help: with no Application
Default Credentials, firebase-tools hands the emulator the `firebase login`
account instead. In CI the job authenticates through Workload Identity for the
explicit read in `secret-manager.mjs` only, then revokes gcloud's login,
deletes the credentials file and blanks the variables the auth step set, all
before the emulator boots. That read is the only Secret Manager read in the
run; the two locks above are what keep the emulator from making another.

### Where each value comes from (#1264)

Operator ruling 2026-10-31. D3 already runs Cloudinary, smtp2go and Google
against the production accounts (uploads under `e2e/`, sends to the three test
inboxes only, a separate test calendar), so the run reads those values from
Secret Manager in `auntieos-ttpc`, by explicit name. Stripe and Twilio stay
test-only and are never read from there.

| Variable the run reads | Comes from | Without it |
|---|---|---|
| `E2E_CLOUDINARY_CLOUD_NAME`, `E2E_CLOUDINARY_API_KEY`, `E2E_CLOUDINARY_API_SECRET` | Secret Manager: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Cloudinary specs skip |
| `E2E_SMTP2GO_API_KEY`, `E2E_EMAIL_FROM` | Secret Manager: `SMTP2GO_API_KEY`, `EMAIL_FROM` (the sender the production functions use) | Email specs skip |
| `E2E_GOOGLE_OAUTH_CLIENT_ID`, `E2E_GOOGLE_OAUTH_CLIENT_SECRET` | Secret Manager: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Calendar specs skip |
| `E2E_GOOGLE_CALENDAR_ID`, `E2E_GOOGLE_CALENDAR_REFRESH_TOKEN` | GitHub environment `e2e-real` (operator stores) | Calendar specs skip |
| `TWILIO_TEST_ACCOUNT_SID`, `TWILIO_TEST_AUTH_TOKEN` | GitHub environment `e2e-real` (operator stores); optional `TWILIO_TEST_FROM_NUMBER`, default Twilio's test sender `+15005550006` | Twilio specs skip |
| `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_PUBLISHABLE_KEY` | GitHub environment `e2e-real` (stored 2026-10-02); the portal's pay spec also needs the `stripe` CLI on `PATH` | Stripe specs skip |

**The four values the operator stores**, once, in the `e2e-real` environment
(Settings, Environments, `e2e-real`, Environment secrets):

1. `TWILIO_TEST_ACCOUNT_SID`
2. `TWILIO_TEST_AUTH_TOKEN`
3. `E2E_GOOGLE_CALENDAR_ID`
4. `E2E_GOOGLE_CALENDAR_REFRESH_TOKEN`

The preflight's refusals are unchanged: a Stripe value that is not `sk_test_`,
`rk_test_`, `pk_test_` or `whsec_`, and any Twilio value naming a number in
the 805 or 989 area code, stop the run before anything is written.

**The allowlist** is the `email`, `cloudinary` and `googleCalendar` rows of
`VENDOR_SECRETS` in `scripts/e2e-real/preflight.mjs` (`SECRET_MANAGER_VENDORS`),
read by `scripts/e2e-real/secret-manager.mjs`. Both runs, the workflow and the
two `run.sh` files use that one script. It refuses any other name before gcloud
starts, and its tests fail if a `STRIPE_` or `TWILIO_` name is ever added.

**An E2E_* variable already set wins.** Exported in the shell, or stored in
`e2e-real` under one of the E2E_* names in the first three rows, it is used as
it is and its secret is not read. That is how to point one vendor elsewhere.

**Locally**, `run.sh` reads the unset ones with gcloud's own login
(`gcloud auth login` as an account that can read those secrets). The values are
printed as `export` lines and evaluated by `run.sh`, never written to disk
except into the run's own `.secret.local`. No gcloud, no login, a refused read
or an empty answer leaves the variable unset with the reason printed, and that
vendor skips. `E2E_SECRET_MANAGER=off` skips the read entirely.

**In CI** (`.github/workflows/e2e-real.yml`, both jobs) the job authenticates
through the nightly's Workload Identity (`vars.NIGHTLY_WIF_PROVIDER`,
`vars.NIGHTLY_SERVICE_ACCOUNT`; the provider admits this repository on
`refs/heads/main` only), runs `secret-manager.mjs --github`, which prints
`::add-mask::` for every value before it writes anything else and then exports
them through `GITHUB_ENV`, and drops the credentials before the emulator boots.
Each job, and the nightly's `e2e-real` caller job, holds `id-token: write` for
this. A read that fails prints a warning annotation; the vendor skips and the
job stays green. A Workload Identity failure fails the job. The workflow runs on
`workflow_dispatch` from main and as a `workflow_call` from a release.

A missing vendor is a skip with the variables named in the log, never a pass
and never a red run. The preflight prints which vendors it found.

**How a release reads it (#1193).** The nightly release
(`nightly-release.yml`) calls `e2e-real.yml` for the commit it is about to
ship, before its release job, and that job refuses unless the call came back
green. A called workflow gets no run of its own: its jobs show inside the
nightly's run as `E2E real services / <job>`. `scripts/release.sh` step 0b
then reads the verdict again for the commit, hosted and local alike: the newest
run of `e2e-real.yml` or of a nightly that called it, keeping only the jobs
whose name carries `real services`. Red, still running, skipped, or no run at
all each refuse, with the run and the command to fix it. A vendor with no
secrets stored is not red: its specs skip and the job still passes. The release
also downloads that run's `e2e-real*` artifacts and reads every `verdict.json`
in them (written by the classifier, "The verdict" below): `warn` is printed in
yellow and the release goes on, `stop` refuses even under a green job, and a
run with no file is judged by its jobs alone. For a release by hand, run the
suite on main first and wait for it:

```sh
gh workflow run e2e-real.yml --ref main
gh run watch "$(gh run list --workflow e2e-real.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

`RELEASE_SKIP_CI_GATE=1` skips this read along with CI's, and is for a gate
that cannot be asked, never for one that says no.

### What the specs may and may not do

- Drive and assert from the UI, as in the PR-time suite. Fixtures go in
  through the `upsertDoc` task.
- Any `console.error` fails the test. The allowlist in
  `cypress/support/e2e-real.ts` is shorter than the PR-time one: a refused or
  `internal` callable is a real function failing here, not the dead-port pin.
- Any structured `severity: error` line our functions log during a test fails
  it. This is a harness condition, the server-side twin of the `console.error`
  signal both suites already use, not a spec's assertion. The emulator output
  is teed to `cypress/.real/emulators.log` for it.
- Never press Google Calendar Disconnect. It revokes the grant at Google, and
  the test calendar shares the account and OAuth client with production. The
  preflight refuses a spec that names it, and the support file fails any test
  whose browser reaches the callable.
- Twilio runs on the test credentials only. Nothing is sent, and no number in
  the business or private line's area code may appear anywhere.
- Cloudinary uploads go to an `e2e/` folder emptied after each run, and emails
  go only to the three real test inboxes (`account.cy.ts` sends the reset
  email to e2e-admin@tribetails.com; `account-photo.cy.ts` uploads under
  `e2e/tribetails/user/<uid>/`, the folder the real signer prefixes under the
  `demo-` id (#1202), and destroys what it uploaded).

### Specs today

Every PR-time spec that answers a callable with `cy.intercept` has a
counterpart here (#1195). Each one drives the real handler and its triggers
and asserts the outcome from the UI, almost always after a reload.

| Spec | Counterpart of | What it proves | Vendor |
|---|---|---|---|
| `account.cy.ts` | `account.cy.ts` | The three channel switches come from the functions' catalog; a channel switched on is still on after a reload and on My Notifications; "Sole admin" comes from the real roster; Send reset email really sends | Email, reset test only |
| `account-photo.cy.ts` | `account-photo.cy.ts` | A picked image really uploads to Cloudinary, is written to `users/{uid}.photoUrl`, and loads from Cloudinary after a reload. The signature comes from the admin's real `signCloudinaryUpload` (#1201), proven by the `e2e/` prefix only that signer adds | Cloudinary |
| `bookings.cy.ts` | `bookings.cy.ts` | A real requested envelope is declined with an empty reason (#700) or booked through `manageBookingSeries`; after a reload it has left the queue, and a booking adds one to the Scheduled count; the block settles on its empty line (#698) | none |
| `email-editor.cy.ts` | `email-editor.cy.ts` | A visual template with bold text and a button comes back from `listTemplates` after a reload; the preview is the server's render; Convert (with the server's dropped-image warning) then Save makes a template visual for good, Convert then Leave keeps it old | none |
| `form-schemas.cy.ts` | `form-schemas.cy.ts` | The table sorts the server's rows (#717); an edit through `saveFormSchema` comes back with the version bumped, the time stamped and the editor named | none |
| `gallery.cy.ts` | `gallery.cy.ts` | Delete through `deleteMediaFile` removes the `media_files` row: gone after a reload, counts one lower; Cancel sends nothing | none |
| `household-members.cy.ts` | `household-members.cy.ts` | The #684/#829 layout over the real reads; a secondary kinfolk added through `saveSecondaryKinfolk` is listed after a reload with no portal access, and Remove takes it off | none |
| `invoice-paid-stripe.cy.ts` | (D3 phase 1) | Record payment settles an invoice through `markInvoicePaid` while a real Stripe test checkout is open on it; after a reload it reads paid and says its open payment link was closed | Stripe |
| `kin-view.cy.ts` | `kin-view.cy.ts` | A pet tag survives the `kin/{id}` triggers: on the pet after a full reload, gone after removal | none |
| `kinfolk-profile.cy.ts` | `kinfolk-profile.cy.ts` | The right column order with the real credit reads (#678/#682); a credit given through `giveAccountCredit` is listed after a reload and the balance rose by its amount; an emergency contact saved through the Edit form is on the profile after a reload | none |
| `my-notifications.cy.ts` | `my-notifications.cy.ts` | A channel switched on, or a default-on channel switched off, is stored and read back after a reload; Discard stores nothing; a catalog-required channel is drawn forced | none |
| `settings-integrations.cy.ts` | `settings.cy.ts` (Integrations, #714/#715) | The cards are the server's integration list and a secret the run set reads as set; the Calendar panels open in place and the real connection read settles on Connect. Nothing on the Calendar panel is pressed | none (no network call) |
| `settings-tags.cy.ts` | `settings.cy.ts` (Tags, #713) | `removeBusinessTag` really cascades: the server's count on screen, and after a reload the tag is gone from the Tags list and from the Directory filter | none |
| `templates.cy.ts` | `templates.cy.ts` | The #716 frame over a real list; the stored subject on the card and in the editor; an edit through `saveTemplate` comes back from `listTemplates` after a reload | none |

A vendor spec skips, naming the missing variables in the log, when the run has
no credentials for it. No spec of the twelve sends a text, so none needs
Twilio, and none needs Google Calendar credentials: the Integrations spec reads
the stored connection only.

Four PR-time tests have no counterpart, because each needs a server that can be
told to stall or fail on command: #698's held loading state, #714's held
spinner, My Notifications' refused save, and the account photo's refused
upload. They stay in the PR-time suite only.

### The verdict (D3-e)

A failure caused by our integration stops the release. A vendor outage only
warns. After Cypress, `run.sh` runs `scripts/e2e-real/classify-run.mjs`, which
reads the run's results (`cypress/.real/results.json`, written by the
`after:run` hook in `cypress.real.config.ts`) and the emulator log, and writes
`cypress/.real/verdict.json`:

```json
{ "verdict": "stop" | "warn" | "pass", "reasons": ["..."], "checkedAt": "...",
  "cypressExit": 0, "failures": [...], "statusPages": {...} }
```

A failure counts as an outage only when every vendor error found for it (in
the test's error text, and in our functions' log lines during its spec) is a
5xx or a timeout, and that vendor's status page lists an incident covering
that moment. Everything else stops: a 4xx, an auth error, a vendor error with
no readable status, a failure with no vendor error at all, a spec that did not
load, no results file, or a status page that did not answer. `run.sh` exits 1
on `stop`, and 0 on `warn` and `pass`; on `warn` it prints a WARNING block
naming each failure and its incident. A run that stops before Cypress (port
check, build, preflight) still writes a `stop` verdict. The hosted job does
not upload `verdict.json` yet; uploading it and reading it in the release is
#1193.

Status pages, checked 2026-10-23: Stripe `www.stripestatus.com` (the old
`status.stripe.com` JSON is frozen in 2024), Twilio `status.twilio.com`,
Cloudinary `status.cloudinary.com`, smtp2go `smtp2gostatus.com`, all
Statuspage `/api/v2/incidents.json`; Google Calendar from Google Workspace's
`appsstatus/dashboard/incidents.json`, Calendar incidents only. Any listed
incident counts, even one on a product we do not call: the rule reads the
status page, not our judgement of it.

On exit, whatever the verdict, `scripts/e2e-real/cloudinary-cleanup.mjs`
empties the Cloudinary `e2e/` folder with the `E2E_CLOUDINARY_*` test
credentials: assets by the `e2e/` public-id prefix, assets whose asset folder
is under `e2e`, then the folders. It touches nothing outside `e2e/`. Without
the credentials it prints one `skipped` line. A failed delete is printed and
leaves the exit code as it was.

## The portal's real-services run (added 2026-10-30, #1194)

D3 puts paying an invoice in the portal suite, because kinfolk pay there. The
portal has its own copy of the harness above, in `mytribe/web`:

```bash
npm ci                                   # repo root, once
npm ci --prefix mytribe/functions        # once
cd mytribe/web
npm run e2e:real
```

| Piece | Admin | Portal |
|---|---|---|
| Script | `auntieos-admin/scripts/e2e-real/run.sh` | `mytribe/web/scripts/e2e-real/run.sh` |
| Preflight | `scripts/e2e-real/preflight.mjs` | `scripts/e2e-real/preflight.mjs`, which imports the admin's rules |
| Emulator config | `auntieos-admin/e2e.real.firebase.json` | `mytribe/e2e.real.firebase.json` |
| Project id | `demo-auntieos-e2e` | `demo-mytribe-e2e` |
| Ports (auth, Firestore, functions) | 9399, 8385, 5398 | 9499, 8485, 5498 |
| Specs | `auntieos-admin/cypress/e2e-real/` | `mytribe/web/cypress/e2e-real/` |
| CI job | `admin-real` | `portal-real` |

The portal preflight does not keep its own list of secrets or refusals. It
imports `plan`, `disconnectRisks` and `declaredSecrets` from the admin
preflight, so a refusal added there applies to both runs. Its tests
(`mytribe/web/scripts/e2e-real/preflight.test.mjs`, run by the portal's
`vitest`) check the three refusals through the portal's entry point.

Run one real-services run at a time on a machine. The portal run cannot overlap
`npm run e2e:cy` in `mytribe/web` (they share 9499 and 8485), and the Cloud
Tasks emulator that firebase-tools starts alongside the functions emulator
asks for 9499 by default, so an admin real run can take the portal's auth port.
In CI the two jobs are on separate runners.

### The Stripe webhook forwarder

`payInvoice` only opens a Checkout Session. The invoice turns paid when
`stripeWebhook` receives `checkout.session.completed` or
`payment_intent.succeeded`, and Stripe cannot reach `127.0.0.1`. So when
`STRIPE_TEST_SECRET_KEY` is set and the `stripe` CLI is on `PATH`, `run.sh`:

1. starts `stripe listen --forward-to
   http://127.0.0.1:5498/demo-mytribe-e2e/us-central1/stripeWebhook`, with the
   key in the environment rather than on the command line;
2. reads the `whsec_` signing secret from its output, and exports it as
   `STRIPE_TEST_WEBHOOK_SECRET` before the preflight, which writes it to
   `.secret.local` as `STRIPE_WEBHOOK_SECRET`;
3. stops the forwarder when the run ends. Its output is
   `cypress/.real/stripe-listen.log`.

A key that is not a test key is refused before the CLI ever sees it. The
preflight then reports one more flag, `stripeWebhook`, which is true only with
test keys and a `whsec_` secret both present. The pay spec skips without it
and names the missing piece. CI installs Stripe CLI 1.55.1, checksum-pinned.

### Portal specs today

| Spec | What it proves |
|---|---|
| `invoice-open.cy.ts` | The seeded kinfolk signs in through the real access chain (`getMyAccess`, `getMyHome`, `setActiveTribe`), and the real `getMyInvoices` shows a spec-written invoice as PENDING with its amount due and the card checkout button. Needs no vendor keys, so it runs every time |
| `pay-invoice-stripe.cy.ts` | The kinfolk presses Pay with Credit Card, the real `payInvoice` opens a Stripe test Checkout, the spec pays with `4242 4242 4242 4242` on Stripe's page (`cy.origin`), and after the redirect the invoice reads PAID with no amount due and no pay button, once the forwarded webhook lands. Reloads every 3s for up to 60s. Skips without Stripe keys or the CLI |

The portal seed also writes the household's PRIMARY `members` row, the shape
`acceptInvite` writes, so the real billing gates see a member and not the
legacy fallback. The `clients/{uid}` write is a field-masked merge, because the
real `onAuthUserCreate` writes that document too and may get there first.

On 2026-10-30 a local run with no vendor keys went: `invoice-open` passed, and
the pay spec was pending (skipped, no keys). The pay spec has not run against
Stripe yet. Its first real run is a dispatch of `e2e-real.yml` from main.

## Pointing a Cypress run at a deployed host (added 2026-08-30)

`baseUrl` in `cypress.config.ts` is the emulator (`http://127.0.0.1:5174`) and
stays that way. A deployed run is an OVERRIDE for one invocation, never an edit
to the file: a checked-in prod `baseUrl` means the next person's `npm run e2e:cy`
boots emulators, seeds them, and then drives the live site against them, which is
how a green is earned somewhere nobody meant to look.

The emulator fixture account (`e2e/fixtures/accounts.ts`) exists only in the auth
emulator, so a deployed run also needs a real account. `cy.signIn()` takes both
halves from the environment and falls back to the fixture when neither is set;
setting only one is an error rather than a fallback, because a prod run that
quietly used the fixture would fail at the form and read as an app defect.

```bash
cd auntieos-admin
CYPRESS_baseUrl=https://auntie.tribetails.com \
CYPRESS_E2E_ADMIN_EMAIL=e2e-admin@tribetails.com \
CYPRESS_E2E_ADMIN_PW="$(gcloud secrets versions access latest --secret=e2e-admin-password)" \
npx cypress run
```

WHAT A DEPLOYED RUN COVERS (2026-09-01). `smoke.cy.ts`, and `account.cy.ts`
minus its password block. Anything that changes the account it signs in with,
or that answers a callable with a fixture, skips itself when the run is not
authenticating as the emulator fixture (`usingFixtureAdmin()`): the password
block because a rotated real admin with the REST reset pointed at an absent
emulator is an operator locked out, and all of `my-notifications.cy.ts` because
its intercept pattern matches the emulator's callable path, not
`us-central1-<project>.cloudfunctions.net`, so against prod the real catalog
would come back and every fixture-row assertion would fail on content, and `account-photo.cy.ts`
because it would write a `data:` URI into a real admin's profile. An
unstubbed notifications variant is not written.

No `firebase emulators:exec`, no vite server, no seed. Which is also the limit of
what such a run can assert: the seeded fixtures are not there, so exact-count
assertions and the `SEEDED_BOOKINGS` rows mean nothing against a deployed host.
Navigation and sign-in are the honest scope.

### Provisioning the deployed admin account

One-off, operator-run, because it writes to the live project.

Generate the password into a variable rather than inline in the `--password`
argument: a subshell substitution never shows it, and a password nobody read is
a password nobody can put in Secret Manager.

```bash
cd mytribe/functions
PW="$(openssl rand -base64 24)"

GOOGLE_CLOUD_PROJECT=auntieos-ttpc node scripts/grant-admin-claim.mjs \
  --email e2e-admin@tribetails.com --password "$PW"

printf '%s' "$PW" | gcloud secrets create e2e-admin-password \
  --data-file=- --project=auntieos-ttpc
```

The script creates the account if it is missing and merges `admin: true` into
whatever claims it already has, so it is re-runnable. Secret Manager is the only
place that password lives; it must never reach this repo.

Two consequences of creating any auth user in the live project, neither of them a
problem but both worth knowing before the account turns up in a list somewhere:

- `onAuthUserCreate` writes `clients/{uid}`, so the e2e admin also shows up as a
  client row with no tribe membership.
- That write fires `onClientsWrite` -> `syncKinfolkClaim`, which spreads existing
  claims rather than replacing them (`lib/kinfolkClaim.ts`), so `admin: true`
  survives. DELETING `clients/{uid}` does not: the delete arm calls
  `setCustomUserClaims(uid, null)` and strips every claim the account has. If the
  row is ever cleaned up, re-run the script.

### The sandboxed alternative

A `testTribeId` claim admits a user to the same UI with no `admin` claim, scoped
by firestore rules to one kinfolk household, and MyTribe's `isStaff()` refuses it
on every admin callable (`src/lib/gate.ts` explains why the asymmetry is the
safety property). That is the stronger choice IF the deployed suite ever grows
past navigation into anything that writes, and it needs a sandbox kinfolk doc in
the live project to point at. `admin: true` is what is provisioned today because
the suite is two navigation tests.

## Not covered yet

**Callable behaviour, in this harness.** No server-side callable logic runs in
this harness. The real-services run above (#1089) is where it does. Nothing here exercises `createInvoice`, `markInvoicePaid`,
`transitionBookingStatus`, or any of the other ~280 functions `mytribe/functions`
exports. `bookings.spec.ts` passes because `BOOKINGS_QUERY` reads Firestore
directly through the client SDK, not because any callable works.

Say that plainly when reading a green run. The gap did not open on 2026-08-01 and
the fix did not widen it: before, the callables were dialled and rejected, which
proved nothing about them either. What changed is that the run now tells you so
instead of failing quietly against a backend it should never have been touching.

`/home` is the concrete case. Its five widgets call `listConversations`,
`listExpirations`, `listExpenses`, `listSupplies` and `optimizeRoute`, and in an
ordinary `npm run e2e` every one of them renders `CallableNotStubbedError`.
`signin.spec.ts` lands on that screen and asserts only that sign-in succeeded,
which is all it ever asserted. A spec that wants to make a claim about a widget
must stub its callable first.

`e2e/visual/callableStubs.ts` does answer all five, and that changes nothing
about this gap. A stub proves the CLIENT renders a given response; the response
was written by hand in this repo, so nothing about the server is under test
either way. What it buys is a rendered widget rather than its error panel.

### Why the functions emulator is not started

It was measured rather than argued about, 2026-08-01, and rejected on two counts.

Cost, measured by running it. A throwaway config was pointed at
`mytribe/functions` and booted, so these are observations, not estimates:

| Step | Measured |
|---|---|
| `npm ci` in `mytribe/functions` | 562 packages, 694 MB, 355 top-level entries. 13.5s and 31s on two runs, network-bound |
| `npm run build` (tsc) | 7.7s and 16.0s on two runs |
| Emulator boot, functions + auth + firestore | 16.8s, against 10.6s for auth + firestore alone |

So roughly six seconds of boot per run, plus a 694 MB install and a compile step
that every contributor and every CI job would have to carry. Not fatal on its
own, and it is not what decided this.

Determinism is what decided it. Serving `mytribe/functions` loads all ~285
definitions (2026-09-26), 25 of which are auth, Firestore or blocking triggers, and the emulator wires
them to the same database `e2e/seed.ts` writes. Two fire on today's seed:
`onKinfolkCreate` provisions a `families/{kinfolkId}` envelope off the
`kinfolk/e2e-kf-1` and `kinfolk/e2e-kf-2` writes, and `onAuthUserCreate` fires on
both seeded accounts. The rest are latent rather than safe: `onKinTaleCreate`,
`onKinTaleCommentCreate` and `onFlatKinWrite` are waiting on
`kin_care_reports/`, its `comments/` subcollection, and `kin/`, all of which the
Phase 8.1 specs need the seed to grow into.

The seed would stop being the state the specs assert on, and the harness would
have to grow a shim exporting a curated subset of callables to get its
determinism back. That was tried once already, in `web/visual/functions-emu/`,
and it had been dead for months before it was deleted: its `require` path pointed
seven directories up at a `CascadeProjects/MyTribe` the monorepo merge had moved,
so it resolved to a path that does not exist. It went with the rest of
`web/visual/` on 2026-08-18, together with `web/firebase.dev.json`, the only
file that still named it.

None of that cost buys an assertion today, because no spec makes a claim about a
callable's output. Revisit it when one does, and revisit it knowing the trigger
problem is what has to be solved, not the build time.

### Screens

The e2e cases named in Phase 8.1 of the port plan (account, tribal intel,
invoices, booking approval, inbox, widgets) still need writing, and the invoice
one needs Task 5.1's UI to exist first. All of them will need callable stubs.
