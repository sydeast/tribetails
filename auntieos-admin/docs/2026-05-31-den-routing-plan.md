# Den Redesign Phase A1 — Thin Hash Router Implementation Plan

> **HISTORICAL, written 2026-05-31. Executed. Do not run this as a plan.**
> It targets the Compose/wasm admin, superseded by `auntieos-admin/src` (React)
> on 2026-07-20, so the hash router it builds is not the router the live admin
> uses. Read it for the routing model, not as work to do.
>
> Its original header said "NO GIT in this project ... Do NOT run git." That was
> true on 2026-05-31 and is wrong now: this repo is under git with CI
> (`.github/workflows/ci.yml`), and the workflow is branch per task, never
> commit on `main`, land through a PR. The "verify-checkpoint (no git)" steps
> below should be read as build/test checkpoints, which they still are.

**Goal:** Sync AuntieOS web nav state (`Destination` + detail vars in `App.kt`) with `window.location.hash`, enabling deep-links, refresh-stays-put, back/forward, and per-screen screenshot verification for the redesign.

**Architecture:** Pure `Route` model + `parseHash`/`routeToHash` in commonMain (JVM-unit-tested). Platform `UrlHash` via expect/actual (wasmJs = `window.location.hash` + `hashchange`; jvm = in-memory no-op). `App.kt` wires route <-> (`current` + detail vars) with two `LaunchedEffect`s.

**Tech Stack:** Kotlin Multiplatform, Compose, `kotlinx.browser` (wasmJs), kotlin.test (jvmTest).

---

## File Structure

- Create `composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/ui/shell/Route.kt` — pure `Route` data class + `parseHash` + `routeToHash`. One responsibility: route <-> string.
- Create `composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/ui/shell/UrlHash.kt` — `expect` surface: `currentHash()`, `setHash(v)`, `observeHash(onChange)`.
- Create `composeApp/src/wasmJsMain/kotlin/com/tribetails/auntieos/web/ui/shell/UrlHash.wasmJs.kt` — actual via `kotlinx.browser.window`.
- Create `composeApp/src/jvmMain/kotlin/com/tribetails/auntieos/web/ui/shell/UrlHash.jvm.kt` — actual in-memory (desktop has no URL).
- Create `composeApp/src/jvmTest/kotlin/com/tribetails/auntieos/web/ui/shell/RouteTest.kt` — TDD for parse/encode round-trips.
- Modify `composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/App.kt:129-237` — wire router to `current` + detail vars.

---

## Task 1: Pure Route model + parse/encode (TDD)

**Files:**
- Create: `composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/ui/shell/Route.kt`
- Test: `composeApp/src/jvmTest/kotlin/com/tribetails/auntieos/web/ui/shell/RouteTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.tribetails.auntieos.web.ui.shell

import kotlin.test.Test
import kotlin.test.assertEquals

class RouteTest {
    @Test fun topLevel_roundTrips() {
        for (d in Destination.values()) {
            val hash = routeToHash(Route(d))
            assertEquals(Route(d), parseHash(hash), "round-trip failed for $d ($hash)")
        }
    }

    @Test fun home_isDefaultForEmptyOrUnknown() {
        assertEquals(Route(Destination.Home), parseHash(""))
        assertEquals(Route(Destination.Home), parseHash("#/"))
        assertEquals(Route(Destination.Home), parseHash("#/totally-unknown"))
    }

    @Test fun detailRoutes_parseId() {
        assertEquals(Route(Destination.Invoices, detailId = "inv_42"), parseHash("#/invoices/inv_42"))
        assertEquals(Route(Destination.KinTales, detailId = "sess_9"), parseHash("#/kintales/sess_9"))
        assertEquals(Route(Destination.FormSchemas, detailId = "fs_1"), parseHash("#/form-schemas/fs_1"))
    }

    @Test fun mediaDetail_parsesTypeAndId() {
        assertEquals(
            Route(Destination.MediaGallery, detailId = "kin_7", detailType = "kin"),
            parseHash("#/media/kin/kin_7"),
        )
    }

    @Test fun detail_roundTrips() {
        val r = Route(Destination.Invoices, detailId = "inv_42")
        assertEquals(r, parseHash(routeToHash(r)))
        val m = Route(Destination.MediaGallery, detailId = "kin_7", detailType = "kin")
        assertEquals(m, parseHash(routeToHash(m)))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew -p web :composeApp:jvmTest --tests "com.tribetails.auntieos.web.ui.shell.RouteTest"`
Expected: FAIL — `Route` / `parseHash` / `routeToHash` unresolved.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.tribetails.auntieos.web.ui.shell

/** A resolved location: a top-level [dest] plus optional detail params. */
data class Route(
    val dest: Destination,
    val detailId: String? = null,
    val detailType: String? = null,
)

/** URL slug per destination. Stable, kebab-case. */
private val slugOf: Map<Destination, String> = mapOf(
    Destination.Home to "home",
    Destination.Communicate to "communicate",
    Destination.Directory to "directory",
    Destination.KinTales to "kintales",
    Destination.Bookings to "bookings",
    Destination.Sessions to "sessions",
    Destination.Schedule to "schedule",
    Destination.Invoices to "invoices",
    Destination.Payments to "payments",
    Destination.Inbox to "inbox",
    Destination.Activity to "activity",
    Destination.Settings to "settings",
    Destination.MediaGallery to "media",
    Destination.TrainingDocs to "training-docs",
    Destination.Notifications to "notifications",
    Destination.TemplateBank to "template-bank",
    Destination.TemplateAssignment to "template-assignment",
    Destination.FormSchemas to "form-schemas",
)
private val destOf: Map<String, Destination> = slugOf.entries.associate { (k, v) -> v to k }

/** Build a hash string ("#/slug" or "#/slug/id" or "#/media/type/id"). */
fun routeToHash(r: Route): String {
    val slug = slugOf[r.dest] ?: "home"
    return when {
        r.dest == Destination.MediaGallery && r.detailId != null ->
            "#/media/${r.detailType ?: "kin"}/${r.detailId}"
        r.detailId != null -> "#/$slug/${r.detailId}"
        else -> "#/$slug"
    }
}

/** Parse a hash string into a [Route]. Unknown/empty -> Home. */
fun parseHash(hash: String): Route {
    val parts = hash.removePrefix("#").removePrefix("/").trim('/')
        .split('/').filter { it.isNotBlank() }
    if (parts.isEmpty()) return Route(Destination.Home)
    val dest = destOf[parts[0]] ?: return Route(Destination.Home)
    return when {
        dest == Destination.MediaGallery && parts.size >= 3 ->
            Route(dest, detailId = parts[2], detailType = parts[1])
        parts.size >= 2 -> Route(dest, detailId = parts[1])
        else -> Route(dest)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew -p web :composeApp:jvmTest --tests "com.tribetails.auntieos.web.ui.shell.RouteTest"`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify-checkpoint (no git)**

Run: `./gradlew -p web :composeApp:jvmTest`
Expected: full jvmTest suite still green (no regressions).

---

## Task 2: UrlHash expect/actual

**Files:**
- Create: `composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/ui/shell/UrlHash.kt`
- Create: `composeApp/src/wasmJsMain/kotlin/com/tribetails/auntieos/web/ui/shell/UrlHash.wasmJs.kt`
- Create: `composeApp/src/jvmMain/kotlin/com/tribetails/auntieos/web/ui/shell/UrlHash.jvm.kt`

- [ ] **Step 1: Write the expect surface (commonMain)**

```kotlin
package com.tribetails.auntieos.web.ui.shell

/** Reads/writes the browser URL hash. No-op in-memory on non-web targets. */
expect fun currentHash(): String
expect fun setHash(value: String)
/** Register a listener for external hash changes (back/forward, manual edit). */
expect fun observeHash(onChange: (String) -> Unit)
```

- [ ] **Step 2: Write the wasmJs actual**

```kotlin
package com.tribetails.auntieos.web.ui.shell

import kotlinx.browser.window

actual fun currentHash(): String = window.location.hash

actual fun setHash(value: String) {
    // Avoid redundant writes that would re-trigger hashchange loops.
    if (window.location.hash != value) window.location.hash = value
}

actual fun observeHash(onChange: (String) -> Unit) {
    window.addEventListener("hashchange", { onChange(window.location.hash) })
}
```

- [ ] **Step 3: Write the jvm actual (in-memory)**

```kotlin
package com.tribetails.auntieos.web.ui.shell

private var memHash: String = ""

actual fun currentHash(): String = memHash
actual fun setHash(value: String) { memHash = value }
actual fun observeHash(onChange: (String) -> Unit) { /* desktop has no URL bar */ }
```

- [ ] **Step 4: Verify-checkpoint**

Run: `./gradlew -p web :composeApp:compileKotlinWasmJs :composeApp:compileKotlinJvm`
Expected: BUILD SUCCESSFUL (expect/actual resolves on both targets).

---

## Task 3: Wire router into App.kt

**Files:**
- Modify: `composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/App.kt` (the admin shell composable holding `current` + detail vars, around lines 129-237)

- [ ] **Step 1: Add imports** (top of App.kt, with other shell imports)

```kotlin
import androidx.compose.runtime.LaunchedEffect
import com.tribetails.auntieos.web.ui.shell.Route
import com.tribetails.auntieos.web.ui.shell.parseHash
import com.tribetails.auntieos.web.ui.shell.routeToHash
import com.tribetails.auntieos.web.ui.shell.currentHash
import com.tribetails.auntieos.web.ui.shell.setHash
import com.tribetails.auntieos.web.ui.shell.observeHash
```

- [ ] **Step 2: Seed nav state from the URL** — change line 129 so the initial screen comes from the hash, and add detail seeding. Replace:

```kotlin
    var current by remember { mutableStateOf(Destination.Home) }
    var selectedInvoiceId by remember { mutableStateOf<String?>(null) }
    var reportSessionId by remember { mutableStateOf<String?>(null) }
```

with:

```kotlin
    val initial = remember { parseHash(currentHash()) }
    var current by remember { mutableStateOf(initial.dest) }
    var selectedInvoiceId by remember { mutableStateOf(if (initial.dest == Destination.Invoices) initial.detailId else null) }
    var reportSessionId by remember { mutableStateOf(if (initial.dest == Destination.KinTales) initial.detailId else null) }
```

(Leave `mediaEntityId/Type/Name` and `editingFormSchemaId` declarations as-is on the following lines; they are seeded in Step 3's effect for completeness but default null is acceptable for first cut.)

- [ ] **Step 3: Add URL<-state and state<-URL sync effects** — immediately AFTER all the nav-state `var` declarations (after line ~136, before `AppShell(`), insert:

```kotlin
    // state -> URL: whenever the active route changes, reflect it in the hash.
    val activeRoute = Route(
        dest = current,
        detailId = when (current) {
            Destination.Invoices    -> selectedInvoiceId
            Destination.KinTales    -> reportSessionId
            Destination.FormSchemas -> editingFormSchemaId
            Destination.MediaGallery -> mediaEntityId
            else -> null
        },
        detailType = if (current == Destination.MediaGallery) mediaEntityType else null,
    )
    LaunchedEffect(activeRoute) { setHash(routeToHash(activeRoute)) }

    // URL -> state: respond to back/forward/manual hash edits.
    LaunchedEffect(Unit) {
        observeHash { h ->
            val r = parseHash(h)
            current = r.dest
            selectedInvoiceId = if (r.dest == Destination.Invoices) r.detailId else null
            reportSessionId   = if (r.dest == Destination.KinTales) r.detailId else null
            editingFormSchemaId = if (r.dest == Destination.FormSchemas) r.detailId else null
            mediaEntityId   = if (r.dest == Destination.MediaGallery) r.detailId else null
            mediaEntityType = if (r.dest == Destination.MediaGallery) r.detailType else null
        }
    }
```

(If `editingFormSchemaId` is declared after this insertion point in source, move the insertion to just before `AppShell(` so all referenced vars are in scope. Verify scope at build.)

- [ ] **Step 4: Verify-checkpoint (compile)**

Run: `./gradlew -p web :composeApp:compileKotlinWasmJs`
Expected: BUILD SUCCESSFUL. If a var is out-of-scope, move the effects block below the last detail-var declaration and re-run.

---

## Task 4: Build, deploy, verify deep-link live

- [ ] **Step 1: Full jvmTest**

Run: `./gradlew -p web :composeApp:jvmTest`
Expected: PASS (existing suite + 5 new RouteTest).

- [ ] **Step 2: Production build (correct task)**

Run (loud, per [[feedback_no_silent_long_ops]]):
`scripts/loud-build.sh -m 1500 -i 60 -- web/gradlew -p web wasmJsBrowserDistribution --no-build-cache`
Expected: `OK loud-build done`. Then verify dist exists: `ls web/composeApp/build/dist/wasmJs/productionExecutable/index.html`.

- [ ] **Step 3: Deploy hosting**

Run: `cd web && firebase deploy --only hosting --project auntieos-ttpc`
Expected: `Deploy complete!`

- [ ] **Step 4: Verify deep-link live (the payoff)**

Load `https://auntie.tribetails.com/#/directory` in the browser (chrome-devtools), wait for wasm, screenshot.
Expected: Directory screen renders directly (not Home). Then navigate in-app to another screen and confirm the URL hash updates (e.g. to `#/schedule`). Then browser-back returns to Directory.
This confirms routing works and unblocks per-screen screenshot verification for Phase B.

---

## Self-Review

- **Spec coverage:** Implements spec Phase A1 (hash router, deep-link verification enabler). A2 (components) + B (screens) are separate plans. ✓
- **Placeholders:** none — all code shown. The one conditional ("if a var is out of scope, move the block") is an explicit build-time check with a defined remedy, not a TODO.
- **Type consistency:** `Route(dest, detailId, detailType)`, `parseHash`, `routeToHash`, `currentHash/setHash/observeHash` used identically across tasks. Slugs match between `slugOf`/`destOf` (derived). ✓
- **No-git:** every checkpoint is build/test, no commits. ✓
