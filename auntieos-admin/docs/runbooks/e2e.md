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

The visual surface also aborts every non-localhost request in
`visual.capture.spec.ts`, and the callable half of that is now redundant. It was
introduced because callables dialled production and failed on the network's
schedule, which made two screenshots of one screen. The pin removes that cause.
The abort is kept, with its comment rewritten, because a golden must not be
decided by anything outside the machine and that is a wider claim than callables:
an absolute-URL `fetch` added later, or a webfont that escapes Vite's bundling,
would each be a slow flake in the screenshots. The production guarantee is the
pin, which holds whether or not a spec remembers to install a route.

The visual surface is also the one place that stubs callables in BULK, and
`e2e/visual/callableStubs.ts` is the worked example to copy from. It is the same
one route as above, registered once in `beforeEach` and dispatching on the
callable's name, and it is installed AFTER the abort so that Playwright's
reverse-order matching gives it the callable port while the abort keeps
everything else. Read it before writing your own: it shows what a stub has to get
right beyond the wire format, which is that the answer must be shaped like the
callable's real contract and must not contradict what the seed wrote. Between
2026-08-01 and 2026-08-04 nobody had stubbed anything there, and nine of the
nineteen captured screens rendered a failed callable in a red `Banner`. Seven of
those pictures were the approved golden.

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
state. It talks plain REST rather than pulling in `firebase-admin`, following
`web/visual/seed-emulator.mjs`, which established that pattern here first.

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
itself (`--list`, twice, once under `VISUAL_CAPTURE=1`) which project claims
each file and fails if any spec file is claimed by none or by two. A spec file
that declares no tests fails it too, for the same reason: it is a file that
executes nothing and passes.

If the screen calls a callable, stub it before the first `goto`, per "Callables
never leave the machine". A spec that skips this fails on
`CallableNotStubbedError` rather than passing against a half-rendered screen.

Workers are pinned to 1 and `fullyParallel` is off. One emulator, one seed, so
parallel workers would race each other's writes and an assertion about a seeded
row would stop meaning anything. Leave it at 1. If the suite gets slow enough to
hurt, the fix is a seed per worker, not a higher worker count.

## The visual harness borrows this one

`web/visual`'s fourth surface (`react`) is a capture-only Playwright project in
this same config, gated behind `VISUAL_CAPTURE=1` and run with
`npm run visual:react`. It reuses the emulators, `auth.setup.ts`'s real-form
login and the saved operator session rather than growing a second credential
path, which is what the Compose `web` surface did and why that one needs a
`.env` nobody has. Its seed, `e2e/seed.visual.ts`, calls this one and then adds
rows, so `seed.ts` keeps the exact database the specs above assert against,
counts included. See `docs/runbooks/visual-regression.md`.

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

The visual capture run does stub all five (`e2e/visual/callableStubs.ts`), and
that changes nothing about this gap. A stub proves the CLIENT renders a given
response; the response was written by hand in this repo, so nothing about the
server is under test either way. What it buys is a screenshot of the widget
rather than of its error panel.

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
determinism back. That was tried once already:
`web/visual/functions-emu/` is the shim the older wasm harness used, and it is
now dead. Its `require` path points seven directories up at
`CascadeProjects/MyTribe`, which the monorepo merge moved and the 2026-07-21
archive renamed, so it resolves to `/Users/sydeast/Projects/Projects/...` and
does not exist. Only `web/firebase.dev.json` still references it. It is left in
place because it belongs to the wasm tree, which this runbook does not own.

None of that cost buys an assertion today, because no spec makes a claim about a
callable's output. Revisit it when one does, and revisit it knowing the trigger
problem is what has to be solved, not the build time.

### Screens

The e2e cases named in Phase 8.1 of the port plan (account, tribal intel,
invoices, booking approval, inbox, widgets) still need writing, and the invoice
one needs Task 5.1's UI to exist first. All of them will need callable stubs.
