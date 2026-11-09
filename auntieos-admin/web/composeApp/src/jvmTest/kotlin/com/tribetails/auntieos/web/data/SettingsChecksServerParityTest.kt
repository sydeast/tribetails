package com.tribetails.auntieos.web.data

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1593: every sentence the desktop Settings panels show beside a field is the
 * server's, word for word. Read against `businessSettingsChecks.ts` itself, so
 * a sentence changed there and not here fails this suite.
 */
class SettingsChecksServerParityTest {

    // ── the sentences are the server's ───────────────────────────────────────

    private fun serverChecks(): String = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "mytribe/functions/src/lib/businessSettingsChecks.ts") }
        .firstOrNull { it.isFile }
        ?.readText()
        ?: error("businessSettingsChecks.ts not found above ${File("").absolutePath}")

    @Test
    fun everySharedSentenceAppearsWordForWordInTheServerChecks() {
        val server = serverChecks()
        val sentences = listOf(
            SettingsChecks.EMAIL_INVALID,
            SettingsChecks.PHONE_INVALID,
            SettingsChecks.DATE_INVALID,
            SettingsChecks.DATE_PAST,
            SettingsChecks.HOURS_RANGE_INVALID,
            SettingsChecks.HOURS_CLOSE_BEFORE_OPEN,
            SettingsChecks.KINCARE_NAME_REQUIRED,
            SettingsChecks.CLOSURE_NAME_REQUIRED,
            SettingsChecks.HOME_LIMIT_INVALID,
            "Enter the Venmo username: 5 to 30 letters, numbers, - or _.",
            "Enter the PayPal.Me name: up to 20 letters and numbers.",
            "Enter the \$Cashtag: up to 20 letters, numbers or _, with at least one letter.",
            "Every option has to be a whole number above zero.",
            "Trim the list.",
            " in dollars, like 25 or 25.50.",
            " cannot be negative.",
            " in whole minutes, from 1 to 1440.",
            "Two KinCare types are both called ",
        )
        for (s in sentences) assertTrue(server.contains(s), "server has: $s")
    }

    /** A logo uploaded here lands in the folder the server accepts a logo URL from. */
    @Test
    fun aLogoUploadIsSignedIntoTheServersBrandAssetFolder() {
        val brandAsset = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "mytribe/functions/src/lib/brandAsset.ts") }
            .first { it.isFile }
            .readText()
        val folder = Regex("""BRAND_ASSET_FOLDER = '([^']+)'""").find(brandAsset)!!.groupValues[1]
        assertEquals(folder, JvmMediaUpload.uploadFolder("BUSINESS", "business_settings"))
        assertEquals("tribetails/entity/kf1", JvmMediaUpload.uploadFolder("KINFOLK", "kf1"), "other uploads are unchanged")
    }
}
