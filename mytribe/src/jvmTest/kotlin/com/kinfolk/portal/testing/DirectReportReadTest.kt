package com.kinfolk.portal.testing

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * ISSUE #602: the portal Android app must not read a `kin_care_reports`
 * DOCUMENT directly.
 *
 * `mytribe/firestore.rules` no longer grants a kinfolk read on that collection.
 * The document carries `gpsRoute` — the coordinate trail `getMyKinTales`
 * deliberately strips before a KinTale reaches a household — and a Firestore
 * rule gates a DOCUMENT rather than a field, so the callable's stripping was
 * bypassable by opening the document with the SDK. KinTales reach this app
 * through `PortalApi.getMyKinTales`, and their threads through
 * `PortalApi.getMyKinTaleComments`.
 *
 * A DIRECT READ ADDED LATER WOULD NOT FAIL AT COMPILE TIME. `FirestoreClient`
 * exposes `getDocument(collection, documentId)` and `listDocuments(collection)`,
 * which take the collection as a STRING — so `getDocument("kin_care_reports",
 * id)` type-checks, ships, and comes back permission-denied on a household's
 * phone, where it reads as "KinTales are broken." This test is what makes that
 * a red build instead.
 *
 * NO CARVE-OUT HERE, unlike `DirectSessionReadTest` next door. That one exempts
 * the `breadcrumbs` subcollection because live tracking genuinely subscribes to
 * it and a callable cannot push. Nothing under `kin_care_reports` is read
 * directly by this client — comments included, which `getMyKinTaleComments`
 * serves — so ANY mention in shipping code is an offender.
 *
 * Package `testing`, and in `jvmTest`, for the reason `ComposeUiTestSourceSetTest`
 * spells out next door: `mytribe/.gitignore` carries a bare `build/`, so a
 * `com.kinfolk.portal.build` package would be silently untracked, and `:jvmTest`
 * is the task that gates this module.
 */
class DirectReportReadTest {

    private val collection = "kin_care_reports"

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
    fun neverNamesTheReportCollectionInShippingCode() {
        val offenders = mentions()
            .map { (path, line, text) -> "  $path:$line  $text" }
            .sorted()

        assertTrue(
            offenders.isEmpty(),
            "These lines reach for $collection. firestore.rules denies a kinfolk that " +
                "read (#602), so this ships as a permission-denied on a household's phone. " +
                "Load tales with PortalApi.getMyKinTales and threads with " +
                "PortalApi.getMyKinTaleComments instead: both project the document and " +
                "strip gpsRoute.\n" + offenders.joinToString("\n"),
        )
    }

    /**
     * Not a coverage target, a tripwire. This guard's whole value is that it
     * scans shipping sources; if the walk stops finding them — a moved module
     * root, a renamed source set — every assertion above passes vacuously and
     * nobody notices.
     */
    @Test
    fun theScanActuallyReachesShippingSources() {
        val files = shippingKotlinFiles()
        assertTrue(
            files.size > 50,
            "The shipping-source walk found only ${files.size} Kotlin files, which means " +
                "it is no longer looking where the code is. Every offender check in this " +
                "file and in DirectSessionReadTest is passing vacuously until this is fixed.",
        )
    }

    /** The positive half: tales and their threads come from the two callables. */
    fun portalApiFile(): File =
        File(moduleRoot(), "src/commonMain/kotlin/com/kinfolk/portal/portal/PortalApi.kt")

    @Test
    fun theKinTalesScreenLoadsTalesAndCommentsFromCallables() {
        val portalApi = portalApiFile()
        assertTrue(portalApi.isFile, "PortalApi.kt is not where this test expects it: $portalApi")
        val text = portalApi.readText()
        assertTrue(
            text.contains("fns.call(\"getMyKinTales\""),
            "PortalApi no longer calls the getMyKinTales callable. That callable is the " +
                "only path a kinfolk has to a KinTale since #602 closed the direct read.",
        )
        assertTrue(
            text.contains("getMyKinTaleComments"),
            "PortalApi no longer serves KinTale comments through a callable. The comments " +
                "subcollection is not read directly by this client, which is what lets " +
                "DirectReportReadTest carve out nothing at all.",
        )
    }
}
