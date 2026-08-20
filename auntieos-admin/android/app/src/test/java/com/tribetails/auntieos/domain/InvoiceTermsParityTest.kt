package com.tribetails.auntieos.domain

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the Kotlin terms table against the SERVER's, read off disk.
 *
 * WHY THIS EXISTS. `domain/InvoiceTerms.kt` is the THIRD copy of one rule table.
 * `mytribe/functions/src/lib/invoiceTerms.ts` owns it, the web admin mirrors it
 * in `auntieos-admin/src/lib/invoiceTerms.ts` under
 * `invoiceTerms.parity.test.ts`, and this file mirrors it for Android. Two of
 * the three were already pinned to each other; a third copy that nothing pins is
 * a fork waiting to happen, and it would be a silent one, because the composer
 * would keep showing a due date and the server would keep computing a different
 * one and refusing the write with a message about a date the operator never
 * typed.
 *
 * IT READS THE REAL FILE, following `KinTaleEngineCallSiteTest`, which is the
 * precedent in this suite for a test that scans sources rather than behaviour.
 * A fixture copied into this file would drift with everything else.
 *
 * WHAT IS PINNED, and why each part:
 *
 *   The DEFS table    IS the product decision: which terms exist, what each one
 *                     counts from, and the exact sentence a household reads. A
 *                     drift here shows the operator one rule in the composer and
 *                     prints another on the bill.
 *   The code ORDER    is the order the composer offers them in, invoice-relative
 *                     before visit-relative, and it is declared on the server as
 *                     `INVOICE_TERMS_CODES`.
 *   The PROBLEM text  is what the operator reads when the terms cannot decide a
 *                     date. The server's copy is the one the API returns, so a
 *                     divergence means two surfaces explaining one refusal in
 *                     two different ways.
 *
 * `InvoiceTermsTest` guards what the table RESOLVES, running the same fixture
 * cases both TypeScript suites run. This guards the table itself.
 */
class InvoiceTermsParityTest {

    /**
     * The repo root: the nearest ancestor holding both product trees.
     *
     * NOT the same walk `KinTaleEngineCallSiteTest` makes. That one looks for
     * `android/` plus `web/`, which lands on `auntieos-admin`; this test needs
     * the level above, where `mytribe/` sits beside it.
     */
    private fun repoRoot(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            if (File(dir, "mytribe").isDirectory && File(dir, "auntieos-admin").isDirectory) return dir
            dir = dir.parentFile
        }
        throw AssertionError(
            "Could not find the repo root (an ancestor of ${File("").absolutePath} holding both " +
                "'mytribe/' and 'auntieos-admin/'). This test reads the real server source and cannot " +
                "run without it.",
        )
    }

    private val serverFile: File by lazy {
        File(repoRoot(), "mytribe/functions/src/lib/invoiceTerms.ts")
    }

    private val serverSource: String by lazy {
        assertTrue(
            "The server terms module is missing at ${serverFile.absolutePath}. If it moved, fix the path " +
                "here rather than deleting this test: the Kotlin table below is a mirror of it and has no " +
                "other authority.",
            serverFile.isFile,
        )
        serverFile.readText()
    }

    private data class ServerDef(
        val code: String,
        val basis: String,
        val days: Long,
        val label: String,
        val words: String,
    )

    /** Every entry of the server's `DEFS` table, in the order it declares them. */
    private fun serverDefs(): List<ServerDef> {
        val start = serverSource.indexOf("const DEFS")
        val end = serverSource.indexOf("/** The rule behind one code. */")
        assertTrue("Could not find the DEFS table in ${serverFile.absolutePath}", start > -1)
        assertTrue("Could not find the end of the DEFS table in ${serverFile.absolutePath}", end > start)
        val table = serverSource.substring(start, end)

        val entry = Regex(
            """code:\s*'([^']*)',\s*basis:\s*'([^']*)',\s*days:\s*(-?\d+),\s*label:\s*'([^']*)',\s*words:\s*'([^']*)',""",
        )
        val defs = entry.findAll(table).map {
            ServerDef(
                code = it.groupValues[1],
                basis = it.groupValues[2],
                days = it.groupValues[3].toLong(),
                label = it.groupValues[4],
                words = it.groupValues[5],
            )
        }.toList()

        // A scan that finds nothing proves nothing. If the server file's shape
        // changed, this test must fail rather than pass over an empty list.
        assertTrue(
            "Parsed no entries out of the server DEFS table. Its shape changed; fix this extractor " +
                "before trusting anything else in this suite.",
            defs.isNotEmpty(),
        )
        return defs
    }

    /** The server's declared code order, from `INVOICE_TERMS_CODES`. */
    private fun serverCodeOrder(): List<String> {
        val start = serverSource.indexOf("export const INVOICE_TERMS_CODES = [")
        assertTrue("Could not find INVOICE_TERMS_CODES in ${serverFile.absolutePath}", start > -1)
        val end = serverSource.indexOf("] as const;", start)
        assertTrue("Could not find the end of INVOICE_TERMS_CODES", end > start)
        val codes = Regex("'([^']*)'").findAll(serverSource.substring(start, end)).map { it.groupValues[1] }.toList()
        assertTrue("Parsed no codes out of INVOICE_TERMS_CODES", codes.isNotEmpty())
        return codes
    }

    @Test
    fun `the Kotlin rule table is the server rule table, entry for entry`() {
        val expected = serverDefs()
        val actual = InvoiceTermsCode.entries.map {
            ServerDef(
                code = it.wire,
                basis = when (it.basis) {
                    InvoiceTermsBasis.INVOICE -> "invoice"
                    InvoiceTermsBasis.SERVICE -> "service"
                    InvoiceTermsBasis.NONE -> "none"
                },
                days = it.days,
                label = it.label,
                words = it.words,
            )
        }
        assertEquals(
            "The Android terms table is not the server's. One of the two is now offering terms, counting " +
                "from a different day, or printing different words on a household bill. The SERVER is the " +
                "authority: change it first, then mirror it here and in auntieos-admin/src/lib/invoiceTerms.ts.",
            expected,
            actual,
        )
    }

    @Test
    fun `the composer offers the codes in the order the server declares them`() {
        assertEquals(
            "The Android enum order is the composer's option order, and it no longer matches the server's " +
                "INVOICE_TERMS_CODES. Reorder the enum to match; the order is deliberate, invoice-relative " +
                "first and the pick-it-yourself escape hatch last.",
            serverCodeOrder(),
            InvoiceTermsCode.entries.map { it.wire },
        )
    }

    @Test
    fun `every sentence this resolver can show is the sentence the server shows`() {
        // The operator reads one of these when the terms cannot decide a date,
        // and the server returns the same refusal from its own copy. Two
        // surfaces explaining one refusal differently is a support call.
        val sentences = listOf(
            resolveDueDate(InvoiceTermsCode.CUSTOM, "2026-08-19", emptyList(), "2026-08-19").problem,
            resolveDueDate(InvoiceTermsCode.NET_14, "", emptyList(), "2026-08-19").problem,
            resolveDueDate(InvoiceTermsCode.NET_14_AFTER_LAST_VISIT, "2026-08-19", emptyList(), "2026-08-19").problem,
        )
        sentences.forEach { sentence ->
            assertTrue("A resolver branch returned no sentence at all", !sentence.isNullOrBlank())
            assertTrue(
                "The server file does not contain this sentence verbatim, so Android is explaining a " +
                    "refusal in words the server does not use: \"$sentence\"",
                serverSource.contains("'$sentence'"),
            )
        }
    }

    @Test
    fun `the server still declares the resolver this table is mirrored from`() {
        // Cheap, and it catches the one failure the checks above cannot: the
        // server dropping `resolveDueDate` entirely while its DEFS table stays
        // put. A mirror of a rule the authority deleted is a fork, not a preview.
        assertTrue(
            "The server no longer exports resolveDueDate. Android is mirroring a resolver that no longer " +
                "exists; find out what replaced it before this table is trusted again.",
            serverSource.contains("export function resolveDueDate("),
        )
    }
}
