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
