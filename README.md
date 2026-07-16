# auntieos-admin

The React rebuild of the AuntieOS operator admin. Replaces the Compose/wasm app
currently live at `auntieos-ttpc` (A8 flips hosting; the wasm build stays as the
rollback release for a quiet week, then decommissions).

Owner decision on record 2026-07-10: AuntieOS admin moves to the same
React + Vite + Firebase stack as the MyTribe portal, in its own repo, with a
shared primitives package.

## Where things are

| | |
|---|---|
| This repo | `/Users/sydeast/Projects/testai/CascadeProjects/auntieos-admin` |
| Reference implementation | `../MyTribe/web` (React 19, Vite 6, TanStack Router/Query, 277 tests) |
| Backend | `../MyTribe/functions`. Already ~90% built. AuntieOS calls 52 of its callables. |
| Live wasm app being replaced | `/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web` |
| Findings + plan | that tree's `docs/AUNTIEOS_DEVELOPMENT_PLAN_2026-07-16.md` |

`/Users/sydeast/Projects/Deployed/` is READ-ONLY ARCHIVAL. Read from it, never
write to it.

## The spec is the code, not the docs

`docs/2026-05-31-den-redesign-design.md` and the 39 mockups in `ui-ideas/` were
last touched 2026-05-28/31. Every one of the 179 commonMain source files has
changed since. The design doc even says "warm-dark palette" while the app ships
cream-light by default.

**The live wasm app is the only current spec.** Port from
`web/composeApp/src/commonMain/kotlin/.../theme/` and the 53 `Auntie*` components,
not from the mockups.

## Porting traps found the hard way

1. **Typography weights are overridden after declaration.**
   `AuntieTypography.kt` declares `FontWeight.Bold` for display/headline, but
   `AuntieFonts.kt`'s `rememberDenTypography` copies over it with
   `Normal`/`Medium` when it binds Fraunces. Port the EFFECTIVE values. Pinned in
   `tokens.test.ts`.
2. **`labelSmall` is Spline Mono, not Hanken.** It is the uppercase tracked
   kicker ("THE DEN . HOME"). Every other label is Hanken.
3. **The type scale changes face mid-way.** titleLarge is Fraunces; titleMedium
   is Hanken. Off by one and every card title is wrong.
4. **Compose colors are `0xAARRGGBB`.** Alpha leads. `0xCCF8F6F0` is
   `rgba(248,246,240,0.8)`, not `#CCF8F6`.
5. **`primaryDim` in dark is the UNbrightened brand orange**, not a dim of dark's
   brightened primary. Looks like a bug; is not.

## What this rebuild must fix by construction

From the 2026-07-15 exploratory review of all 18 live screens (AO-10..AO-15 in
the plan doc). These are requirements, not nice-to-haves:

1. **A failed read must never render as a zero, an empty list, or a friendly
   empty state.** The wasm Home showed "Open bookings: 0 / needs a reply" while
   the read was permission-denied. The single most common defect found.
2. **Absent data and unreadable data are different answers.** An empty inbox and
   an unreadable inbox must not look alike.
3. **Error, loading and empty must be mutually exclusive BY CONSTRUCTION.** Today
   Templates renders all three at once, and Tribal Intel stacks an error on top of
   "No Tribal Intel yet". One shared async primitive, not per-screen hand-rolling.
   This is the ONE thing to add rather than port: `Form Schemas` already does it
   right (names the failing callable, offers Retry, suppresses the false empty
   state) and `Home` does none of it, in the same codebase.
4. **Enumerate states, never infer by negation.** The wasm app decides "paid" as
   `!draft && !outstanding`, so an unredeemed -$2000 CREDIT renders as PAID while
   the kinfolk's portal correctly says CREDIT. Import MyTribe's
   `web/src/lib/invoiceFormat.ts`, which enumerates. Do not re-derive it: deriving
   it twice is exactly how the two apps came to disagree about money.
5. **Bound the wait.** The wasm app takes 10-50s to first meaningful state, and
   the FAILURE path is the slowest (50s of skeletons before admitting a read
   broke).
6. **Keep the accessibility tree.** The wasm canvas exposes nothing to screen
   readers and cannot be automated by element. React restores both for free.

## Conventions (mirror `../MyTribe/web`)

- `call()` wrapper with timeout + inline-error mappers (`src/lib/fns.ts` there).
- vitest defaults to `node`; component specs opt into jsdom per-file with a
  leading `// @vitest-environment jsdom`.
- tsconfig is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- No PWA plugin here. MyTribe/web needs one for phones + FCM push; the operator
  admin runs on a desk machine and the wasm app had no service worker either.

## Status

50 tests green, tsc clean.

- `src/styles/tokens.css` full Den token port (brand, light/dark schemes,
  gradients, 15-style type scale, shapes, dims). 19 tests, mutation-checked.
- `src/lib/async.ts` + `src/components/AsyncRegion.tsx` the load-state primitive.
  Requirement 3 above, and the fix for AO-10/AO-13 by construction: error,
  loading, empty and data are mutually exclusive, and `isEmpty` is never even
  consulted while a load is failing, so no screen can render "nothing here yet"
  on top of a failure the way Tribal Intel does today.
- `src/lib/gate.ts` the auth gate, ported from `TestMode.kt`. admin OR test-admin.
- `src/lib/firebase.ts` config, pointed at the real **AuntieOS Web** app.

Next: the app shell (rail + test-mode banner), sign-in, then Home.

## Stale plan items closed while building this

The 2026-07-16 recon in the plan doc is unreliable; five of its claims have now
been disproved by measurement. Verify anything from it before acting:

| Claim | Reality (measured 2026-07-15) |
|---|---|
| ~164 commonMain files / 47K LOC | 179 / 51,096 |
| ~40 shared callables | 52 (49 node + 3 python) |
| "~987 @Test fns" | 2,264 (that figure is exactly the STALE tree's web-only count) |
| AO-7 "functions test coverage ~zero" | 53 passing tests |
| AO-6 "web app never registered; bridge uses an Android appId" | Both `MyTribe Web` and `AuntieOS Web` are registered; the bridge already uses AuntieOS Web. Only the comment above it is stale. |

Root cause: the recon was run against `/Users/sydeast/Projects/Deployed/AuntieOS`,
whose source froze 2026-06-17. See AO-0.

## Run

```
npm install
npm test
npm run dev     # :5174, so it can run beside MyTribe/web on :5173
```
