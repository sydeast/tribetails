# MyTribe program wrapup, 2026-06-01

Session paused for usage limits. Build resumes this afternoon. This is the state of
the whole "do all of it" program. Everything on the MyTribe side is verified green.

## Verified green (run these to confirm on resume)

- Kotlin: `./gradlew jvmTest` (BUILD SUCCESSFUL) and web parity `./gradlew compileKotlinJs`
- Rules: `cd functions && npm run test:rules` (59 passing)
- Functions: `cd functions && npm run build && npx vitest run --config vitest.config.ts` (561 passing)

## Shipped + verified (MyTribe)

1. Security: closed the `clients/{uid}` kinfolkIds/familyIds tenant-boundary tamper (Admin SDK only). New `functions/test/rules/clients.test.ts`.
2. Feature flags: `config/FeatureFlags.kt` resolver + `getFeatureFlags` callable + `LocalFeatureFlags`. Global `business_settings/feature_flags` + per-tester `clients/{uid}.featureFlags`.
3. The 8 Suggested mockup items, each flag-gated. Also fixed a latent unmasked-password bug.
4. Removed the TribeScreen kinfolk add-custom-field violation (flag `tribeLegacyCustomFields`, off).
5. Demo seed extended (families, bookings, invoices, schemas, `--link-uid`).
6. Brand fonts bundled (Young Serif, Bricolage Grotesque, DM Mono) via `Res.font`.
7. Schema forms: seeded `account` + `kinProfile`; Account + Kin render via `SchemaFormRenderer`.
8. Invoice fix: repointed the dead nested-path functions to the canonical flat `invoices`, fixed the `payInvoice`/`stripeWebhook` metadata key bug that was silently dropping portal Stripe payments, webhook now marks paid + mirrors `payments/{id}`, plus a backfill.
9. Visual redesign: app-wide `KinfolkBackground` radial wash, Home Tribe-gradient live hero, KinButton/KinGhostButton/KinField/KinChip across all core screens.
10. Booking envelope, MyTribe side: `bookings/{batchId}` + `kinCares` model (functions transaction, `getMyBookings` returns `envelopes[]`, rollup trigger, note paths, back-compat), rules, Kotlin DTOs, BookingEnvelopeScreen + KinCareDetailScreen split, Schedule grouping, backfill. All gated by `mytribe.booking.envelope` (OFF).
11. Pet bridge, MyTribe side: `onFamilyKinWrite` mirrors to flat `kin/` with a symmetric `familyKinPath`/`legacyKinId` link, plus a new `onFlatKinWrite` reverse mirror, with `_mirrorOrigin` loop guards.
12. Routing: migrated to AndroidX Compose Navigation. Type-safe `@Serializable` routes, NavHost, detail screens on the back stack, deep links + browser back/forward + shareable URLs on web. Compiles on jvm, android, js.

## Paused (user direction)

The AuntieOS half of the booking envelope (write-back) and the pet FK is PAUSED until
AuntieOS finishes its own in-flight fixes. Zero AuntieOS files were touched (the patch
agents were stopped before writing). Ready-to-apply spec:
`docs/AUNTIEOS_CROSSAPP_CHANGES.md` (deploy order, lockstep notes).

## Next on resume (task #16, in progress, no edits made yet)

Build the responsive top-nav shell so MyTribe matches the mockup layout. From
`ui-ideas/mytribe-home-2026-05-31.html`:
- Wide (>= 880dp): sticky glass top nav. Wordmark "My" + gradient "Tribe" (Young
  Serif 23px). Link pills Home / Tribe / Schedule / KinTales / Invoices (active = navy
  background, white text; hover = orange tint). Right: notifications bell (42x42 glass,
  radius 13, coral ping dot) + gradient-circle avatar (42, initial) that opens an
  account menu (Account, Notifications, The Kin, Sign Out, plus Back to Directory for
  operators).
- Narrow (< 880dp): slim top bar (wordmark + bell + avatar) + bottom tab bar
  Home / Tribe / Schedule / Tales / Account.
- Kin, Account, Notifications stay reachable (avatar menu + bell), they are not primary
  nav links in the mockup.
- Home body becomes two-column `1.6fr / 1fr` on wide, collapsing to one column under
  880dp (main: Up Next + KinTales; aside: Tribe roster + Quick Start).
This replaces the current drawer + bottom-nav chrome in `nav/TabShell.kt`, driving the
existing `navController`. Keep the routing tests green; verify `jvmTest` + `compileKotlinJs`.

Files to touch: `nav/TabShell.kt` (the chrome), possibly `nav/TabRoute.kt` (nav item
set) and `nav/AppNavHost.kt` (Tribe as a primary destination), `screens/home/HomeScreen.kt`
(two-column). Use `BoxWithConstraints` for the 880dp breakpoint.

## Then (after the layout, still queued)

- Per-screen two-column / grid polish on Schedule, Invoices, KinTales, Tribe to match
  their mockups (optional, lower priority than the shell).
- Resume the AuntieOS cross-app patch once their in-flight work lands.
- Optional: render PNG screenshots of the redesigned screens via Chrome for a visual check.

## Key context in memory

`auntieos-canonical-paths` (invoices flat, pets flat kin/, bookings are AuntieOS
enhanced_bookings, schemas MyTribe-seeded), `mytribe-booking-kincare-inverted` (now
notes the implemented-but-gated envelope), `mytribe-feature-flags`.
