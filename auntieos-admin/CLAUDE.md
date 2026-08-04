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
   gitignored, so they exist in the main checkout only and are invisible inside a
   git worktree; use the absolute path rather than concluding they are missing.
2. `ui-ideas/*.html`, the operator's mockups. Two rules that are not optional:
   anything under `ui-ideas/WrongUIDesigns-UpdateKill/` is a REJECTED design and
   must never be built from, and a filename carrying a directive
   (`...-cardsShouldOpenDisplayingFullerDetails.html`) means that directive is
   part of the spec.

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

