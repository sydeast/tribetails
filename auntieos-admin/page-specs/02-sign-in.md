> STATUS 2026-06-09 (de-stale pass): SHIPPED on web/desktop: password-manager autofill via a hidden DOM form (item 1), explicit Email->Password focus chain with the reveal toggle out of tab order (item 2), email IME onNext (item 3). ONLY GAP: the android `RevealToggle` lacks `focusProperties { canFocus = false }` before its `.clickable`, so it can still intercept Tab; one-line fix + instrumented test. Line-number references in the bodies below are ~28 lines stale.

# Sign in — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-sign-in-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/auth/SignInScreen.kt`
**Shared components:** `BottomBorderField` (`…/web/ui/components/BottomBorderField.kt`), `AuntiePasswordField` (`…/web/ui/components/AuntiePasswordField.kt`), `PrimaryButton` / `GhostButton` / `StatusToast` (`…/web/ui/components/`), `meshGradientBackground` (`…/web/ui/shaders/`).
**Auth facade:** `AuthClient` (`…/web/data/AuthClient.kt`) + `expect`/`actual` `platformSignIn` / `platformSendPasswordReset` (jvm actual: `…/jvmMain/…/data/AuthInterop.jvm.kt`).

> ⚠️ Mock-file correction: none needed. `SignInScreen.kt`'s KDoc (ll.175-177) explicitly references the mockup's password show/hide SUGGESTION and the mock header (ll.10-18) names `SignInScreen.kt` as its contract. Mock and code agree. The mock's own footnote already concedes the show/hide toggle it tagged "SUGGESTION" is in fact **already shipped** as `AuntiePasswordField`'s `RevealToggle` (`AuntiePasswordField.kt` ll.199-284) — so that mock suggestion is DONE, not a delta.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`you@auntieos.com`, the dotted password placeholder, the three toast strings `This account does not have admin access.` / `Email and password are required.` / `Reset link sent. Check your inbox.`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string." (Note: the toast strings here are already real, sourced live from `AuthClient`/`submit()`/`resetPassword()`; the placeholders are static affordance copy, which is fine — they are not data values.)

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Password-manager autofill (THE primary complaint — currently impossible)
- **Current:** both inputs are Compose `BasicTextField`s — email via `BottomBorderField` (`BottomBorderField.kt` ll.125-149), password via `AuntiePasswordField` (`AuntiePasswordField.kt` ll.153-181). On the **web (Wasm) target** Compose renders the whole app to a single `<canvas>`; there are **no real DOM `<input>` / `<form>` elements** (confirmed: `wasmJsMain/resources/index.html` contains no `input`/`form`/`autocomplete`/`password` markup). Neither field declares any **autofill semantics** — there is no `Modifier.semantics{}` with `AutofillType`, no `LocalAutofill`/`AutofillNode` registration anywhere in `web/` (grep for `autofill`/`AutofillType` finds only node_modules, never our Kotlin). Result: 1Password / Chrome / iCloud Keychain see no `email`/`password` field to fill and cannot offer to fill or save credentials. This is a structural gap, not a styling one.
- **Desired:** the mock shows a conventional email + password card that a browser/manager would treat as a login form (it is plain HTML `<input type="email">` / `<input type="password">` in the mock, ll.130 & 136). The intent: a real, autofillable, save-promptable credential form.
- **Fix (full-stack, platform-specific — this is the real work):**
  1. **Email field:** add Compose Autofill semantics — `Modifier.semantics { contentType = ContentType.EmailAddress }` (Compose 1.8+ autofill API) or, on older Compose, the `AutofillNode(autofillTypes = listOf(AutofillType.EmailAddress))` + `LocalAutofillTree`/`LocalAutofill` registration pattern, wired through `onFocusChanged`. Thread a new optional `contentType`/autofill param into `BottomBorderField` so the change is reusable, not one-off.
  2. **Password field:** same, `ContentType.Password` (or `AutofillType.Password`) threaded into `AuntiePasswordField`.
  3. **Web (Wasm) reality check / Dependency:** Compose-canvas autofill on Wasm is the limiting factor. If the running Compose version's autofill bridge does not surface to the browser's credential manager on the Wasm target, the honest options are (a) overlay real DOM `<input autocomplete="username">` / `<input autocomplete="current-password">` inside a `<form>` for the sign-in screen only and feed their values into the Compose state, or (b) gate the autofill affordance dark with a visible "Password-manager autofill not wired on web yet" banner. **Do NOT ship a canvas field that silently cannot be autofilled** while implying it can — fail loud per CLAUDE.md. Pick (a) or (b) deliberately; do not guess.
  4. **Android parity:** Android Compose autofill is first-class — `ContentType.EmailAddress`/`Password` (or the legacy `AutofillNode`) works with the platform autofill framework and Google Password Manager. Mirror the same `contentType` params into the Android `BottomBorderField.kt` / `AuntiePasswordField.kt` (`android/app/src/main/java/com/tribetails/auntieos/ui/components/`).
  5. **Save-on-submit:** for the manager to *save* a new credential the submit must look like a form submission. On the DOM-overlay path, submit the `<form>`; on pure Compose, the `CommitCredential`/autofill-commit call must fire on successful `submit()`.
  - **Tests:** component test that the field exposes the right autofill content type; web e2e (Playwright, the `web/visual/` harness already bundles playwright-core) asserting the credential form is detectable/fillable; Android instrumented test against the autofill framework. **Dependency:** confirm the pinned Compose Multiplatform version's autofill support on Wasm before committing to the pure-Compose path.

## 2. Tab order is broken — "must tab twice to advance fields" (second complaint)
- **Current:** the screen places brand mark, "AuntieOS" `Text`, then the card `Column` (`SignInScreen.kt` ll.124-217). Inside the card: email `BottomBorderField` (`imeAction = ImeAction.Next`, l.173) then password `AuntiePasswordField` (`imeAction = ImeAction.Done`, l.183), then `PrimaryButton` and `GhostButton`. **No explicit focus traversal order is declared** — there is no `FocusRequester` chain, no `Modifier.focusProperties { next = … }`, no `focusGroup()` (grep for `focusProperties`/`FocusDirection`/`focusOrder` in `web/` finds nothing). Each field owns a `FocusRequester` used only for *tap-forwarding* (`BottomBorderField.kt` ll.95-100; `AuntiePasswordField.kt` ll.123-128), not for Tab traversal. The "must press Tab twice" symptom is consistent with a stray focusable node sitting in default traversal order between the two fields — most likely the **`RevealToggle`** inside the password field (a `clickable` `Box`, `AuntiePasswordField.kt` ll.234-245), and/or the email field's own focus-forwarding `clickable` `Box` wrapper, each of which can land in the Tab sequence ahead of the next input.
- **Desired:** mock implies the natural, single-Tab flow Email → Password → primary action (standard HTML tab order). One Tab from Email lands on Password.
- **Fix (full-stack-of-focus + tri-platform):**
  1. **Declare an explicit traversal chain.** Give Email and Password each a `FocusRequester` dedicated to traversal and wire `Modifier.focusProperties { next = passwordFocus; previous = … }` so Tab from Email goes straight to Password (and Shift+Tab back). Apply to the inner `BasicTextField`s, not the wrapper `Box`es.
  2. **Take the reveal toggle out of Tab order** (or fix its position): `RevealToggle`'s `clickable` `Box` should either be `focusable(false)` / excluded via `focusProperties { canFocus = false }`, or be explicitly slotted *after* the password field, so it stops intercepting the Email→Password Tab. Decide based on accessibility: the toggle should still be reachable by AT, so prefer correct ordering over removing it from focus entirely.
  3. **Audit the tap-forwarding `clickable` Boxes** (`BottomBorderField.kt` l.95, `AuntiePasswordField.kt` l.123) — a `clickable` modifier makes a node focusable by default and can absorb a Tab. Mark these wrappers non-focusable so only the real text inputs participate in traversal.
  4. Mirror the same focus chain on **Android** (`android/.../ui/components/BottomBorderField.kt` + `AuntiePasswordField.kt`) and verify on **desktop/JVM** (hardware Tab key is most testable there).
  - **Tests:** component/UI test that injects Tab key events and asserts focus moves Email→Password in exactly one press, and that the reveal toggle is reachable but not between the fields; run on web (Playwright keyboard) and desktop. **No backend dependency** — this is pure client focus wiring, but per Rule 2 it must reach parity across web/desktop/Android with tests on each.

## 3. Email field IME action / Enter-to-advance
- **Current:** email `imeAction = ImeAction.Next` (l.173) but there is no `KeyboardActions`/`onNext` handler binding that action to actually move focus to the password field; password binds `Enter`→`submit()` via `onPreviewKeyEvent` (ll.184-188). So "Next" on a soft keyboard has no wired target.
- **Desired:** pressing Next/Enter on Email advances to Password (consistent with fixing item 2).
- **Fix:** add `keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() })` (or rely on the declared focus chain from item 2) to the email field; thread a `keyboardActions` param through `BottomBorderField` if not present. Pure client; mirror Android. Cheap, but do it alongside item 2 so soft-keyboard and hardware-Tab behave identically.

## 4. Show / hide password toggle — already shipped (mock SUGGESTION resolved)
- **Current:** `AuntiePasswordField` renders a Canvas-drawn `RevealToggle` with `contentDescription` "Show/Hide password" and a `PasswordVisualTransformation` flip (`AuntiePasswordField.kt` ll.103-104, 182-188, 199-284). Functional and accessible.
- **Desired:** mock's `.eye` "show" button, tagged "SUGGESTION: not in current code" (ll.137, 161).
- **Fix:** none for parity — the toggle exists and exceeds the mock's plain text button. **Action:** the only remaining gap is item 2 (this toggle is the prime suspect for the broken Tab order). Treat as a side effect of the focus fix, not a new feature.

---

## Out of scope / leave as-is
- Brand mark (96dp glass circle + `Lucide.PawPrint`), "AuntieOS" wordmark, card copy "Welcome home, Auntie" / "Sign in to keep the Kinfolk taken care of." — all already match the mock verbatim (`SignInScreen.kt` ll.124-163).
- Animated mesh-gradient background (`meshGradientBackground`) already mirrors the mock's drifting blobs.
- The admin-only gate flow (`signIn` → `isCurrentUserAdmin(forceRefresh=true)` → `onSignedIn` else `signOut` + toast, ll.78-93) matches the mock's documented flow and fails loud correctly. Do not touch.
- Toast strings are sourced from real auth results, not hardcoded sample data — already correct.
- Primary "Jump back in!" / "Signing in…" loading copy and "Forgot password?" / "Sending…" already match.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Autofill content-type plumbing** through `BottomBorderField` + `AuntiePasswordField` (email + password) on **all three** component implementations, AND a decision on the Wasm-canvas autofill limitation: real DOM `<input autocomplete>`/`<form>` overlay for the sign-in screen vs. a dark "autofill not wired on web" banner. Requires confirming the pinned Compose Multiplatform version's Wasm autofill support — that confirmation is itself a dependency. Never ship a canvas field that silently cannot be autofilled.
2. **Save-credential-on-submit signal** so managers offer to *save* new logins (form submit on the DOM path, or autofill-commit on the Compose path).
3. **Explicit focus-traversal chain** (Email→Password→action) + removing the reveal toggle / tap-forwarding Boxes from the stray Tab order, mirrored web/desktop/Android. (Client-only, but tri-platform + tested.)
4. **`keyboardActions`/`onNext`** wiring so soft-keyboard Next matches hardware Tab.

No new backend collection is required for sign-in itself; the heavy lift is the **autofill bridge on the Wasm target** and the **focus-order correction**, both of which must be proven with web e2e + Android instrumented tests, not assumed. If autofill cannot be made real on web, it ships dark with a Not-wired banner — never as a dead affordance.
