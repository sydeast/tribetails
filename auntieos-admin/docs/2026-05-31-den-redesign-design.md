# AuntieOS Den Redesign — Implementation Design

**Date:** 2026-05-31
**Status:** design approved (pending spec review)
**Scope:** AuntieOS web (`web/`). Android + MyTribe out of scope here.

## Goal

Convert the ~27 AuntieOS web screens to full fidelity against their approved Den
mockups in `ui-ideas/auntieos-*-2026-05-27.html`. Today only the global theme
(Fraunces/Hanken/Spline fonts + warm-dark palette) is applied; per-screen
layouts are still the pre-Den compositions. Design (mockups) was done ~05-27;
implementation is ~1 screen in.

## Non-negotiable guardrails

- No M3 visual components; use `Auntie*` / Den primitives only ([[feedback_no_m3]]).
- No em dashes anywhere ([[feedback_no_em_dashes]]).
- Do NOT author user-facing copy; reuse the mockup's text or leave placeholder TODOs ([[feedback_never_author_user_facing_copy]]).
- Preserve every real data binding, ViewModel, callable, and functional field. Mirror real contracts; mark additions as suggestions ([[feedback_mirror_real_components]]).
- Full-stack parity awareness: this is web-only, but record any contract touched ([[feedback_full_stack_coverage]]).
- Verify the LIVE artifact, not the build exit code ([[feedback_gradle_stale_build_deploys]]); deploy via `wasmJsBrowserDistribution` (NOT `...ProductionWebpack`).

## Phase A — Foundation (before any screen conversion)

### A1. Thin hash router (decided: custom, not a nav library — [[project_routing_decisions]])
- Sync `window.location.hash` <-> the existing `Destination` enum (`ui/shell/NavDestinations.kt`) and detail routes with params (`#/kinfolk/{id}`, `#/invoice/{id}`, `#/kincare/{id}`, etc.).
- Unify the detail screens (currently on separate nav state) into one route model with the top-level `Destination`s.
- On nav -> push hash; on load/`hashchange` -> set current route. jvm/desktop = in-memory no-op.
- Static hosting already serves any path via `**->/index.html`, so no server config needed.
- **This unblocks per-screen deep-link screenshot verification** used in Phase B.

### A2. Component-gap audit + build
- Fan out across all 27 mockups; inventory every distinct UI element.
- Diff against the existing Den library: `GlassSurface`, `AuntieGlass`, `MeshGradient`, `AppShell`, `SectionHeader`, `AuntieTable`, `AuntieButtons`, `PrimaryButton`, `GhostButton`, `BottomBorderField`, `MultilineField`, `SegmentedPicker`, `SortMenu`, `StatusToast`, `ShimmerSkeleton`, `StubBadge`, `AuntieSlider`, `AuntieHoverRow`, `AuntieMotion`, `AuntieSpinner`.
- Build the MISSING shared components first (likely: modal/dialog, chips/tags, tabs, empty-state, avatar, card variants) so screens become pure composition.

## Phase B — Screen conversion

### Mockup -> screen mapping
1:1 by name for ~27 screens (home, communicate, directory, kintale-logs/composer/report/template-editor, schedule, invoices, invoice-detail, payments, inbox, notifications, activity-log, settings, training-documents, template-bank, template-assignment, formschema-list/editor, media-gallery, household-data, kinfolk-edit, kinfolk-profile, kin-detail, kincare-detail, auntie-time, sign-in).
Sub-view mockups (business-hours, create/manage-booking, kincare-types, vet-clinics, invites, members, marketing-blasts, email-creation, user-profile) fold into their parent screens (Settings, Booking, Communicate); exact placement resolved during the audit. `redesign` mockup = index, skip.

### Execution order
1. **Pilot:** convert Home + Directory, build, deploy, user validates the fidelity bar.
2. **Fan out** remaining ~25 in batches of ~6. Each batch: convert -> per-screen code-vs-mockup fidelity review -> clean build -> deploy -> visual spot-check.

### Per-screen workflow
read mockup HTML + current screen .kt -> rewrite Compose with Den components to match layout/spacing/typography/color -> fidelity self-review -> (batch) build.

## Verification
- **Structural (per screen):** agent reads mockup + rewritten Compose, scores gaps. No runtime needed.
- **Visual (per batch, now enabled by A1 routing):** deep-link each converted screen, screenshot via chrome-devtools, compare to mockup. User confirms on the deployed app.
- App is canvas/Skia: visual truth is screenshots, not DOM inspection.

## Risks
- Canvas-Compose cannot 1:1 some CSS-only mockup effects (certain gradients/blurs); approximate with `MeshGradient`/`GlassSurface`, flag any that can't match.
- Retrofitting routing onto hoisted nav state + detail screens: keep it additive to limit regression.
- Large effort (~27 screens, multiple builds/deploys); batch + deploy incrementally so progress is visible and reversible.

## Out of scope
- MyTribe routing (Jetpack Nav) and MyTribe redesign — separate effort.
- Android Den conversion — separate.
- New backend/contract changes — this is presentation only.

---

## List shape: cards, with one named exception

**Added 2026-08-09.** Operator ruling 2026-08-06, `04 CARDS  One rule for list
shape`, prompted by the layout review's finding that Directory, Template Bank
and Vet Clinics browsed a list with a card grid while another screen did not,
"which may be defensible per data type, but should be a deliberate rule rather
than an accident."

### The rule

**A screen that browses a set of PEER ENTITIES renders them as cards in
`EntityCardGrid`** (`src/components/EntityCardGrid.tsx`). Directory, Vet
Clinics and the Template Bank are the entity-browse screens today.

**A single full-width column is for CHRONOLOGICAL FEEDS**, where the reading
order is itself information: Inbox, Activity Log, Schedule, Sessions, and
Bookings within a status section. Reflowing one of those into a grid destroys
the only ordering it has, because a grid is read left to right before it is
read down. These keep their column.

**A sortable table is for a list read down its columns**, where every row
carries the same small fixed field set and the operator's question is
comparative ("which is newest", "who touched this last"). Exactly one screen
qualifies: see the exception below.

The card WIDTH is per screen, not shared. The operator's mocks draw 290px
(Directory), 300px (Vet Clinics) and 310px (Template Bank), so `EntityCardGrid`
takes the number as `minCardWidth` rather than imposing one. Standardizing the
mechanism is the point; rounding three deliberate measurements together would
be a decision none of the mocks made.

### On Android

A phone is one column wide, so "grid" has no analogue there and the rule cannot
be about layout. Android's half of it is that **the item is a card carrying the
same fields the web card carries**, as `AuntieEntityRow` inside a `DenPanel`.
All four admin list screens already used that row; what differed was the
FIELDS, so the Template Bank card gained the description and tags (max 4) its
mock names and the React card had been showing all along.

### The exception: Form Schemas is a table

`src/screens/FormSchemas.tsx` is NOT a card grid, deliberately.

Its four fields are name, version, updated, updated-by: a fixed, uniform,
comparative field set, which is what a table is for. Both design authorities
say so directly:

- The mock, `ui-ideas/auntieos-formschema-list-2026-05-27.html`, draws a table:
  a `.thead` with sortable Name / Version / Updated / Updated-by headers over
  striped `.trow`s, with column weights (3 / 1 / 2 / 2) mirroring the Kotlin.
- `page-specs/26-formschema-list.md` item 2 is titled "Sortable list +
  clickable rows (already real, keep)", and its **Desired** reads: "mock's
  sortable Name/Version/Updated/Updated-by table + New schema action."

Converting it to cards would have put it off both. A card grid is also worse
for this list specifically: it makes four short parallel values impossible to
scan down, and it leaves nowhere to hang a sort.

**Built** (issue #717). `FormSchemas.tsx` renders the real `<table>` the mock
draws: Name / Version / Updated / Updated by columns, each header a sort
control with a caret, Updated selected descending by default, blank
`updatedAt`/`updatedBy` rendering "-" and sorting last, `updatedBy` resolved to
an admin's email via `listBusinessAdmins` when the uid is a known admin. No
`DenPanel` wraps it: the filter box and count chip sit in a controls row under
the screen heading, and Reload sits in its own footer, matching the mock's bare
layout. Android's phone-width analogue is a sort strip above the existing
`AuntieEntityRow` cards (a phone still shows one card per schema, per the
Android rule above; the four fields are unchanged, only their order is now
choosable), plus the same `listBusinessAdmins` email resolution in the row
subtitle.

### Screens still to classify

Four lists ship stacked full-width rows and have not been ruled on. None was
named in the 2026-08-06 ruling, and each needs the feed-or-entity question
answered before it moves:

| Screen | Reads as | Likely |
| --- | --- | --- |
| `KinTales.tsx` | dated tales, newest first | feed, keep rows |
| `Invoices.tsx` | dated invoices with a status | feed, keep rows |
| `TribalIntel.tsx` | entries against a household | undecided |
| `KinTaleTemplates.tsx` (bank list) | peer templates | entity browse, likely cards |

`Invites.tsx` is a fifth case, and a different one. It ships a card grid at
16rem, which is a fourth grid definition, while its own mock
(`auntieos-invites-2026-05-27.html`) draws stacked `.iv` rows in a side column.
Which of those is right needs a ruling before it is consolidated either way,
so this PR left it alone rather than cementing the drift.
