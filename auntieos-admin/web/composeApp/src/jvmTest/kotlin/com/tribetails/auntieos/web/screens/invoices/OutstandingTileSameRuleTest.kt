package com.tribetails.auntieos.web.screens.invoices

import java.io.File
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #2000: Home's Cash Flow card and the Invoices screen's Outstanding tile must
 * say the same thing about what is owed. The console has no Compose UI test
 * harness, so this reads both screens off disk and pins that each draws its
 * figure from `cashFlowOutstanding` (stored state OPEN, a balance above zero,
 * not archived), whose rule `Stage2Step2HelpersTest` covers.
 *
 * Before this, the Invoices tile used `invoiceIsOutstanding` (any unpaid
 * balance), so an unsent draft, a quote and an archived bill counted as owed on
 * Invoices while Home left them out.
 */
class OutstandingTileSameRuleTest {

    private fun moduleFile(path: String): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val f = File(dir, path)
            if (f.isFile) return f
            dir = dir.parentFile
        }
        throw AssertionError("Could not find $path above ${File("").absolutePath}. Fix the path; do not delete this test.")
    }

    private fun body(source: String, signature: String): String {
        val start = source.indexOf(signature)
        assertTrue(start > -1, "Could not find `$signature`; the screen changed shape")
        val next = source.indexOf("\n@Composable", start + signature.length)
        return if (next > -1) source.substring(start, next) else source.substring(start)
    }

    private val screens = "src/commonMain/kotlin/com/tribetails/auntieos/web/screens"

    @Test
    fun invoicesOutstandingTileReadsTheCashFlowRule() {
        val strip = body(moduleFile("$screens/invoices/InvoicesScreen.kt").readText(), "private fun SummaryStrip(")
        assertTrue("cashFlowOutstanding(invoices)" in strip, "The Outstanding tile must read cashFlowOutstanding")
        assertFalse("invoiceIsOutstanding(" in strip, "The Outstanding tile must not count any unpaid balance as owed")
    }

    @Test
    fun homeCashFlowReadsTheSameRule() {
        val home = moduleFile("$screens/home/HomeScreen.kt").readText()
        assertTrue("cashFlowOutstanding(invoices)" in home, "Home's Cash Flow card must read cashFlowOutstanding")
        assertFalse("invoices.filter { it.amountDue > 0.0 }" in home, "Home must not count every balance as owed")
    }
}
