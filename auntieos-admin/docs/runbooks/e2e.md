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

## What it covers

| Spec | Project | What it is for |
|---|---|---|
| `auth.setup.ts` | setup | Signs the operator in through the real form, saves the session |
| `typography.spec.ts` | signed-out | Fraunces actually renders, three independent ways |
| `cascade.spec.ts` | signed-out | The two cascade fights, on computed style |
| `signin.spec.ts` | signed-out | Wrong password, kinfolk denial, admin admitted |
| `bookings.spec.ts` | operator | A real authenticated screen: rules, listener, filters, hover |

14 tests, about 19 seconds on an M-series laptop.

The two headline specs were verified by mutation, not by assertion alone. With
`--font-fraunces` put back to `'Fraunces', ui-serif, Georgia, serif`, three of
the four typography tests fail and the metric one reports a Georgia delta of
exactly `0`. With `.bookings__row-main--static:hover` moved back above the rule
it cancels, and with the `.signin__card` opaque fill removed, both cascade tests
fail. If you change these specs, re-run that check. A test for a bug that cannot
fail on the bug is worse than no test, because it retires the worry.

## Ports, and why they are odd

Auth `9399`, Firestore `8385`. Not the Firebase defaults, and not the
`9099`/`8085` pair `web/firebase.json` uses for the wasm tree. An e2e run that
silently attached to a dev emulator somebody left running would read their seed
data and report a green that meant nothing. Distinct ports turn that into a
connection refused.

The dev server is `5174` with `--strictPort --host 127.0.0.1`. Without
`--strictPort`, vite walks to `5175` when `5174` is busy and the specs then
drive whatever app is on `5174`. Without the explicit host, vite binds
`localhost`, which on a dual-stack machine is `::1` only, and every request to
`127.0.0.1` is refused while the banner still says the server started.

## How the app reaches the emulator

`src/lib/firebase.ts` reads `VITE_E2E_EMULATOR`. It is set in exactly one place,
`e2e/playwright.config.ts`'s `webServer.env`. A hosting build never sees it, so
Vite folds the check to a constant false and Rollup drops the whole branch;
`dist/assets/*.js` contains no `9399`, no `8385`, no `VITE_E2E_EMULATOR`. That
was checked by grep, and it should be re-checked if the gate is ever rewritten
to read a runtime value, because a runtime read cannot be folded.

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

Put it in `e2e/`, then add its filename to a project's `testMatch` in
`e2e/playwright.config.ts`. `signed-out` for anything reachable without a
session; `operator` for anything behind the gate, which brings the saved session
with it.

Workers are pinned to 1 and `fullyParallel` is off. One emulator, one seed, so
parallel workers would race each other's writes and an assertion about a seeded
row would stop meaning anything. Leave it at 1. If the suite gets slow enough to
hurt, the fix is a seed per worker, not a higher worker count.

## Not covered yet

Callables. The functions emulator is not started, so nothing here exercises
`createInvoice`, `markInvoicePaid` or any other callable, and no spec drives a
screen whose first paint depends on one. `bookings.spec.ts` works because
`BOOKINGS_QUERY` reads Firestore directly through the client SDK. The e2e cases
named in Phase 8.1 of the port plan (account, tribal intel, invoices, booking
approval, inbox, widgets) still need writing, and the invoice one needs Task
5.1's UI to exist first.
