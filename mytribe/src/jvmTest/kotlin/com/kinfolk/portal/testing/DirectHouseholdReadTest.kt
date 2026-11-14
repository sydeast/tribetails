package com.kinfolk.portal.testing

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * #1906: household reads match what the portal shows.
 *
 * `mytribe/firestore.rules` grants a household no direct read of `invoices`
 * (nor the older `families/{fid}/invoices` copies) or of a visit's
 * `bookings/{batchId}/kinCares/{visitId}` document. Bills reach this app through
 * `PortalApi.getMyInvoices`, which leaves out every invoice the office has not
 * sent, and visits through `PortalApi.getMyBookings`, which projects only what
 * a household sees. The rule is the enforcement; this guard is what turns a
 * direct read added later into a red build rather than a permission-denied on a
 * household's phone.
 *
 * WHAT IT CAN SEE. `FirestoreClient` takes the collection as a STRING, so a
 * direct read type-checks. The first case catches a call that names one of
 * those paths on its line. The second pins the set of files that call the SDK
 * at all, so a reader that spells the path some other way still has to
 * announce itself here. `DirectReportReadTest` is the same guard for #602.
 *
 * The web portal's twin is `web/src/lib/householdDirectReads.test.ts`.
 */
class DirectHouseholdReadTest {

    private val shippingSourceSets = listOf(
        "src/commonMain",
        "src/androidMain",
        "src/firebaseMain",
        "src/jsMain",
        "src/jvmMain",
    )

    /** The paths a household reads only through a callable. */
    private val callableOnlyPaths = listOf("invoices", "kinCares", "bookings")

    private val sdkCall = Regex("""\.(getDocument|listDocuments|collection|document)\(""")

    /**
     * The files that call the Firestore SDK, and what each reads:
     * the two platform clients (generic, no path of their own beyond
     * breadcrumbs), the household's own Kin (#1282), the vet clinic list
     * (#1503) and the public business card (#1321).
     */
    private val sdkCallers = listOf(
        "src/androidMain/kotlin/com/kinfolk/portal/firebase/NativeAndroidFirestoreClient.kt",
        "src/commonMain/kotlin/com/kinfolk/portal/config/BusinessPublicCard.kt",
        "src/commonMain/kotlin/com/kinfolk/portal/portal/KinDirectRead.kt",
        "src/commonMain/kotlin/com/kinfolk/portal/portal/VetClinicsDirectRead.kt",
        "src/firebaseMain/kotlin/com/kinfolk/portal/firebase/GitliveFirestoreClient.kt",
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

    private fun isComment(line: String): Boolean =
        line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")

    private fun relPath(file: File): String = file.relativeTo(moduleRoot()).path.replace('\\', '/')

    @Test
    fun noSdkCallNamesABillOrAVisitDocument() {
        val offenders = shippingKotlinFiles().flatMap { file ->
            file.readLines().mapIndexedNotNull { i, raw ->
                val line = raw.trim()
                val named = callableOnlyPaths.any { line.contains("\"$it") || line.contains("/$it") }
                if (isComment(line) || !sdkCall.containsMatchIn(line) || !named) null
                else "  ${relPath(file)}:${i + 1}  $line"
            }
        }.sorted()

        assertTrue(
            offenders.isEmpty(),
            "These lines read a bill or a visit document straight from Firestore. " +
                "firestore.rules gives a household no such read (#1906), so this ships as " +
                "a permission-denied. Use PortalApi.getMyInvoices for bills and " +
                "PortalApi.getMyBookings for visits.\n" + offenders.joinToString("\n"),
        )
    }

    @Test
    fun theFirestoreSdkIsCalledFromTheKnownFilesOnly() {
        val callers = shippingKotlinFiles()
            .filter { f -> f.readLines().any { raw -> !isComment(raw.trim()) && sdkCall.containsMatchIn(raw) } }
            .map { relPath(it) }
            .sorted()
        assertEquals(
            sdkCallers,
            callers,
            "A file calls the Firestore SDK that this list does not name. That is not " +
                "forbidden, but bills and visit documents have no household read (#1906): " +
                "add it here deliberately, after checking the rules give a household the read.",
        )
    }

    @Test
    fun theScanActuallyReachesShippingSources() {
        val files = shippingKotlinFiles()
        assertTrue(
            files.size > 50,
            "The shipping-source walk found only ${files.size} Kotlin files, so every check " +
                "in this file is passing vacuously.",
        )
    }

    /** The positive half: bills and visits come from the two callables. */
    @Test
    fun billsAndVisitsComeFromCallables() {
        val portalApi = File(moduleRoot(), "src/commonMain/kotlin/com/kinfolk/portal/portal/PortalApi.kt")
        assertTrue(portalApi.isFile, "PortalApi.kt is not where this test expects it: $portalApi")
        val text = portalApi.readText()
        assertTrue(
            text.contains("fns.call(\"getMyInvoices\""),
            "PortalApi no longer loads bills through getMyInvoices, the one household read of invoices.",
        )
        assertTrue(
            text.contains("\"getMyBookings\""),
            "PortalApi no longer loads visits through getMyBookings, the one household read of visits.",
        )
    }
}
