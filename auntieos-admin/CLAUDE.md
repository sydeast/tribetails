## NON-NEGOTIABLE #1: FULLSTACK ON ALL THREE PLATFORMS, OR IT IS NOT DONE

Backend IS in scope and IS reachable. Everything is in ONE repo now: the
AuntieOS React admin, Kotlin tree, functions, android app and visual harness
under `auntieos-admin/`, and the MyTribe portal and its Cloud Functions under
`mytribe/`. The MyTribe Cloud Functions are at `mytribe/functions/`, a sibling
prefix in this same repository.

A feature is DONE only as a full vertical slice, delivered on EVERY platform:
  backend (MyTribe Cloud Function) + validation + frontend wiring + routes +
  component + error handling + tests (unit, integration, e2e, happy + sad +
  negative + error)
  on the React admin (`src/`) AND ANDROID. Desktop parity is paused by owner
  ruling, and the wasm admin is superseded, so neither is a delivery target.

A missing callable means BUILD the callable. It is NEVER a reason to stop,
defer, or ship frontend-only. There is NO "gate dark / Not-wired banner" option
for our own code.

The ONLY thing you may ever defer is something needing an EXTERNAL SECRET the
operator must physically provide (third-party OAuth client IDs, calendar
provider keys). For those: STOP and name the exact secret. Nothing else.

Do not invent repo/scope/platform blockers. If you think something is blocked,
assume your default is wrong: re-check, then build it — backend + web + desktop
+ android + tests.

---

## RULING R1: A KINCARE SESSION COVERS EVERY KIN IN THE HOME

The operator, repeatedly: *"all KinCare sessions covers ALL KIN in the family …
KinCare rarely is split between the Kin in a home. IE. kinfolk has a dog and a
cat. The KinCare will always care for both the dog and cat. I wouldn't go into a
home and care for one kin while ignoring the other."* So all Kin is the DEFAULT
and takes zero interaction on every surface; narrowing to a subset is an explicit
opt-in behind a control ("Choose specific Kin"), never an unticked picker
labelled "Kin on this booking". A booking is never conceptually for one Kin
unless someone deliberately narrowed it, an empty `kinIds` never meant "nobody",
and nothing may persist that emptiness: `mytribe/functions/src/lib/kinRoster.ts`
materializes the household roster at write time, so `kinIds`/`kinNames` on a
booking, visit or session are always explicit and every reader can just render
them. The reference implementation is the Kinfolk portal's wizard
(`mytribe/web/src/screens/BookingWizard.tsx`); match it rather than reinventing.

---

## DESIGN AUTHORITY: TWO SOURCES, AND RENDERED PNGS ARE NEITHER

When you need to know what a screen should look like, read these, in this order:

1. `page-specs/*.md`, 31 numbered specs, each with an archived/live banner.
   Start at `00-INDEX.md` (spec to screen) and `00-DEPENDENCIES.md`. These are
   TRACKED as of 2026-08-06 and are present in every clone and worktree. They
   were gitignored until then, which is why older notes tell you to reach for an
   absolute path; you no longer need to.
2. `ui-ideas/*.html`, the operator's mockups. Two rules that are not optional:
   anything under `ui-ideas/WrongUIDesigns-UpdateKill/` is a REJECTED design and
   must never be built from, and a filename carrying a directive
   (`...-cardsShouldOpenDisplayingFullerDetails.html`) means that directive is
   part of the spec.

   TRACKED as of 2026-08-06, and therefore PUBLIC. The HTML was scrubbed of six
   real client identities before being committed, so **a new mock must not carry
   a real client name, address, or phone number.** Use the fictional households
   already in the set (the Wrens, Devlins, Sparrows, Mercers, Rowans, Mallorys)
   and a 555 phone number.

   The IMAGES are still gitignored: `ui-ideas/**/*.png` cannot be scrubbed by
   find-and-replace, and one of them is a third-party product screenshot. They
   exist on the operator's disk only. If a task depends on one, say so rather
   than assuming the folder is empty.

Both paths are this tree's only. The Kinfolk portal keeps its own mockups in
`mytribe/ui-ideas/` and has no page-specs; see `mytribe/CLAUDE.md`. A portal
screen is never answered from here.

`visual/mockups/` is Playwright output rendered from source 2 at some past
moment. It is never itself a design source. On 2026-08-01 the operator deleted it
along with `visual/baselines/`, because both held the pre-ruling concept round and
captures of the superseded Compose app, and agents kept building from them. The
harness stays; `web/visual/manifest.json` now lists only screens whose mockup is
live, with the withdrawn ones under `pendingRemock`.

`visual/baselines/` is populated again and the new contents are trustworthy.
Commit `6bd585c`, the same day, added a fourth capture surface, `react`, and
recorded 19 goldens under `visual/baselines/react/` from captures in
`visual/react/`. Those photograph the React admin that auntie.tribetails.com has
served since 2026-07-20, pinned deterministic (reduced motion, fixed clock, fixed
timezone and locale, every non-localhost request aborted) and byte-identical
across four runs. `web/visual/baseline.mjs:31` carries all four surfaces.

The determinism still holds (re-proved 2026-08-09: three consecutive captures,
one sha256 each, eighteen of nineteen screens at 0.000%). ONE GOLDEN IS OUT OF
DATE, which is a different thing and reads the same from a dirty `git status`.
`visual/react/invoice-detail.png` and `visual/baselines/react/invoice-detail.png`
both photograph the invoice overlay as it was before `a2486f0` made the ledger
tables scroll inside their own box (`src/components/InvoiceLedger.css:132-136`),
so every capture since then overwrites them with the current, correct rendering
and looks like a flake. It is not one. Until an operator either approves the new
picture (`node web/visual/baseline.mjs update react`, moving `visual/react/` and
`visual/baselines/react/` together) or changes the CSS back, expect exactly that
one file to be modified after a capture run, and read a diff on any OTHER screen
as a real regression. Nobody was told sooner because
`npm run visual:react:verify` could not run at all until `pngjs` and
`pixelmatch` were declared in `package.json`.

That changes what the goldens are good for, not what they are. `visual/react/`
answers "what does the shipped admin look like today", which is a regression
question. What a screen SHOULD look like still comes from page-specs, then
ui-ideas. `visual/web/`, `visual/desktop/` and `visual/android/` remain captures
of the superseded Compose app and answer nothing.

A screen with no live mockup does not get one invented. It waits for the operator
re-mock, tracked in `docs/punchlists/PUNCHLIST_2026-07-31-remaining.md` (F1 to F5).

---

## RULING: WHO INVITES WHOM, AND WHAT A PRIMARY CANNOT LOSE

The PRIMARY kinfolk invites the secondary, from MyTribe
(`portal/addSecondaryContact.ts`, the InviteKinfolkCard on `TribeProfile.tsx`).
The admin does not. The admin's only invite is inviting the primary to the
portal, which is `inviteKinfolkToPortal` and the now PRIMARY-only `mintInvite`.
A primary's entitlements (full billing, home access, kin edit, messaging) are
inherent to the role and CANNOT be turned off by anybody: `requirePerm` and
`hasKinfolkPerm` in `mytribe/functions/src/lib/memberGate.ts` both answer for a
PRIMARY before they read `permissions`, so those flags are dead data, and
`setMemberPermissions` refuses a non-SECONDARY target the way
`updateSecondaryPermissions` always has. No surface may render them as toggles;
show them as granted by role (`permissionsFollowRole`, mirrored in
`src/api/members.ts` and the Android `HouseholdMembersViewModel.kt`). Admin
editing a SECONDARY's permissions is legitimate and unchanged. This has been
rebuilt wrong more than once, in both directions, so if a diff has an admin
minting a SECONDARY invite or a switch beside a primary's billing, it is wrong
however plausible the mock looks.

---

Error Handling Philosophy: Fail Loud, Never Fake

Never silently swallow errors. Surface them.
Fallbacks acceptable ONLY when disclosed with a visible banner or warning.
Priority order:
1. Works correctly
2. Fails visibly with clear error
3. Silent degradation (NEVER)

If missing credentials, files, or dependencies:
STOP and ASK. Do not fabricate sample data to continue.

Project Routing Rules (AI + Human)

This repo is the SINGLE AuntieOS source as of 2026-07-21. It absorbed the tree
that used to live under Documents/TribeTails_Docs/Communication/AuntieOS.

- **The live web admin is `src/` (React + Vite + TanStack).** It serves
  auntie.tribetails.com. Build here, and drive this when verifying.
- `web/composeApp/` is Kotlin Multiplatform: shared logic plus the desktop (jvm)
  app. The wasm admin it also builds is SUPERSEDED by `src/` and is not where
  admin features go.
- AuntieOS Android app lives in `android/`. A permanent surface.
- AuntieOS-owned Cloud Functions live in `web/functions/` (Node, Firebase
  codebase `default`) and `web/functions-python/` (codebase `reconcile`).
- MyTribe Cloud Functions (most of the callables this admin invokes) live at
  `mytribe/functions/`, a sibling prefix in THIS repository. In scope. New
  shared callables go there. The Kinfolk portal is `mytribe/web/`.
- Desktop parity is PAUSED by owner ruling. Web plus mobile only.
- `sotu-hosting/` is infrastructure for SOTU/ops hosting and Firebase helper scripts.
- Do not treat `sotu-hosting/` as the primary AuntieOS product web app unless the task explicitly asks for SOTU, hosting, or functions work there.

