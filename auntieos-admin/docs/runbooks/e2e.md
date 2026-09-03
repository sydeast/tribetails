# E2E Runbook: the Playwright harness against the Firebase emulator (2026-07-25)

The React admin had no browser coverage at all before this. 3270 unit tests run
under jsdom, which has no cascade, no font loading and no layout, and most
screens sit behind Firebase auth and had never been driven by anything but a
human. This harness closes that gap. Config: `e2e/playwright.config.ts`.
Emulator config: `e2e.firebase.json`.

## Run it

```bash
cd auntieos-admin
npm ci
npm run e2e:install     # once per machine: downloads Chromium
npm run e2e
```

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

17 tests. Three consecutive runs each way on an M-series laptop, 2026-08-01:

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
not the `9099`/`8085`/`5001` set `web/firebase.json` uses for the wasm tree. An
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
hook. So the authenticated specs pass the real `isAuntie()` gate. A permissive
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
portal suite is still the two smoke tests.
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
first (`tsc -p cypress`). `e2e:cy:open` is the interactive form. No extra
install step: the browser bundle comes down with `npm ci`.

**The admin suite** (`auntieos-admin/cypress/`) reuses this harness's emulators,
`e2e.firebase.json` and `e2e/seed.ts` rather than forking any of them.
`smoke.cy.ts` is the two-test front door: the app is served and mounts in a
browser, and an operator can sign in and land on `/home` with the rail rendered.
`account.cy.ts` (added 2026-09-01) is the first feature spec, designed in
session before it was written, and it is the shape any further one has to take:
every test asserts a state change on a round trip through the emulator, timed.
A wrong password is refused at the front door with the mapped line. Profile
edit saves through the real `isAuntie()` rules and is read back after a
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
**The portal suite** (`mytribe/web/cypress/`) is the first browser-level test the
portal has ever had. Its ~500 vitest cases all run in jsdom, where the router
never runs and no screen is mounted end to end. Same two tests, same scope.
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

**Callable behaviour, entirely.** No server-side callable logic runs in this
harness. Nothing here exercises `createInvoice`, `markInvoicePaid`,
`transitionBookingStatus`, or any of the other 220 functions `mytribe/functions`
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

Determinism is what decided it. Serving `mytribe/functions` loads all 220
definitions, 18 of which are auth or Firestore triggers, and the emulator wires
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
