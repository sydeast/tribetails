# Golden Screenshot Regression Triage

**Date:** 2026-07-21
**Input:** `node web/visual/baseline.mjs` verify run, 23 ok / 37 regressed / 0 unbaselined (exit 1).
**Method:** opened 16 of the 37 regressed screens as images (baseline, current, and/or diff overlay), then scanned all 40 desktop+android captures programmatically for the fail-loud error-banner fill colour to classify the remaining 21 without guessing.
**Verdict:** DO NOT BULK-APPROVE.
**Confirmed:** 6 screens capture an error state, 4 need a decision, 27 are legitimate UI change.

## Bottom line

This is not safe to bulk-approve, and the reason is not the size of the diffs. Six of the 37 captures are screenshots of a broken screen: `android/home` renders two fail-loud banners and a completely empty dashboard where the baseline had four stat tiles and a visit list, and five desktop screens (`home`, `inbox`, `directory`, `auntie-time`, `template-assignment`) render "Not signed in" load-failure banners that the baselines do not have. These are harness defects, not shipping bugs. The screenshot fixtures were never updated when screens gained new data reads, so the unstubbed reads fall through to the real Firestore REST client and fail. Production is unaffected. But `baseline.mjs update` has no per-screen mode: `npm run visual:approve` promotes all 60 captures and `node baseline.mjs update android` promotes all 20 android captures, including the broken ones. Approving either surface today writes six error states into the goldens permanently, which is exactly how the baselines stopped meaning anything the first time. Fix the six fixtures, recapture, re-verify, then approve. The other 31 diffs are real and mostly good: Communicate gained message-type tabs and a recipient-context panel, KinTales gained search and sort, Settings was restructured, and several "NOT WIRED" placeholders became working controls.

Two things limit this report and the operator should know both. First, git history begins at `b1ee442` on 2026-07-16, six weeks after the goldens were taken on 2026-06-02/03, so most of this drift predates version control and cannot be pinned to a commit. Second, the "web is clean 20/20" result is vacuous: `visual/web/*.png` still carries its 2026-06-02 mtimes and is byte-identical to the goldens. Nothing recaptured web, so verify compared each file to itself.

## android/home at 78.9 percent

It is a crash state, not a redesign. The capture shows the greeting header, a "Customize" button, and then two fail-loud banners over an otherwise empty page:

1. `AuntieOS is offline. Check the tunnel.`
2. `class java.lang.Object cannot be cast to class java.util.List (java.lang.Object and java.util.List are in module java.base of loader 'bootstrap')`

The header reads `TODAY · 0 VISITS ON THE BOOKS` where the baseline reads `2 VISITS`, and every widget below is gone. The `java.base of loader 'bootstrap'` frame identifies this as a JVM-side ClassCastException under Robolectric, not a device crash.

Root cause: `HomeViewModel.load()` fires ten parallel reads, two of which the screenshot test never stubs. `android/app/src/test/java/com/tribetails/auntieos/visual/AndroidScreenshotTest.kt:102-112` stubs `getKinfolkCount`, `getKinCount`, `getPendingDraftCount`, `getRecentDrafts`, `getKinCareSessionsForDay`, `getBusinessSettings`, `getKinfolkById` and `getInvoices`, but not `repo.getKinCareSessions()` (HomeViewModel.kt:202) or `repo.getAllKin()` (HomeViewModel.kt:204). The relaxed mockk returns a default `Result` wrapping a bare `Object`, which explodes at the `List` cast, and the outer try/catch surfaces it as the banner.

The same failure mode is already documented three tests further down in the same file. `AndroidScreenshotTest.kt:274-277` carries this comment on the invoices test: "seed it so the relaxed mock's default Result (a bare Object) never reaches the List cast in loadKinfolkDirectory." Somebody hit this once, fixed it locally, and did not sweep the other tests.

`getAllKin()` was added to `load()` by `7a788c4` (AO-24: android parity for the 5 dashboard insight widgets). `getKinCareSessions()` predates the initial commit. Fix is two lines in the test, not a product change.

## Findings by screen

Classification key: EXPECTED (real UI change landed), SUSPICIOUS (capture shows a defect or error state), INVESTIGATE (renders clean but the diff is non-deterministic or removes content). "opened" means I looked at the image; "scanned" means classified by the error-banner colour scan plus the percentage, without opening.

| screen | surface | % | class | what actually changed | likely commit |
|---|---|---|---|---|---|
| home | android | 78.916 | SUSPICIOUS | Two fail-loud banners, dashboard entirely empty. Unstubbed `getAllKin` / `getKinCareSessions` hit a List cast. **opened** | `7a788c4` (AO-24) |
| communicate | desktop | 19.761 | EXPECTED | New MESSAGE TYPE tabs (Visit report / Text / Email / Blog), new SUBJECT field, new "Recipient context" panel, "Send outside the tribe" and "Recent" promoted from NOT WIRED placeholders to navigable rows. Tone chips wrap to two rows. **opened** | pre-git (Communicate recipient-context) |
| kintale-logs | android | 15.576 | EXPECTED | New search field and Sort chips (Newest / Oldest / Kinfolk A-Z / Service type) push content down. Row buttons shortened to Assign / Duplicate / Archive. Fixture renames. **opened** | pre-git |
| schedule | android | 13.440 | INVESTIGATE | Renders clean. Google Calendar Sync card, Block Dates/Times modes, Holidays and Special Hours with surcharge count. Date field defaults to a live date (`2026-07-16`), so this screen will drift again. **opened** | pre-git (settings unification) |
| kintale-logs | desktop | 12.922 | EXPECTED | Same search plus sort chips as android, roughly 140px downshift. Fixture renames (Becky Seeds to Tessa Brooks, Amber Dutton to Nora Halbrook). **opened** | pre-git; renames `b1ee442` |
| settings | desktop | 11.181 | INVESTIGATE | Nav restructured. Gone: Profile, Security, Time off, Dynamic fields. Added: Booking, Payments, Vet clinics, Branding, MyTribe, Navigation. Default section moved from Profile to Business profile. New "Weather area" card. Confirm the four dropped sections moved rather than vanished. **opened** | pre-git |
| template-assignment | android | 10.042 | EXPECTED | New "Unbound catalog keys" panel (1 unbound) and a binding search field. Matches the `listCatalogKeys` note at AndroidScreenshotTest.kt:401. **opened** | pre-git |
| home | desktop | 9.238 | SUSPICIOUS | Two new banners: "Couldn't load branding; showing defaults" and "Couldn't load this week's revenue", both "Not signed in". Kinfolk tile replaced by "This week / - / Couldn't load invoices". Greeting also flipped evening to morning. **opened** | pre-git |
| inbox | desktop | 8.693 | SUSPICIOUS | Two new banners: "Couldn't load notifications" (Not signed in) and "Couldn't load messages" (Sign in required). Channels list below renders fine. **opened** | pre-git |
| activity-log | desktop | 7.916 | INVESTIGATE | Inverted: the **baseline** carried "Could not verify the chain". Current is clean but was caught mid-flight showing "VERIFYING / Walking the SHA-256 chain...". Capture does not await the settled state. **opened** | pre-git |
| auntie-time | desktop | 7.796 | SUSPICIOUS | New banner "Couldn't load pet avatars / Not signed in". Rest of the screen renders. **opened** | pre-git |
| settings | android | 7.729 | EXPECTED | New Branding section (logo upload, app name, tagline, home greeting, accent word) and a Navigation section. **opened** | pre-git |
| directory | desktop | 7.700 | SUSPICIOUS | Two new banners: "Couldn't load visit history" and "Couldn't load KinTale history", both "Not signed in". Also real new UI (card grid, Kinfolk 6 / Kin 9 counts, "Invite all to portal", A-Z sort). **opened** | pre-git |
| invoices | android | 6.967 | INVESTIGATE | Renders clean. "New quote" added, "New invoice" promoted from NOT WIRED, Household filter, search. But the Overdue tile is date-relative: "1 / Wanda Thorne, 42 days past" against a baseline "0 / all clear". Will drift every run. **opened** | pre-git |
| template-assignment | desktop | 5.267 | SUSPICIOUS | New banner "Could not load catalog keys / Sign in required." **opened** | pre-git |
| kintale-report | android | 5.061 | EXPECTED | Banner scan shows an error banner in the **baseline** that is gone in the current, so the capture improved. scanned |  pre-git |
| directory | android | 0.693 | EXPECTED | New "Invite all" button, "New" badges per row, fixture renames (Priya Ashford, Fern Calloway, Iris Ellery). **opened** | pre-git; renames `b1ee442` |
| formschema-list | android | 0.943 | EXPECTED | Filter field, per-row delete icon, Reload control. The colour scan flagged it; opening it showed the hits were the four red delete icons, not a banner. **opened** | pre-git |
| auntie-time | android | 4.698 | EXPECTED | No banner signal. Layout and fixture drift. scanned | pre-git |
| notifications | android | 4.496 | EXPECTED | No banner signal (baseline and current both 4463/4470 accent px, i.e. unchanged status pills). scanned | pre-git |
| invoices | desktop | 4.636 | EXPECTED | No new banner (16535 to 16779 maroon px is the pre-existing Overdue tile wash). scanned | pre-git |
| kintale-report | desktop | 4.622 | EXPECTED | No banner signal. scanned | pre-git |
| payments | android | 3.164 | EXPECTED | No banner signal. Capture is dated 2026-06-07, older than its siblings. scanned | pre-git |
| payments | desktop | 3.418 | EXPECTED | No banner signal. Capture dated 2026-06-07. scanned | pre-git |
| schedule | desktop | 2.888 | EXPECTED | No banner signal. scanned | pre-git |
| manage-bookings | android | 2.533 | EXPECTED | No banner signal. scanned | pre-git |
| manage-bookings | desktop | 2.462 | EXPECTED | No banner signal. scanned | pre-git |
| training-documents | desktop | 2.519 | EXPECTED | No banner signal. scanned | pre-git |
| template-bank | desktop | 2.408 | EXPECTED | No banner signal. scanned | pre-git |
| notifications | desktop | 2.031 | EXPECTED | No banner signal. scanned | pre-git |
| formschema-list | desktop | 1.845 | EXPECTED | No banner signal. scanned | pre-git |
| communicate | android | 1.455 | EXPECTED | No banner signal. scanned | pre-git |
| inbox | android | 1.436 | EXPECTED | No banner signal. scanned | pre-git |
| template-bank | android | 1.403 | EXPECTED | No banner signal. scanned | pre-git |
| invoice-detail | desktop | 1.271 | EXPECTED | No banner signal. scanned | pre-git |
| training-documents | android | 1.195 | EXPECTED | No banner signal. scanned | pre-git |
| invoice-detail | android | 0.927 | EXPECTED | No banner signal. scanned | pre-git |

No screen was classified COSMETIC. Even the 0.69 percent tail is real content change (fixture renames plus new controls), not antialiasing noise. The 0.5 percent threshold is doing its job.

## Cross-cutting problems the percentages hid

**1. Desktop captures are unauthenticated, and screens keep adding authenticated reads.** `JvmFirestoreRest` throws `Not signed in` when there is no id token (JvmFirestoreRest.kt:71 and six more sites). `DesktopScreenshotTest` covers reads through `JvmFirestoreFixtures`, but any read with no fixture falls through to the real REST client. Five desktop screens now do that. Every new data read on a desktop screen silently arms this trap.

**2. Android screenshot fixtures use `mockk(relaxed = true)`,** so an unstubbed read returns a bare `Object` that blows up at the first `List` cast instead of failing at the mock boundary with a readable message. This is what killed `android/home`.

**3. Three screens are wired to the wall clock and will never be stable.** The home greeting swings on time of day ("Good evening" in both baselines, "Good morning" in both currents). The android invoices Overdue tile is computed against today ("42 days past"). The android schedule date field defaults to a live date. Each of these regenerates a diff on every capture regardless of code changes.

**4. `desktop/activity-log` captures a transient state.** The hash-chain verify is async and the screenshot fires while it still says "Walking the SHA-256 chain...". Approving it freezes a race outcome as the golden.

**5. Web has never been verified against a fresh capture.** The 20 web PNGs still carry 2026-06-02 mtimes, identical to the goldens. Web being green means nothing until `npm run visual:web` runs against the `auntieos-admin` site (per `docs/runbooks/visual-regression.md`, `auntie.tribetails.com` now serves React, not the wasm app the capture script drives).

## Recommended action

### Fix these 6 before anything is approved

All six are harness defects. No product code changes.

1. `android/home` (78.916). Add `coEvery { repo.getKinCareSessions() } returns Result.success(AndroidDemoFixtures.sessions)` and `coEvery { repo.getAllKin() } returns Result.success(AndroidDemoFixtures.allKin)` to `AndroidScreenshotTest.home()` (AndroidScreenshotTest.kt:102-112).
2. `desktop/home` (9.238). Set `JvmFirestoreFixtures.businessSettings` and `.invoices` in `DesktopScreenshotTest.home()`.
3. `desktop/inbox` (8.693). Add notification and conversation fixtures.
4. `desktop/directory` (7.700). Add visit-history and KinTale-history fixtures.
5. `desktop/auntie-time` (7.796). Add the pet-avatar read fixture.
6. `desktop/template-assignment` (5.267). Add a `listCatalogKeys` fixture, mirroring what the android test already does at AndroidScreenshotTest.kt:404.

While in there, sweep every other screenshot test for reads the fixtures do not cover. The colour scan only catches failures that render a banner.

### Investigate these 4 (decide, then approve or fix)

1. `desktop/settings` (11.181). Four nav sections disappeared (Profile, Security, Time off, Dynamic fields). Confirm they were consolidated elsewhere rather than dropped. If intended, this is EXPECTED.
2. `android/invoices` (6.967) and `android/schedule` (13.440). Date-relative content. Pin the fixture clock or freeze the fixture dates, or accept that these two rows go red on every capture forever.
3. `desktop/activity-log` (7.916). Make the capture wait for the chain verify to settle. The current golden candidate is a mid-flight state.
4. Home greeting on both surfaces. Either stub the clock or set the branding `HOME GREETING` override in the fixtures so the greeting is fixed.

### Approve these 27, but only after the 6 are fixed and recaptured

The 27 EXPECTED rows are legitimate UI change and should become the new goldens. They cannot be promoted individually: `baseline.mjs update` works per surface or not at all, and both surfaces still contain broken screens. Sequence:

```bash
# 1. fix the 6 fixtures, then recapture both surfaces
./gradlew -p web :composeApp:jvmTest --tests "com.tribetails.auntieos.web.visual.DesktopScreenshotTest"
cd android && ./gradlew :app:testDebugUnitTest -Proborazzi.record=true \
  --tests "com.tribetails.auntieos.visual.AndroidScreenshotTest"

# 2. re-verify: expect the 6 error screens to drop out, leaving explained diffs only
cd web/visual && npm run visual:verify

# 3. approve, per surface, committing the goldens separately from the fixture fix
node baseline.mjs update desktop
node baseline.mjs update android
```

Do not run `npm run visual:approve` (all three surfaces) until web has had a real capture. Promoting web today just recopies the same 2026-06-02 bytes and hides the fact that web is unguarded.

## What I opened versus inferred

Opened as images (16 screens): `android/home` (baseline + current), `desktop/home` (baseline + current), `desktop/communicate` (baseline + current), `desktop/kintale-logs` (baseline + current), `desktop/settings` (baseline + current + overlay), `android/schedule`, `android/settings`, `android/directory` (overlay + current), `android/template-assignment` (overlay + current), `android/formschema-list`, `android/invoices` (overlay + current), `android/kintale-logs` (overlay), `desktop/activity-log` (overlay + current), `desktop/inbox`, `desktop/directory`, `desktop/auntie-time`, `desktop/template-assignment`.

Inferred for the remaining 21 by scanning every desktop and android capture for the error-banner fill colour rgb(70,41,52) sampled from the confirmed `desktop/home` banner, comparing baseline against current per screen. The scan produced two false positives, both caught by opening the screen: `android/formschema-list` (red delete icons) and `android/invoices` (the maroon Overdue tile wash). Every other screen showed a baseline-to-current delta under 400 pixels, meaning no banner appeared or disappeared.
