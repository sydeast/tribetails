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
  ruling and the wasm admin was deleted in #481, so neither is a delivery
  target.

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

## DESIGN AUTHORITY: ui-ideas, AND RENDERED PNGS ARE NOT

**`page-specs/` IS GONE. The operator deleted all 31 files on 2026-08-16.** Do
not go looking for them, and do not recreate them: a spec nobody wrote is not
authority, it is invention. This section used to name them as source 1 and told
you to start at `00-INDEX.md`, which is why the instruction is being retired in
writing rather than quietly edited out.

Plans, code comments and archived handoffs across this tree still cite them by
number ("per page-spec 17"). Those citations are history, not a pointer to a
file you can open. If you genuinely need to read what one said, it is in git at
`c3fe6af` (`git show c3fe6af:auntieos-admin/page-specs/17-invoice-detail.md`),
but treat it as a record of what was once decided, not as current authority.

When you need to know what a screen should look like, read `ui-ideas/*.html`.
Those are the operator's ACTUAL MOCKS for this app, and now the only design
authority in this tree.

Two rules that are not optional: anything under
`ui-ideas/WrongUIDesigns-UpdateKill/` is a REJECTED design and must never be
built from, and a filename carrying a directive
(`...-cardsShouldOpenDisplayingFullerDetails.html`) means that directive is part
of the spec.

TRACKED as of 2026-08-06, and therefore PUBLIC. The HTML was scrubbed of six
real client identities before being committed, so **a new mock must not carry a
real client name, address, or phone number.** Use the fictional households
already in the set (the Wrens, Devlins, Sparrows, Mercers, Rowans, Mallorys) and
a 555 phone number.

The IMAGES are still gitignored: `ui-ideas/**/*.png` cannot be scrubbed by
find-and-replace, and one of them is a third-party product screenshot. They
exist on the operator's disk only. If a task depends on one, say so rather than
assuming the folder is empty.

That path is this tree's only. The Kinfolk portal keeps its own mockups in
`mytribe/ui-ideas/`; see `mytribe/CLAUDE.md`. A portal screen is never answered
from here.

`visual/` is gone, and so is everything that wrote to it. On 2026-08-18 the
operator ruled: "honestly I dont trust the visual goldens. I want them gone and
whatever is creating them. no more goldens until we are where we need to be in
development." That removed the committed golden PNGs on all four surfaces, the
`web/visual/` harness (`baseline.mjs`, `approvals.json`, the capture scripts),
the react capture spec, the Compose and Android screenshot tests, and the CI
gate that compared them.

SO THERE IS NO PICTURE OF THE SHIPPED ADMIN IN THIS REPO. Do not go looking for
one, and do not re-create one. If a task needs to know what a screen looks like
today, run it (`npm run dev`) or read the component. What a screen SHOULD look
like still comes from `ui-ideas/`, which is now the only visual source of any
kind. Appearance regressions are caught by the real-browser e2e specs and by
review, not by a byte comparison.

Do not reintroduce a golden system, a screenshot baseline or a pixel-diff CI job
without an explicit operator instruction. The ruling is standing, not a pause.

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
  app. It used to build a wasm admin too; that was superseded by `src/` and was
  deleted in #481. Desktop is PAUSED, not withdrawn, and the jvm target is also
  the host `:composeApp:jvmTest` runs on. Admin features do not go here.
- AuntieOS Android app lives in `android/`. A permanent surface.
- AuntieOS-owned Cloud Functions live in `web/functions/` (Node, Firebase
  codebase `default`) and `web/functions-python/` (codebase `reconcile`).
- MyTribe Cloud Functions (most of the callables this admin invokes) live at
  `mytribe/functions/`, a sibling prefix in THIS repository. In scope. New
  shared callables go there. The Kinfolk portal is `mytribe/web/`.
- Desktop parity is PAUSED by owner ruling. Web plus mobile only.
- `sotu-hosting/` is infrastructure for SOTU/ops hosting and Firebase helper scripts.
- Do not treat `sotu-hosting/` as the primary AuntieOS product web app unless the task explicitly asks for SOTU, hosting, or functions work there.

