package com.kinfolk.portal.testing

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * ISSUE #584: the portal Android app must not read a `kin_care_sessions`
 * DOCUMENT directly.
 *
 * `mytribe/firestore.rules` no longer grants a kinfolk read on that collection.
 * The document carries `gpsSummary` — start and end coordinates plus the full
 * route — next to `notes` (gate codes) and the rest of AuntieOS's working state,
 * and a Firestore rule gates a DOCUMENT rather than a field, so the operator's
 * "Let kinfolk see visit locations" switch could never be honoured there.
 * Visits reach this app through `PortalApi.getMyVisits`, which calls a Cloud
 * Function that projects the document field by field and reads that switch.
 *
 * A DIRECT READ ADDED LATER WOULD NOT FAIL AT COMPILE TIME. `FirestoreClient`
 * exposes `getDocument(collection, documentId)` and `listDocuments(collection)`,
 * which take the collection as a STRING — so `getDocument("kin_care_sessions",
 * id)` type-checks, ships, and comes back permission-denied on a household's
 * phone, where it reads as "the schedule is broken." This test is what makes
 * that a red build instead. (Neither method has a call site in this tree today;
 * they are a facade the portal has stopped using, not dead weight to delete.)
 *
 * THE ONE ALLOWED USE is `breadcrumbsStream`, on the `breadcrumbs`
 * SUBcollection. That is a different document with its own rule, and that rule
 * does consult the location switch (#519). Live tracking keeps subscribing
 * directly, because a callable cannot push.
 *
 * Package `testing`, and in `jvmTest`, for the reason `ComposeUiTestSourceSetTest`
 * spells out next door: `mytribe/.gitignore` carries a bare `build/`, so a
 * `com.kinfolk.portal.build` package would be silently untracked, and `:jvmTest`
 * is the task that gates this module.
 */
class DirectSessionReadTest {

    private val collection = "kin_care_sessions"

    /** The source sets that SHIP. Test sources are allowed to name anything. */
    private val shippingSourceSets = listOf(
        "src/commonMain",
        "src/androidMain",
        "src/firebaseMain",
        "src/jsMain",
        "src/jvmMain",
    )

    private fun moduleRoot(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            if (File(dir, "src/commonMain").isDirectory && File(dir, "build.gradle.kts").isFile) {
                return dir
            }
            dir = dir.parentFile
        }
        fail("Could not find the mytribe module root from ${System.getProperty("user.dir")}")
    }

    private fun shippingKotlinFiles(): List<File> {
        val root = moduleRoot()
        return shippingSourceSets
            .map { File(root, it) }
            .filter { it.isDirectory }
            .flatMap { it.walkTopDown().filter { f -> f.isFile && f.extension == "kt" }.toList() }
    }

    /** A line that is only prose. The collection is discussed in comments all over. */
    private fun isComment(line: String): Boolean =
        line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")

    private fun mentions(): List<Triple<String, Int, String>> {
        val root = moduleRoot()
        return shippingKotlinFiles().flatMap { file ->
            file.readLines().mapIndexedNotNull { i, raw ->
                val line = raw.trim()
                if (!line.contains(collection) || isComment(line)) null
                else Triple(file.relativeTo(root).path, i + 1, line)
            }
        }
    }

    @Test
    fun namesTheSessionCollectionOnlyAsTheParentOfABreadcrumbsPath() {
        val offenders = mentions()
            .filter { !it.third.contains("breadcrumbs") }
            .map { (path, line, text) -> "  $path:$line  $text" }
            .sorted()

        assertTrue(
            offenders.isEmpty(),
            "These lines reach for $collection outside the breadcrumbs subcollection. " +
                "firestore.rules denies a kinfolk that read (#584), so this ships as a " +
                "permission-denied on a household's phone. Load visits with " +
                "PortalApi.getMyVisits instead: it projects the document and honours " +
                "allowClientLocationSharing.\n" + offenders.joinToString("\n"),
        )
    }

    /** Not a coverage target, a tripwire: if this empties the guard guards nothing. */
    @Test
    fun stillFindsTheLiveTrackingListenerItIsCarvingOut() {
        val breadcrumbUses = mentions().filter { it.third.contains("breadcrumbs") }
        assertTrue(
            breadcrumbUses.isNotEmpty(),
            "No shipping source names the breadcrumbs subcollection any more. Either live " +
                "tracking was removed, or the path is now assembled somewhere this scan " +
                "cannot see — in which case the guard above is protecting nothing.",
        )
    }

    /** The positive half: the Schedule screen's visits come from the callable. */
    @Test
    fun theScheduleScreenLoadsVisitsFromTheGetMyVisitsCallable() {
        val root = moduleRoot()
        val portalApi = File(root, "src/commonMain/kotlin/com/kinfolk/portal/portal/PortalApi.kt")
        assertTrue(portalApi.isFile, "PortalApi.kt is not where this test expects it: $portalApi")
        assertTrue(
            portalApi.readText().contains("fns.call(\"getMyVisits\""),
            "PortalApi no longer calls the getMyVisits callable. That callable is the only " +
                "path a kinfolk has to a visit since #584 closed the direct document read.",
        )

        val schedule = File(root, "src/commonMain/kotlin/com/kinfolk/portal/screens/schedule/ScheduleScreen.kt")
        assertTrue(schedule.isFile, "ScheduleScreen.kt is not where this test expects it: $schedule")
        assertTrue(
            schedule.readText().contains("getMyVisits"),
            "The Schedule screen no longer loads visits through getMyVisits.",
        )
    }
}
