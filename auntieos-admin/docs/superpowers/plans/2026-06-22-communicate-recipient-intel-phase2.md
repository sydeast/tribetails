# Communicate Recipient Intelligence — Phase 2 Implementation Plan (Household-notes migration)

> **HISTORICAL, written 2026-06-22. Built and deployed 2026-06-23.**
> Do not run this as a plan; read it for the design. Its "NO git in any tree"
> instruction was true when written and is wrong now: this repo is under git
> with CI (`.github/workflows/ci.yml`), and the workflow is branch per task,
> never commit on `main`, land through a PR.

**Goal:** Give admins a path to migrate the free-text `dossier.householdNotes` blob into the structured `HouseholdData` collection: surface the blob (admin-only) on the kinfolk profile with a "what's still missing" gap list, show it as a fill-in reference on the household editor, and a "Clear from dossier" action once migrated.

**Architecture:** New admin callable `clear_dossier_household_notes(kinfolkId)` in `web/functions-python` (codebase `reconcile`) sets `dossiers/{id}.householdNotes = ""`. A new pure helper `missingHouseholdFields(household)` (TDD, duplicated web+android — no shared module) drives the gap list. The profile screens gain an admin-only migration box (shown only when `dossier.householdNotes` is non-empty); the household editor screens show the blob read-only as a fill-in reference with empty fields flagged. Structured-field editing reuses the EXISTING `saveHouseholdData`.

**Tech Stack:** Python + Firebase `https_fn.on_call` + pytest; Kotlin Multiplatform / Compose (web commonMain, `kotlin.test`); Kotlin / Compose android (`org.junit`); Firestore.

**Phase 1 is DONE** (tldr synthesis, recap callable, commsRecap flag, reshaped Communicate panel — all green, not deployed). Phase 3 (Refresh-intelligence relocation) follows this.

---

## Context the implementer needs

- The clear callable mirrors Phase-1's `recap_recent_comms`/`synthesize_kinfolk_profile` exactly (same `@https_fn.on_call` decorator, admin gate, `init_firebase()` wrapper, pytest FakeDb).
- Dossier model exposes `householdNotes` on both platforms: web `FirestoreClient.kt` `Dossier` (~2024-2037), android `Models.kt` `Dossier` (~103-120).
- `HouseholdData` (30 content fields): web `FirestoreClient.kt` (~2047-2093), android `DynamicFields.kt` (~75-121). Identical field names both sides.
- Existing load/save: web `FirestoreClient.getHouseholdData(kinfolkId): WriteResult<HouseholdData?>` (~1221) + `saveHouseholdData(data): WriteResult<Unit>` (~1223); android `AuntieRepository.getHouseholdData(...): Result<HouseholdData?>` (~1065) + `saveHouseholdData(data): Result<Unit>` (~1076).
- Web profile: `screens/directory/KinfolkProfileScreen.kt` (read-only; dossier via `dossierStream(kinfolkId)` already loaded ~line 99; `onOpenHousehold` nav to `HouseholdDataScreen.kt`). Web household editor: `screens/directory/HouseholdDataScreen.kt` (full editor, `getHouseholdData` in a `LaunchedEffect`, `saveHouseholdData` on Save).
- Android profile: `ui/directory/KinfolkProfileScreen.kt` + `DirectoryViewModel` (`ProfileUiState` has `dossier`; `loadProfile(kinfolkId)`). Android household editor: `ui/.../HouseholdDataScreen.kt` + `HouseholdDataViewModel`.
- Fail-loud patterns: web `StatusToast`/`WriteResult` Ok/Err; android error cards + `Result` onSuccess/onFailure.

## File Structure

**Backend** — `web/functions-python/`: `main.py` (new callable), `reconcile_comms.py` (new `clear_dossier_household_notes` helper, OR keep the doc-locate inline in main — see Task 1), `test_clear_dossier_household_notes.py` (new).
**Clients** — web `FirestoreClient.kt` (+`clearDossierHouseholdNotes`); android `AuntieRepository.kt` (+`clearDossierHouseholdNotes`).
**Helper** — web `screens/directory/HouseholdMigration.kt` (new) + commonTest; android `ui/directory/HouseholdMigration.kt` (new) + test.
**UI** — web `KinfolkProfileScreen.kt` + `HouseholdDataScreen.kt`; android `KinfolkProfileScreen.kt` + `DirectoryViewModel.kt` + `HouseholdDataScreen.kt` + `HouseholdDataViewModel.kt`.

---

## Task 1: Backend — `clear_dossier_household_notes` callable (TDD)

**Files:**
- Modify: `web/functions-python/reconcile_comms.py` (add `clear_dossier_household_notes_doc`)
- Modify: `web/functions-python/main.py` (add `_clear_dossier_household_notes` + decorated callable)
- Test: `web/functions-python/test_clear_dossier_household_notes.py` (create)

Commands from `web/functions-python/`, venv: `./venv/bin/python`.

- [ ] **Step 1: Write the failing test.** Create `test_clear_dossier_household_notes.py`:

```python
"""Tests for clear_dossier_household_notes: auth/validation + sets householdNotes=""
on the right dossier doc (deterministic id OR legacy auto-id). FakeDb, no live Firestore.
"""
import pytest
from unittest.mock import MagicMock

from firebase_functions.https_fn import CallableRequest, FunctionsErrorCode, HttpsError, AuthData

import reconcile_comms as rc
from main import _clear_dossier_household_notes


class FakeSnap:
    def __init__(self, _id, data):
        self.id = _id
        self._data = data
    def to_dict(self):
        return dict(self._data)

class FakeDocRef:
    def __init__(self, db, coll, doc_id):
        self._db = db; self._coll = coll; self._id = doc_id
    @property
    def id(self):
        return self._id
    def set(self, data, merge=False):
        store = self._db.data.setdefault(self._coll, {})
        cur = dict(store.get(self._id, {})) if merge else {}
        cur.update(data)
        store[self._id] = cur

class FakeQuery:
    def __init__(self, db, coll, docs):
        self._db = db; self._coll = coll; self._docs = docs
    def where(self, field, op, value):
        return FakeQuery(self._db, self._coll, [d for d in self._docs if d._data.get(field) == value])
    def limit(self, n):
        return FakeQuery(self._db, self._coll, self._docs[:n])
    def stream(self):
        return iter(self._docs)

class FakeCollection(FakeQuery):
    def document(self, doc_id):
        return FakeDocRef(self._db, self._coll, doc_id)

class FakeDb:
    def __init__(self):
        self.data = {}
    def collection(self, name):
        docs = [FakeSnap(k, v) for k, v in self.data.get(name, {}).items()]
        return FakeCollection(self, name, docs)

FAKE_DB = FakeDb()


def _make_req(data, auth):
    return CallableRequest(data=data, raw_request=MagicMock(), auth=auth)

def _admin():
    return AuthData(uid="admin-uid", token={"uid": "admin-uid", "admin": True})

def _non_admin():
    return AuthData(uid="u", token={"uid": "u"})


def test_non_admin_rejected():
    with pytest.raises(HttpsError) as ei:
        _clear_dossier_household_notes(_make_req({"kinfolkId": "kf1"}, _non_admin()), FAKE_DB)
    assert ei.value.code == FunctionsErrorCode.PERMISSION_DENIED


def test_missing_kinfolk_id_rejected():
    with pytest.raises(HttpsError) as ei:
        _clear_dossier_household_notes(_make_req({}, _admin()), FAKE_DB)
    assert ei.value.code == FunctionsErrorCode.INVALID_ARGUMENT


def test_clears_notes_on_deterministic_doc():
    db = FakeDb()
    db.data["dossiers"] = {"kf1": {"kinfolkId": "kf1", "householdNotes": "partner Bill, daughters weekends", "rawSummary": "keep me"}}
    res = _clear_dossier_household_notes(_make_req({"kinfolkId": "kf1"}, _admin()), db)
    assert res == {"kinfolkId": "kf1", "cleared": True}
    assert db.data["dossiers"]["kf1"]["householdNotes"] == ""
    assert db.data["dossiers"]["kf1"]["rawSummary"] == "keep me"  # other fields untouched


def test_clears_notes_on_legacy_autoid_doc():
    db = FakeDb()
    db.data["dossiers"] = {"auto_xyz": {"kinfolkId": "kf2", "householdNotes": "notes"}}
    res = _clear_dossier_household_notes(_make_req({"kinfolkId": "kf2"}, _admin()), db)
    assert res == {"kinfolkId": "kf2", "cleared": True}
    assert db.data["dossiers"]["auto_xyz"]["householdNotes"] == ""


def test_no_dossier_returns_not_cleared_without_creating_doc():
    db = FakeDb()
    res = _clear_dossier_household_notes(_make_req({"kinfolkId": "ghost"}, _admin()), db)
    assert res == {"kinfolkId": "ghost", "cleared": False}
    assert "dossiers" not in db.data or "ghost" not in db.data.get("dossiers", {})
```

- [ ] **Step 2: Run to verify it fails.**
Run: `./venv/bin/python -m pytest test_clear_dossier_household_notes.py -v`
Expected: FAIL — `cannot import name '_clear_dossier_household_notes' from 'main'`.

- [ ] **Step 3: Add the doc-locate-and-clear helper to `reconcile_comms.py`.** After `upsert_dossier` (after ~line 363), add:

```python
def clear_dossier_household_notes_doc(db, kinfolk_id: str) -> bool:
    """Set householdNotes="" on the kinfolk's dossier doc, locating it the same way
    upsert_dossier does (query by kinfolkId, which handles legacy auto-id docs).

    Does NOT create a dossier if none exists (nothing to clear). Returns True if a
    doc was found and cleared, False if there was no dossier.
    """
    q = db.collection("dossiers").where("kinfolkId", "==", kinfolk_id).limit(1).stream()
    existing = next(q, None)
    if existing is None:
        return False
    db.collection("dossiers").document(existing.id).set({"householdNotes": ""}, merge=True)
    return True
```

- [ ] **Step 4: Add the callable to `main.py`.** After the `recap_recent_comms` callable, add:

```python
def _clear_dossier_household_notes(req: https_fn.CallableRequest, db_handle) -> dict:
    from reconcile_comms import clear_dossier_household_notes_doc

    if req.auth is None or not req.auth.token.get("admin"):
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            message="Admin only",
        )
    kinfolk_id = (req.data.get("kinfolkId") or "").strip()
    if not kinfolk_id:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="kinfolkId required",
        )
    cleared = clear_dossier_household_notes_doc(db_handle, kinfolk_id)
    return {"kinfolkId": kinfolk_id, "cleared": cleared}


@https_fn.on_call(
    region=_REGION,
    memory=_MEMORY,
    timeout_sec=120,
    secrets=_SECRETS,
)
def clear_dossier_household_notes(req: https_fn.CallableRequest) -> dict:
    from reconcile_comms import init_firebase
    db = init_firebase()
    return _clear_dossier_household_notes(req, db)
```

- [ ] **Step 5: Run to verify it passes.**
Run: `./venv/bin/python -m pytest test_clear_dossier_household_notes.py -v`
Expected: PASS (5 passed).

- [ ] **Step 6: Full backend suite (no regression).**
Run: `./venv/bin/python -m pytest -q`
Expected: PASS (all green — was 39, now 44).

---

## Task 2: Clients — `clearDossierHouseholdNotes` (web + android)

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt`
- Modify: `android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt`

- [ ] **Step 1: Web client method.** Mirror `synthesizeProfile` (~line 293). Add near it:

```kotlin
/**
 * Admin-gated: clears the kinfolk's dossier householdNotes (after the admin has
 * migrated the content into structured HouseholdData). Fail-loud via WriteResult.Err.
 */
suspend fun clearDossierHouseholdNotes(kinfolkId: String): WriteResult<Unit> {
    val payload = buildJsonObject { put("kinfolkId", JsonPrimitive(kinfolkId)) }
    return when (val r = platformInvokeCallable("clear_dossier_household_notes", callableJson.encodeToString(JsonObject.serializer(), payload))) {
        is WriteResult.Err -> WriteResult.Err(r.message)
        is WriteResult.Ok -> runCatching {
            callableJson.parseToJsonElement(r.value).jsonObject
            WriteResult.Ok(Unit)
        }.getOrElse { WriteResult.Err(it.message ?: "clear notes decode failed") }
    }
}
```

- [ ] **Step 2: Android repo method.** Mirror `synthesizeProfile` (~line 549). Add near it:

```kotlin
suspend fun clearDossierHouseholdNotes(kinfolkId: String): Result<Unit> = runCatching {
    AuntieLog.i("Clearing dossier household notes for kinfolk: $kinfolkId")
    ensureAuthenticated()
    withContext(Dispatchers.IO) {
        functions.getHttpsCallable("clear_dossier_household_notes")
            .call(mapOf("kinfolkId" to kinfolkId))
            .await()
    }
    Unit
}.onFailure { AuntieLog.e("Failed to clear dossier household notes for $kinfolkId", it) }
```

- [ ] **Step 3: Compile gates.**
Run: `cd web && ./gradlew :composeApp:compileKotlinWasmJs`
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*config.FeatureFlagsTest"` (cheap target that forces main compile)
Expected: both PASS.

---

## Task 3: Pure helper — `missingHouseholdFields` (web, TDD)

**Files:**
- Create: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/HouseholdMigration.kt`
- Create: `web/composeApp/src/commonTest/kotlin/com/tribetails/auntieos/web/screens/directory/HouseholdMigrationTest.kt`

- [ ] **Step 1: Write the failing tests.** Create `HouseholdMigrationTest.kt`:

```kotlin
package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.HouseholdData
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HouseholdMigrationTest {

    @Test fun empty_household_lists_all_30_fields_in_catalog_order() {
        val missing = missingHouseholdFields(HouseholdData())
        assertEquals(30, missing.size)
        assertEquals("primaryVetName", missing.first().key)
        assertEquals("Primary vet name", missing.first().label)
        assertEquals("dogWalkerBackup", missing.last().key)
    }

    @Test fun fully_filled_household_has_no_missing_fields() {
        // every content field non-blank
        val full = HouseholdData(
            primaryVetName = "a", primaryVetPhone = "a", primaryVetAddress = "a", primaryVetHours = "a",
            emergencyVetName = "a", emergencyVetPhone = "a", emergencyVetAddress = "a",
            foodLocation = "a", treatLocation = "a", medicationLocation = "a", toysLocation = "a",
            beddingLocation = "a", leashesPoopBagsLocation = "a", cleaningSuppliesLocation = "a",
            householdRules = "a", preferredWalkRoutes = "a", neighborhoodHazards = "a",
            securitySystemInfo = "a", thermostatInstructions = "a", lightingPreferences = "a",
            poisonControlNumber = "a", emergencyContactsPriority = "a", evacuationPlan = "a",
            importantDocumentsLocation = "a", groomerName = "a", groomerPhone = "a",
            trainerName = "a", trainerPhone = "a", petSitterBackup = "a", dogWalkerBackup = "a",
        )
        assertTrue(missingHouseholdFields(full).isEmpty())
    }

    @Test fun partial_household_returns_only_blanks_in_order() {
        val partial = HouseholdData(primaryVetName = "Dr Vet", foodLocation = "pantry")
        val missing = missingHouseholdFields(partial)
        assertTrue(missing.none { it.key == "primaryVetName" })
        assertTrue(missing.none { it.key == "foodLocation" })
        assertEquals("primaryVetPhone", missing.first().key) // first remaining blank in order
        assertEquals(28, missing.size)
    }

    @Test fun whitespace_only_counts_as_missing() {
        val ws = HouseholdData(primaryVetName = "   ")
        assertTrue(missingHouseholdFields(ws).any { it.key == "primaryVetName" })
    }
}
```

- [ ] **Step 2: Run to verify it fails.**
Run: `cd web && ./gradlew :composeApp:jvmTest --tests "*HouseholdMigrationTest*"`
Expected: FAIL — unresolved `missingHouseholdFields` / `MissingHouseholdField`.

- [ ] **Step 3: Implement the helper.** Create `HouseholdMigration.kt`:

```kotlin
package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.HouseholdData

/** A structured HouseholdData field that is still empty (for the migration gap list). */
data class MissingHouseholdField(val key: String, val label: String)

private class HField(val key: String, val label: String, val get: (HouseholdData) -> String)

// Canonical ordered catalog of the 30 content fields (excludes _id/kinfolkId/createdAt/updatedAt).
// Owned by the helper so the gap list is identical across web + android.
private val HOUSEHOLD_FIELDS: List<HField> = listOf(
    HField("primaryVetName", "Primary vet name") { it.primaryVetName },
    HField("primaryVetPhone", "Primary vet phone") { it.primaryVetPhone },
    HField("primaryVetAddress", "Primary vet address") { it.primaryVetAddress },
    HField("primaryVetHours", "Primary vet hours") { it.primaryVetHours },
    HField("emergencyVetName", "Emergency vet name") { it.emergencyVetName },
    HField("emergencyVetPhone", "Emergency vet phone") { it.emergencyVetPhone },
    HField("emergencyVetAddress", "Emergency vet address") { it.emergencyVetAddress },
    HField("foodLocation", "Food location") { it.foodLocation },
    HField("treatLocation", "Treat location") { it.treatLocation },
    HField("medicationLocation", "Medication location") { it.medicationLocation },
    HField("toysLocation", "Toys location") { it.toysLocation },
    HField("beddingLocation", "Bedding location") { it.beddingLocation },
    HField("leashesPoopBagsLocation", "Leashes & poop bags location") { it.leashesPoopBagsLocation },
    HField("cleaningSuppliesLocation", "Cleaning supplies location") { it.cleaningSuppliesLocation },
    HField("householdRules", "Household rules") { it.householdRules },
    HField("preferredWalkRoutes", "Preferred walk routes") { it.preferredWalkRoutes },
    HField("neighborhoodHazards", "Neighborhood hazards") { it.neighborhoodHazards },
    HField("securitySystemInfo", "Security system info") { it.securitySystemInfo },
    HField("thermostatInstructions", "Thermostat instructions") { it.thermostatInstructions },
    HField("lightingPreferences", "Lighting preferences") { it.lightingPreferences },
    HField("poisonControlNumber", "Poison control number") { it.poisonControlNumber },
    HField("emergencyContactsPriority", "Emergency contacts priority") { it.emergencyContactsPriority },
    HField("evacuationPlan", "Evacuation plan") { it.evacuationPlan },
    HField("importantDocumentsLocation", "Important documents location") { it.importantDocumentsLocation },
    HField("groomerName", "Groomer name") { it.groomerName },
    HField("groomerPhone", "Groomer phone") { it.groomerPhone },
    HField("trainerName", "Trainer name") { it.trainerName },
    HField("trainerPhone", "Trainer phone") { it.trainerPhone },
    HField("petSitterBackup", "Backup pet sitter") { it.petSitterBackup },
    HField("dogWalkerBackup", "Backup dog walker") { it.dogWalkerBackup },
)

/** The empty HouseholdData fields (key+label), in canonical order, for the migration gap list. */
fun missingHouseholdFields(household: HouseholdData): List<MissingHouseholdField> =
    HOUSEHOLD_FIELDS.filter { it.get(household).isBlank() }
        .map { MissingHouseholdField(it.key, it.label) }

/** True when a field key is still empty, used to flag fields in the household editor. */
fun isHouseholdFieldMissing(household: HouseholdData, key: String): Boolean =
    missingHouseholdFields(household).any { it.key == key }
```

- [ ] **Step 4: Run to verify it passes.**
Run: `cd web && ./gradlew :composeApp:jvmTest --tests "*HouseholdMigrationTest*"`
Expected: PASS (4 passed).

- [ ] **Step 5: Wasm compile gate.**
Run: `cd web && ./gradlew :composeApp:compileKotlinWasmJs`
Expected: PASS.

---

## Task 4: Pure helper — `missingHouseholdFields` (android, verbatim)

**Files:**
- Create: `android/app/src/main/java/com/tribetails/auntieos/ui/directory/HouseholdMigration.kt`
- Create: `android/app/src/test/java/com/tribetails/auntieos/ui/directory/HouseholdMigrationTest.kt`

- [ ] **Step 1: Write the failing tests** (org.junit). Create `HouseholdMigrationTest.kt` — SAME assertions as web Task 3 Step 1, with android package + import `com.tribetails.auntieos.data.model.HouseholdData` and `org.junit` asserts:

```kotlin
package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HouseholdMigrationTest {
    @Test fun empty_household_lists_all_30_fields_in_catalog_order() {
        val missing = missingHouseholdFields(HouseholdData())
        assertEquals(30, missing.size)
        assertEquals("primaryVetName", missing.first().key)
        assertEquals("Primary vet name", missing.first().label)
        assertEquals("dogWalkerBackup", missing.last().key)
    }

    @Test fun fully_filled_household_has_no_missing_fields() {
        val full = HouseholdData(
            primaryVetName = "a", primaryVetPhone = "a", primaryVetAddress = "a", primaryVetHours = "a",
            emergencyVetName = "a", emergencyVetPhone = "a", emergencyVetAddress = "a",
            foodLocation = "a", treatLocation = "a", medicationLocation = "a", toysLocation = "a",
            beddingLocation = "a", leashesPoopBagsLocation = "a", cleaningSuppliesLocation = "a",
            householdRules = "a", preferredWalkRoutes = "a", neighborhoodHazards = "a",
            securitySystemInfo = "a", thermostatInstructions = "a", lightingPreferences = "a",
            poisonControlNumber = "a", emergencyContactsPriority = "a", evacuationPlan = "a",
            importantDocumentsLocation = "a", groomerName = "a", groomerPhone = "a",
            trainerName = "a", trainerPhone = "a", petSitterBackup = "a", dogWalkerBackup = "a",
        )
        assertTrue(missingHouseholdFields(full).isEmpty())
    }

    @Test fun partial_household_returns_only_blanks_in_order() {
        val partial = HouseholdData(primaryVetName = "Dr Vet", foodLocation = "pantry")
        val missing = missingHouseholdFields(partial)
        assertTrue(missing.none { it.key == "primaryVetName" })
        assertTrue(missing.none { it.key == "foodLocation" })
        assertEquals("primaryVetPhone", missing.first().key)
        assertEquals(28, missing.size)
    }

    @Test fun whitespace_only_counts_as_missing() {
        assertTrue(missingHouseholdFields(HouseholdData(primaryVetName = "   ")).any { it.key == "primaryVetName" })
    }
}
```
NOTE: android `HouseholdData` uses positional/`var` constructor params — confirm the constructor accepts these named args (it does; all have defaults). If android `HouseholdData` is constructed differently, adjust the test to set fields via copy.

- [ ] **Step 2: Run to verify it fails.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*directory.HouseholdMigrationTest"`
Expected: FAIL — unresolved references.

- [ ] **Step 3: Implement the helper** — SAME body as web Task 3 Step 3 with android package + `import com.tribetails.auntieos.data.model.HouseholdData`. Create `HouseholdMigration.kt` (package `com.tribetails.auntieos.ui.directory`). The 30-entry catalog + `MissingHouseholdField` + `missingHouseholdFields` + `isHouseholdFieldMissing` are identical (android `HouseholdData` has the same field names).

- [ ] **Step 4: Run to verify it passes.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*directory.HouseholdMigrationTest"`
Expected: PASS (4 passed).

---

## Task 5: Web — migration box on `KinfolkProfileScreen`

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/KinfolkProfileScreen.kt`

- [ ] **Step 1: Read the screen.** Confirm: dossier loaded via `dossierStream(kinfolkId)` (~line 99) into `dossier`; `client` handle; `Panel(...)` composable; `StatusToast`/`ToastKind` import + the existing invite toast pattern (~136-158); `scope = rememberCoroutineScope()`. Confirm `getHouseholdData` exists on `client`.

- [ ] **Step 2: Load HouseholdData on the profile.** Near the dossier collection, add a one-shot load + a refresh trigger:

```kotlin
val dossierValue = (dossier as? FirestoreResult.Data)?.value
var household by remember(kinfolkId) { mutableStateOf<HouseholdData?>(null) }
LaunchedEffect(kinfolkId) {
    (client.getHouseholdData(kinfolkId) as? WriteResult.Ok)?.let { household = it.value }
}
```
(Import `HouseholdData` + `WriteResult` if not present.)

- [ ] **Step 3: Add the migration box.** Render it inside the column where the Dossier panel renders (right after the Dossier `Panel`, ~line 340), gated on a non-empty `householdNotes`:

```kotlin
val notes = dossierValue?.householdNotes.orEmpty()
if (notes.isNotBlank()) {
    var clearBusy by remember { mutableStateOf(false) }
    var clearToast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }
    Spacer(Modifier.height(18.dp))
    Panel(title = "Household notes (from dossier)", icon = Lucide.NotebookPen, tone = AuntieStatusTone.Orange) {
        Text("Admin only / internal", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
        Spacer(Modifier.height(8.dp))
        Text(notes, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
        val gaps = household?.let { missingHouseholdFields(it) }.orEmpty()
        if (household == null) {
            Spacer(Modifier.height(8.dp))
            Text("Loading household data…", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        } else if (gaps.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Text("Still missing in Household Data (${gaps.size}):", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
            Text(gaps.joinToString(", ") { it.label }, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
            Spacer(Modifier.height(10.dp))
            // Primary action: go fill the structured fields (existing editor).
            GhostButton(text = "Open household data", onClick = onOpenHousehold)
        } else {
            Spacer(Modifier.height(10.dp))
            Text("All structured fields are filled. Safe to clear from the dossier.", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
        }
        Spacer(Modifier.height(10.dp))
        GhostButton(
            text = if (clearBusy) "Clearing…" else "Clear from dossier",
            enabled = !clearBusy,
            onClick = {
                clearBusy = true
                scope.launch {
                    clearToast = when (val r = client.clearDossierHouseholdNotes(kinfolkId)) {
                        is WriteResult.Ok -> "Cleared household notes from the dossier." to ToastKind.Success
                        is WriteResult.Err -> "Clear failed: ${r.message}" to ToastKind.Error
                    }
                    clearBusy = false
                    // dossierStream is live — the box hides automatically once householdNotes clears.
                }
            },
        )
    }
    clearToast?.let { (msg, kind) -> StatusToast(visible = true, message = msg, kind = kind, onDismiss = { clearToast = null }) }
}
```
Notes:
- Use the ACTUAL button composable this file uses (`GhostButton` or equivalent — read a sibling button on the screen, e.g. the portal-invite button, and match it). Do NOT invent.
- Match the theme/color handles the file already uses (`AuntieTheme.colors.textDim`/`textPrimary`, `AuntieStatusTone`, `Lucide` icon). 
- The box auto-hides after a successful clear because `dossierStream` re-emits `householdNotes=""`. No manual refetch needed on web.

- [ ] **Step 4: Compile + test gates.**
Run: `cd web && ./gradlew :composeApp:jvmTest :composeApp:compileKotlinWasmJs`
Expected: PASS.

---

## Task 6: Web — household editor fill-in reference + empty flags (`HouseholdDataScreen`)

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/HouseholdDataScreen.kt`

- [ ] **Step 1: Read the editor.** Confirm: `getHouseholdData` load in `LaunchedEffect`, the per-field state vars + `BottomBorderField`/`MultilineField` calls + their labels, the Save `build()`/`saveHouseholdData` flow, `client` + `dossierStream`/`getDossier` availability.

- [ ] **Step 2: Load the dossier notes for reference.** In the screen, add:

```kotlin
var dossierNotes by remember(kinfolkId) { mutableStateOf("") }
LaunchedEffect(kinfolkId) {
    val d = client.dossierStream(kinfolkId)  // or getDossier if a one-shot exists
    // collect once:
    d.collect { res ->
        dossierNotes = (res as? FirestoreResult.Data)?.value?.householdNotes.orEmpty()
        return@collect
    }
}
```
If `dossierStream` is a hot Flow that won't complete, instead use a one-shot read if available, or collect with `.firstOrNull()`-style. SIMPLEST robust option: collect into the existing pattern the screen uses for streams; the goal is just to read `householdNotes` once. Match how the screen consumes Flows (it may already collect dossier elsewhere — reuse).

- [ ] **Step 3: Show the reference card at the top of the form** (only when non-blank):

```kotlin
if (dossierNotes.isNotBlank()) {
    Panel(title = "From dossier (reference)", icon = Lucide.NotebookPen, tone = AuntieStatusTone.Orange) {
        Text("Admin only / internal — copy details into the fields below, then clear it on the profile.", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
        Spacer(Modifier.height(8.dp))
        Text(dossierNotes, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
    }
    Spacer(Modifier.height(18.dp))
}
```
Match the screen's actual panel/section composable.

- [ ] **Step 4: Flag empty fields (light touch).** For each `BottomBorderField`/`MultilineField`, when its current state value is blank, append a subtle " (empty)" hint to the label OR tint the label with `textDim`. Implement via a tiny local helper to avoid 30 edits, e.g. wrap the label:

```kotlin
fun fieldLabel(base: String, value: String): String = if (value.isBlank()) "$base · empty" else base
// usage: BottomBorderField(label = fieldLabel("Primary vet name", primaryVetName), value = primaryVetName, ...)
```
Apply `fieldLabel(...)` to each field's `label` argument. (This is the spec's "empty fields highlighted" — minimal, no behavior change.)

- [ ] **Step 5: Compile + test gates.**
Run: `cd web && ./gradlew :composeApp:jvmTest :composeApp:compileKotlinWasmJs`
Expected: PASS.

---

## Task 7: Android — migration box on `KinfolkProfileScreen` + ViewModel

**Files:**
- Modify: `android/app/src/main/java/com/tribetails/auntieos/ui/directory/DirectoryViewModel.kt`
- Modify: `android/app/src/main/java/com/tribetails/auntieos/ui/directory/KinfolkProfileScreen.kt`
- Test: `android/app/src/test/java/com/tribetails/auntieos/ui/directory/DirectoryViewModelTest.kt` (if it exists; else add a focused test file)

- [ ] **Step 1: ViewModel — load HouseholdData into the profile state + clear action.**
  - Add `val householdData: HouseholdData? = null` to `ProfileUiState`.
  - In `loadProfile(kinfolkId)`, add `val householdDef = async { repo.getHouseholdData(kinfolkId) }` and set `householdData = householdDef.await().getOrNull()` in the emitted `ProfileUiState`.
  - Add a clear action:
    ```kotlin
    fun clearDossierHouseholdNotes(kinfolkId: String) {
        viewModelScope.launch {
            repo.clearDossierHouseholdNotes(kinfolkId)
                .onSuccess { loadProfile(kinfolkId) }   // one-shot dossier → reload so the box hides
                .onFailure { _inviteMessage.value = "Clear failed: ${it.message}" }  // reuse the existing toast channel, or add a dedicated one
        }
    }
    ```
    (If reusing `inviteMessage` is awkward, add a `clearMessage` StateFlow mirroring `inviteMessage`.)

- [ ] **Step 2: Screen — render the migration box.** In `KinfolkProfileScreen.kt`, after the `DossierCard` (~line 434), add (gated on non-blank notes):

```kotlin
val notes = state.dossier?.householdNotes.orEmpty()
if (notes.isNotBlank()) {
    item {
        AuntieCard(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("HOUSEHOLD NOTES (FROM DOSSIER)", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
                Text("Admin only / internal", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
                Text(notes, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
                val gaps = state.householdData?.let { missingHouseholdFields(it) }.orEmpty()
                when {
                    state.householdData == null -> Text("Loading household data…", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                    gaps.isNotEmpty() -> {
                        Text("Still missing in Household Data (${gaps.size}):", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
                        Text(gaps.joinToString(", ") { it.label }, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
                        TextButton(onClick = { onNavigateToHouseholdData(kinfolk.id, kinfolk.displayName) }) { Text("Open household data") }
                    }
                    else -> Text("All structured fields are filled. Safe to clear from the dossier.", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
                }
                TextButton(onClick = { viewModel.clearDossierHouseholdNotes(kinfolk.id) }) { Text("Clear from dossier") }
            }
        }
    }
}
```
Match the file's actual card/button/theme handles (`AuntieCard`, `TextButton`/`AuntieButton`, `AuntieTheme.colors.*`, `onNavigateToHouseholdData`). Import `missingHouseholdFields`.

- [ ] **Step 3: Test the VM load + clear.** Add a focused test (mirror the existing DirectoryViewModel test setup; mockk repo). Assert: after `loadProfile`, `state.householdData` is set from `repo.getHouseholdData`; calling `clearDossierHouseholdNotes` invokes `repo.clearDossierHouseholdNotes` and re-calls `loadProfile`. Stub `repo.getHouseholdData`/`getDossier`/`clearDossierHouseholdNotes` with successes. If no DirectoryViewModel test harness exists, create `DirectoryViewModelTest.kt` mirroring `CommunicateViewModelTest` conventions (mockk, runTest, advanceUntilIdle, `Dispatchers.setMain`).

- [ ] **Step 4: Build gates.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*directory.*" :app:assembleDebug`
Expected: PASS (the only allowed full-suite failure remains the known flaky `KinTaleReportDeliveryTest`).

---

## Task 8: Android — household editor fill-in reference + empty flags

**Files:**
- Modify: `android/app/src/main/java/com/tribetails/auntieos/ui/.../HouseholdDataViewModel.kt`
- Modify: `android/app/src/main/java/com/tribetails/auntieos/ui/.../HouseholdDataScreen.kt`

- [ ] **Step 1: ViewModel — load the dossier notes.** Add `val dossierNotes: String = ""` to the editor's UI state; in its load (where it fetches household data), also `repo.getDossier(kinfolkId)` and set `dossierNotes = it.householdNotes`.

- [ ] **Step 2: Screen — reference card at the top** (only when non-blank):

```kotlin
if (state.dossierNotes.isNotBlank()) {
    item {
        AuntieCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("FROM DOSSIER (REFERENCE)", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
                Text("Admin only / internal — copy details into the fields below, then clear it on the profile.", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
                Text(state.dossierNotes, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
            }
        }
    }
}
```

- [ ] **Step 3: Flag empty fields (light touch).** Mirror web: a tiny `fun fieldLabel(base: String, value: String) = if (value.isBlank()) "$base · empty" else base`, applied to each editor field's `label`. Match the android field composable signature.

- [ ] **Step 4: Build gates.**
Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "*HouseholdData*" :app:assembleDebug`
Expected: PASS.

---

## Task 9: Full verification (all platforms)

(REQUIRED SUB-SKILL: superpowers:verification-before-completion — evidence before claims.)

- [ ] **Step 1: Backend.** `cd web/functions-python && ./venv/bin/python -m pytest -q` → all PASS (incl. `test_clear_dossier_household_notes.py`).
- [ ] **Step 2: Web.** `cd web && ./gradlew :composeApp:jvmTest --rerun-tasks :composeApp:compileKotlinWasmJs` → all PASS (incl. `HouseholdMigrationTest`).
- [ ] **Step 3: Android.** `cd android && ./gradlew :app:testDebugUnitTest --rerun-tasks :app:assembleDebug` → only the known pre-existing flaky `KinTaleReportDeliveryTest.sentReport_showsGpsRouteStats` may fail; everything else green incl. `HouseholdMigrationTest` + the DirectoryViewModel test; `assembleDebug` SUCCESSFUL.
- [ ] **Step 4: Anti-slop pass** over new user-facing strings ("Household notes (from dossier)", "Admin only / internal", "Still missing in Household Data", "Open household data", "Clear from dossier", "From dossier (reference) …", "· empty"). Revise anything sloppy; keep plain.
- [ ] **Step 5: Record results** in `.remember/remember.md` (direct Write per the broken `/remember` note) — note Phase 2 done, Phase 3 remaining, nothing deployed.

---

## Self-Review (recorded for the executor)

**Spec coverage (Phase 2 section of the spec):**
- Admin-only "Household notes (from dossier)" box on KinfolkProfileScreen (web+android), shown only when `dossier.householdNotes` non-empty, "Admin only / internal" marker, gap list from `missingHouseholdFields` → Tasks 5, 7. ✓
- Edit mode: blob read-only beside HouseholdData fields, empty fields flagged, admin fills via existing `saveHouseholdData` → Tasks 6, 8 (reference card + `· empty` flags + existing save reused). ✓
- "Clear from dossier" → `clearDossierHouseholdNotes(kinfolkId)`, box disappears once cleared → Tasks 1, 2, 5, 7 (web auto-hides via live `dossierStream`; android reloads profile). ✓
- `missingHouseholdFields` via TDD (commonTest + android unit) → Tasks 3, 4. ✓
- Fail-loud on the clear write → Tasks 5, 7 (toast/message on Err). ✓
- New callable in `web/functions-python` + pytest → Task 1. ✓
- Per-platform build gates → Task 9. ✓

**Type consistency:** `MissingHouseholdField(key,label)`, `missingHouseholdFields(HouseholdData)→List`, `isHouseholdFieldMissing`, callable `clear_dossier_household_notes` + payload key `kinfolkId` + result `{kinfolkId, cleared}`, clients `clearDossierHouseholdNotes` — consistent across backend, web, android. 30-field catalog identical both helper copies.

**Placeholder scan:** UI tasks point at mapped edit points with real handles; the genuinely environment-dependent bits (exact button composable, how the screen collects the dossier Flow, the editor field-label call shape) are flagged "match the file's existing handle — do not invent," not left as vague TODOs.

**Risk note:** Web household-editor dossier read (Task 6 Step 2) is the one spot needing care — `dossierStream` is a live Flow; collect it the way the screen already consumes streams (or a one-shot read) rather than blocking. Flagged in the task.
