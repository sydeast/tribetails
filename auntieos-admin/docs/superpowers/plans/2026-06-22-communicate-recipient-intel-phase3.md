# Communicate Recipient Intelligence — Phase 3 Implementation Plan (Refresh-intelligence relocation)

> **HISTORICAL, written 2026-06-22. Built and deployed 2026-06-23.**
> Do not run this as a plan; read it for the design. Its "NO git (no commits)"
> instruction was true when written and is wrong now: this repo is under git
> with CI (`.github/workflows/ci.yml`), and the workflow is branch per task,
> never commit on `main`, land through a PR.

**Goal:** Put the "Refresh intelligence" action where it belongs — on the kinfolk profile and the kin-edit screens (web + android) — after Phase 1 removed it from Communicate. It reuses the existing `synthesize_kinfolk_profile` callable; no new backend.

**Architecture:** No backend, no new callable, no new helper. The web client `FirestoreClient.synthesizeProfile(kinfolkId): WriteResult<Unit>` and android `AuntieRepository.synthesizeProfile(kinfolkId): Result<Unit>` already exist (retained in Phase 1). Web screens are stateless-local (busy+toast mirror of the existing portal-invite flow). Android adds a `synthesizeProfile` action + in-flight state to the shared `DirectoryViewModel` (mirroring `CommunicateViewModel.synthesizeProfile`), consumed by both the profile and kin-edit screens. Synthesis is per-HOUSEHOLD; the kin-edit refresh calls it for the kin's parent `kinfolkId`, and every label says so.

**Tech Stack:** Kotlin Multiplatform / Compose (web commonMain); Kotlin / Compose android + `DirectoryViewModel` + `org.junit`/MockK tests.

**Phases 1 + 2 are DONE** (all green, not deployed). This is the final phase of the spec.

**VERIFY note (resolved):** a web grep for `synthesizeProfile` returns only the `FirestoreClient` definition, `RecipientContext.kt` (the `synthesizeBlocker`/`SYNTHESIZE_SUCCESS` helpers, retained), and `SynthesizeProfileClientTest`. The action is NOT on any profile/kin screen today — Phase 3 is its first placement there.

---

## Context (mapped — implementers confirm before editing; line numbers may drift)

**Web**
- `screens/directory/KinfolkProfileScreen.kt`: `KinfolkProfileScreen(kinfolkId, onBack, onEdit, onAddKin, onEditKin, onOpenHousehold)` (~91). Has `client = FirestoreClient()` (~99), `scope = rememberCoroutineScope()` (~144), and a portal-invite busy+toast flow (~142-168) using `StatusToast`/`ToastKind` — MIRROR it.
- `screens/directory/KinEditScreen.kt`: `KinEditScreen(kinfolkId, kinId, onBack, onSaved, onArchived)` (~78). Has `client`, `scope` (~86-87), a `showToast`/`StatusToast` pattern (~185-292). `kinfolkId` is a direct param.
- `data/FirestoreClient.kt`: `synthesizeProfile(kinfolkId): WriteResult<Unit>` (~285-304) — calls `synthesize_kinfolk_profile`. Exists.
- `screens/communicate/RecipientContext.kt`: `const val SYNTHESIZE_SUCCESS = "Profile updated from recent history."` (~13). Reuse it.

**Android**
- `data/repository/AuntieRepository.kt`: `synthesizeProfile(kinfolkId): Result<Unit>` (~549-558). Exists.
- `ui/directory/DirectoryViewModel.kt`: has Phase-2 StateFlow message patterns (`_inviteMessage`/`_clearMessage`, ~243-254) + `loadProfile(kinfolkId)`. NO synthesize action yet.
- `ui/communicate/CommunicateViewModel.kt`: `synthesizeProfile()` (~244-261) — the pattern to mirror (guard → isSynthesizing true → repo → onSuccess reload + message, onFailure error → isSynthesizing false).
- `ui/directory/KinfolkProfileScreen.kt`: `KinfolkProfileScreen(viewModel, kinfolkId, …)`; existing `inviteMessage`/`clearMessage` Toast via `LaunchedEffect` (~44-61). Invite button ~124-131.
- `ui/directory/EditKinScreen.kt`: `EditKinScreen(viewModel, kinId, onBack)`; loads via `viewModel.loadKinForEdit(kinId)`; the edit state `EditKinUiState.kinfolkId` (~169) holds the kin's PARENT household id (populated by `loadKinForEdit` ~973).
- `ui/directory/DirectoryViewModel.kt` `EditKinUiState` (~167); `loadProfile`/`loadKinForEdit`/`saveKinChanges` (~961-1075).
- Test: `app/src/test/java/.../ui/directory/DirectoryViewModelTest.kt` (mockk relaxed repo, `UnconfinedTestDispatcher`, `runTest`, `advanceUntilIdle`; Phase-2 added a `clearDossierHouseholdNotes` test to mirror).

## File Structure
- Web: `KinfolkProfileScreen.kt`, `KinEditScreen.kt` (UI only).
- Android: `DirectoryViewModel.kt` (new action+state), `KinfolkProfileScreen.kt` + `EditKinScreen.kt` (buttons+toasts), `DirectoryViewModelTest.kt` (new tests).

---

## Task 1: Web — Refresh action on `KinfolkProfileScreen`

**Files:** Modify `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/KinfolkProfileScreen.kt`

- [ ] **Step 1: Read** the portal-invite busy+toast flow (~142-168) and the screen's button composable (find the real one — likely `GhostButton(label=…, onClick=…, enabled=…)`; the Phase-2 box on this screen already uses it).

- [ ] **Step 2: Add the refresh action + state** next to the invite flow:

```kotlin
var refreshBusy by remember { mutableStateOf(false) }
var refreshToast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }
fun doRefresh() {
    if (refreshBusy) return
    refreshBusy = true
    scope.launch {
        refreshToast = when (val r = client.synthesizeProfile(kinfolkId)) {
            is WriteResult.Ok  -> SYNTHESIZE_SUCCESS to ToastKind.Success
            is WriteResult.Err -> "Refresh failed: ${r.message}" to ToastKind.Error
        }
        refreshBusy = false
    }
}
```
Add `import com.tribetails.auntieos.web.screens.communicate.SYNTHESIZE_SUCCESS`.

- [ ] **Step 3: Add the button + toast** near the dossier section / header actions (match the file's layout). Use the real button composable; label "Refresh intelligence", disabled/spinner while busy, with an honest one-line caption that it rebuilds the whole household:

```kotlin
GhostButton(
    label = if (refreshBusy) "Refreshing…" else "Refresh intelligence",
    enabled = !refreshBusy,
    onClick = { doRefresh() },
)
Text(
    "Rebuilds this household's dossier and every pet's 411 from recent messages, calls, and notes.",
    style = AuntieTheme.typography.labelSmall,
    color = AuntieTheme.colors.textDim,
)
```
And render the toast (mirror the invite toast):
```kotlin
refreshToast?.let { (msg, kind) -> StatusToast(visible = true, message = msg, kind = kind, onDismiss = { refreshToast = null }) }
```
(Match the real `GhostButton`/`Text`/`StatusToast`/theme handles. Do NOT invent.)

- [ ] **Step 4: Gates.**
Run: `cd web && ./gradlew :composeApp:jvmTest :composeApp:compileKotlinWasmJs`
Expected: PASS.

---

## Task 2: Web — Refresh action on `KinEditScreen`

**Files:** Modify `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/KinEditScreen.kt`

- [ ] **Step 1: Read** the `showToast`/`StatusToast` flow (~185-292) and the screen's button composable. Confirm `kinfolkId` param (~80) + `client`/`scope` (~86-87).

- [ ] **Step 2: Add the refresh action.** Reuse the screen's existing `showToast`. Add:

```kotlin
var refreshing by remember { mutableStateOf(false) }
fun doRefresh() {
    if (refreshing) return
    refreshing = true
    scope.launch {
        when (val r = client.synthesizeProfile(kinfolkId)) {
            is WriteResult.Ok  -> showToast(SYNTHESIZE_SUCCESS, ToastKind.Success)
            is WriteResult.Err -> showToast("Refresh failed: ${r.message}", ToastKind.Error)
        }
        refreshing = false
    }
}
```
Add the `SYNTHESIZE_SUCCESS` import.

- [ ] **Step 3: Add the button** in the editor's action area. Because this screen edits one pet but synthesis is per-household, the label MUST say it refreshes the whole household:

```kotlin
GhostButton(
    label = if (refreshing) "Refreshing…" else "Refresh household intelligence",
    enabled = !refreshing,
    onClick = { doRefresh() },
)
Text(
    "Updates the whole household's dossier and every pet's 411 (not just this pet).",
    style = AuntieTheme.typography.labelSmall,
    color = AuntieTheme.colors.textDim,
)
```
(Match the file's real handles.)

- [ ] **Step 4: Gates.**
Run: `cd web && ./gradlew :composeApp:jvmTest :composeApp:compileKotlinWasmJs`
Expected: PASS.

---

## Task 3: Android — `synthesizeProfile` on `DirectoryViewModel` (+ tests)

**Files:**
- Modify: `android/app/src/main/java/com/tribetails/auntieos/ui/directory/DirectoryViewModel.kt`
- Test: `android/app/src/test/java/com/tribetails/auntieos/ui/directory/DirectoryViewModelTest.kt`

- [ ] **Step 1: Write failing tests.** In `DirectoryViewModelTest.kt`, first add `coEvery { repository.synthesizeProfile(any()) } returns Result.success(Unit)` to `setup()`. Then add:

```kotlin
@Test
fun `synthesizeProfile calls repo then reloads profile and sets message`() = runTest(testDispatcher) {
    advanceUntilIdle()
    viewModel.loadProfile("1")
    advanceUntilIdle()

    viewModel.synthesizeProfile("1")
    advanceUntilIdle()

    coVerify { repository.synthesizeProfile("1") }
    coVerify(atLeast = 2) { repository.getDossier("1") }   // reloaded
    assertEquals("Profile updated from recent history.", viewModel.synthesizeMessage.value)
    assertFalse(viewModel.isSynthesizing.value)
}

@Test
fun `synthesizeProfile surfaces error on failure`() = runTest(testDispatcher) {
    coEvery { repository.synthesizeProfile(any()) } returns Result.failure(RuntimeException("boom"))
    advanceUntilIdle()

    viewModel.synthesizeProfile("1")
    advanceUntilIdle()

    assertEquals("Refresh failed: boom", viewModel.synthesizeMessage.value)
    assertFalse(viewModel.isSynthesizing.value)
}

@Test
fun `synthesizeProfile with blank id does not call repo`() = runTest(testDispatcher) {
    advanceUntilIdle()
    viewModel.synthesizeProfile("")
    advanceUntilIdle()
    coVerify(exactly = 0) { repository.synthesizeProfile(any()) }
    assertEquals("No household selected for refresh.", viewModel.synthesizeMessage.value)
}
```

- [ ] **Step 2: Run to verify they fail.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*directory.DirectoryViewModelTest"`
Expected: FAIL — unresolved `synthesizeProfile`/`synthesizeMessage`/`isSynthesizing`.

- [ ] **Step 3: Implement on `DirectoryViewModel`.** Near the Phase-2 message StateFlows (~243-254), add:

```kotlin
private val _synthesizeMessage = MutableStateFlow<String?>(null)
val synthesizeMessage: StateFlow<String?> = _synthesizeMessage.asStateFlow()
private val _isSynthesizing = MutableStateFlow(false)
val isSynthesizing: StateFlow<Boolean> = _isSynthesizing.asStateFlow()
fun clearSynthesizeMessage() { _synthesizeMessage.value = null }

/**
 * Refresh intelligence: re-runs synthesis for one household via the admin callable,
 * then reloads the profile so the new dossier/411 show. In-flight guarded; fail-loud.
 * Synthesis is per-household, so the kin-edit screen passes the kin's parent kinfolkId.
 */
fun synthesizeProfile(kinfolkId: String) {
    if (_isSynthesizing.value) return
    if (kinfolkId.isBlank()) { _synthesizeMessage.value = "No household selected for refresh."; return }
    viewModelScope.launch {
        _isSynthesizing.value = true
        repository.synthesizeProfile(kinfolkId)
            .onSuccess {
                _synthesizeMessage.value = "Profile updated from recent history."
                loadProfile(kinfolkId)
            }
            .onFailure { _synthesizeMessage.value = "Refresh failed: ${it.message}" }
        _isSynthesizing.value = false
    }
}
```
(Confirm the VM's repo field name — `repository` per the test setup — and that `loadProfile(kinfolkId)` is the reload entry point.)

- [ ] **Step 4: Run to verify they pass.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*directory.DirectoryViewModelTest"`
Expected: PASS.

---

## Task 4: Android — Refresh button on `KinfolkProfileScreen`

**Files:** Modify `android/app/src/main/java/com/tribetails/auntieos/ui/directory/KinfolkProfileScreen.kt`

- [ ] **Step 1: Read** the existing `inviteMessage`/`clearMessage` Toast `LaunchedEffect`s (~44-61) + the Invite button (~124-131) + the screen's button composable.

- [ ] **Step 2: Collect state + add the Toast.** Mirror the invite/clear toast:

```kotlin
val isSynthesizing by viewModel.isSynthesizing.collectAsState()
val synthesizeMessage by viewModel.synthesizeMessage.collectAsState()
LaunchedEffect(synthesizeMessage) {
    synthesizeMessage?.let {
        android.widget.Toast.makeText(profileContext, it, android.widget.Toast.LENGTH_LONG).show()
        viewModel.clearSynthesizeMessage()
    }
}
```
(`profileContext` is the existing `LocalContext.current` the invite toast uses.)

- [ ] **Step 3: Add the button** near the Invite button. Use the real button composable; honest caption:

```kotlin
GhostButton(
    label = if (isSynthesizing) "Refreshing…" else "Refresh intelligence",
    enabled = !isSynthesizing,
    onClick = { viewModel.synthesizeProfile(kinfolkId) },
)
Text(
    "Rebuilds this household's dossier and every pet's 411 from recent history.",
    style = AuntieTheme.typography.labelSmall,
    color = AuntieTheme.colors.textDim,
)
```
(Match the file's real `GhostButton`/`Text`/theme handles.)

- [ ] **Step 4: Gate.**
Run: `cd android && ./gradlew :app:assembleDebug`
Expected: PASS.

---

## Task 5: Android — Refresh button on `EditKinScreen`

**Files:** Modify `android/app/src/main/java/com/tribetails/auntieos/ui/directory/EditKinScreen.kt`

- [ ] **Step 1: Read** the screen: it takes `viewModel: DirectoryViewModel`, observes the edit state (which holds `kinfolkId`), and has a save/toast area. Find how the edit state is collected (e.g. `viewModel.editKinState.collectAsState()`), and the real button composable + how this screen surfaces messages (Toast or inline).

- [ ] **Step 2: Collect synthesize state + Toast** (mirror the profile, since both share `DirectoryViewModel`):

```kotlin
val isSynthesizing by viewModel.isSynthesizing.collectAsState()
val synthesizeMessage by viewModel.synthesizeMessage.collectAsState()
val ctx = androidx.compose.ui.platform.LocalContext.current
LaunchedEffect(synthesizeMessage) {
    synthesizeMessage?.let {
        android.widget.Toast.makeText(ctx, it, android.widget.Toast.LENGTH_LONG).show()
        viewModel.clearSynthesizeMessage()
    }
}
```

- [ ] **Step 3: Add the button**, passing the kin's PARENT household id from the edit state, with a whole-household label:

```kotlin
GhostButton(
    label = if (isSynthesizing) "Refreshing…" else "Refresh household intelligence",
    enabled = !isSynthesizing && state.kinfolkId.isNotBlank(),
    onClick = { viewModel.synthesizeProfile(state.kinfolkId) },
)
Text(
    "Updates the whole household's dossier and every pet's 411 (not just this pet).",
    style = AuntieTheme.typography.labelSmall,
    color = AuntieTheme.colors.textDim,
)
```
(`state` = the collected `EditKinUiState`; confirm its field is `kinfolkId`. Match real handles.)

- [ ] **Step 4: Gate.**
Run: `cd android && ./gradlew :app:assembleDebug`
Expected: PASS.

---

## Task 6: Full verification (all platforms)

(REQUIRED SUB-SKILL: superpowers:verification-before-completion.)

- [ ] **Step 1: Backend (unchanged — sanity).** `cd web/functions-python && ./venv/bin/python -m pytest -q` → 44 passed (Phase 3 added no backend).
- [ ] **Step 2: Web.** `cd web && ./gradlew :composeApp:jvmTest --rerun-tasks :composeApp:compileKotlinWasmJs` → all PASS.
- [ ] **Step 3: Android.** `cd android && ./gradlew :app:testDebugUnitTest --rerun-tasks :app:assembleDebug` → only the known flaky `KinTaleReportDeliveryTest.sentReport_showsGpsRouteStats` may fail; everything else green incl. the new DirectoryViewModel synthesize tests; assembleDebug SUCCESSFUL. (If a transient gradle `NoSuchFileException` on the in-progress-results bin appears, re-run testDebugUnitTest standalone.)
- [ ] **Step 4: Anti-slop** over the new strings ("Refresh intelligence", "Refresh household intelligence", "Refreshing…", the two captions, "Refresh failed: …", "No household selected for refresh."). Keep plain, em-dash-free.
- [ ] **Step 5: Record** in `.remember/remember.md` (direct Write) — all 3 phases done, spec complete, nothing deployed.

---

## Self-Review (recorded for the executor)

**Spec coverage (Phase 3 of the spec):**
- Add `synthesizeProfile` (Refresh intelligence), admin-only label, to `KinfolkProfileScreen` + kin-edit (`KinEditScreen` web / `EditKinScreen` android) → Tasks 1, 2, 4, 5. ✓
- Remove from Communicate → already done in Phase 1. ✓
- Kin-level refresh calls synthesis for the kin's parent `kinfolkId`; label says it refreshes the whole household → Tasks 2, 5 (whole-household captions; `state.kinfolkId`). ✓
- Reuses the existing callable, no new backend; in-flight guard + fail-loud toast → Task 3 (`if (_isSynthesizing.value) return`; onFailure message) + web `refreshBusy`/`refreshing` guards. ✓
- Per-platform build gates + existing synthesize guard tests → Tasks 3, 6 (new DirectoryViewModel tests; existing `SynthesizeProfileClientTest` + `CommunicateViewModelTest` synthesize tests remain green). ✓

**Type consistency:** web `client.synthesizeProfile(kinfolkId): WriteResult<Unit>`; android `repository.synthesizeProfile(kinfolkId): Result<Unit>` + VM `synthesizeProfile(kinfolkId)` / `isSynthesizing` / `synthesizeMessage` / `clearSynthesizeMessage` — consistent across the screens that consume them. Success copy `"Profile updated from recent history."` matches `SYNTHESIZE_SUCCESS` (web) and the android string.

**Placeholder scan:** UI tasks reference real mapped handles; the genuinely file-specific bits (the exact button composable, how each screen collects state / surfaces toasts) are flagged "match the file's real handle — do not invent."

**Admin-only note:** these screens already live solely in AuntieOS (admin app), so no new permission gate is needed (consistent with the spec's "label only" decision); the captions make the whole-household behavior honest.
