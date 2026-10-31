package com.tribetails.auntieos.web.screens.invoices

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1178: pins the desktop terms table to the SERVER's, read off disk, the way
 * the Android `InvoiceTermsParityTest` pins its copy. The server resolves the due
 * date again on write and refuses one that disagrees, so a drift here shows the
 * operator one date and gets the create refused over another.
 */
class InvoiceTermsParityTest {

    private fun repoRoot(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            if (File(dir, "mytribe").isDirectory && File(dir, "auntieos-admin").isDirectory) return dir
            dir = dir.parentFile
        }
        throw AssertionError("Could not find the repo root above ${File("").absolutePath}; this test reads the server source.")
    }

    private val serverSource: String by lazy {
        val f = File(repoRoot(), "mytribe/functions/src/lib/invoiceTerms.ts")
        assertTrue(f.isFile, "The server terms module is missing at ${f.absolutePath}. Fix the path; do not delete this test.")
        f.readText()
    }

    private data class Def(val code: String, val basis: String, val days: Int, val label: String, val words: String)

    @Test
    fun theDesktopRuleTableIsTheServerRuleTable() {
        val start = serverSource.indexOf("const DEFS")
        val end = serverSource.indexOf("/** The rule behind one code. */")
        assertTrue(start > -1 && end > start, "Could not find the server DEFS table")
        val entry = Regex(
            """code:\s*'([^']*)',\s*basis:\s*'([^']*)',\s*days:\s*(-?\d+),\s*label:\s*'([^']*)',\s*words:\s*'([^']*)',""",
        )
        val expected = entry.findAll(serverSource.substring(start, end)).map {
            Def(it.groupValues[1], it.groupValues[2], it.groupValues[3].toInt(), it.groupValues[4], it.groupValues[5])
        }.toList()
        assertTrue(expected.isNotEmpty(), "Parsed no entries out of the server DEFS table; its shape changed")
        val actual = InvoiceTermsCode.entries.map {
            Def(it.wire, it.basis.name.lowercase(), it.days, it.label, it.words)
        }
        assertEquals(expected, actual)
    }

    @Test
    fun theComposerOffersTheCodesInTheServerOrder() {
        val start = serverSource.indexOf("export const INVOICE_TERMS_CODES = [")
        val end = serverSource.indexOf("] as const;", start)
        assertTrue(start > -1 && end > start, "Could not find INVOICE_TERMS_CODES")
        val codes = Regex("'([^']*)'").findAll(serverSource.substring(start, end)).map { it.groupValues[1] }.toList()
        assertEquals(codes, InvoiceTermsCode.entries.map { it.wire })
    }

    @Test
    fun everyProblemSentenceIsTheServersSentence() {
        listOf(
            resolveDueDate(InvoiceTermsCode.CUSTOM, "2026-08-19", emptyList(), "2026-08-19").problem,
            resolveDueDate(InvoiceTermsCode.NET_14, "", emptyList(), "2026-08-19").problem,
            resolveDueDate(InvoiceTermsCode.NET_14_AFTER_LAST_VISIT, "2026-08-19", emptyList(), "2026-08-19").problem,
        ).forEach { sentence ->
            assertTrue(!sentence.isNullOrBlank())
            assertTrue(serverSource.contains("'$sentence'"), "The server does not use this sentence verbatim: \"$sentence\"")
        }
    }
}
