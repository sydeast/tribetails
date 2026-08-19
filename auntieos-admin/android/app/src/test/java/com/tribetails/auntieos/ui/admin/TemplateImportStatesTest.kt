package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.TemplateRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules the import screen has to keep, pinned as pure functions because the
 * Android suite is JVM only (no Compose UI test runner here).
 *
 * Issue #468. The sentences these produce are the same ones the React admin
 * shows, on purpose: an operator who learns on the laptop that a ticked row
 * means "replace this" should not find the phone using different words for it.
 */
class TemplateImportStatesTest {

    private fun channel(name: String, outcome: String, notes: List<String> = emptyList()) =
        TemplateRepository.ImportChannel(channel = name, outcome = outcome, notes = notes)

    private fun row(
        templateId: String = "kincare.reschedule.requested",
        aliasOf: String? = null,
        outcomes: List<String> = listOf("create", "create", "create"),
        differs: Boolean = false,
        blocked: Boolean = false,
    ) = TemplateRepository.ImportRow(
        templateId = templateId,
        aliasOf = aliasOf,
        channels = listOf("email", "sms", "push").zip(outcomes).map { (c, o) -> channel(c, o) },
        differsFromRepo = differs,
        blocked = blocked,
    )

    private fun report(
        rows: List<TemplateRepository.ImportRow>,
        counts: Map<String, Int>,
        refused: List<Pair<String, String>> = emptyList(),
        needsChoice: List<String> = emptyList(),
    ) = TemplateRepository.ImportReport(
        dryRun = true,
        written = 0,
        counts = counts,
        rows = rows,
        needsOverwriteChoice = needsChoice,
        refused = refused,
    )

    @Test
    fun `headline counts documents, not templates`() {
        val r = report(listOf(row()), mapOf("create" to 3))
        assertEquals("3 to create. Importing writes 3 documents.", importPlanHeadline(r))
    }

    @Test
    fun `headline says there is nothing to do when everything already matches`() {
        val r = report(
            listOf(row(outcomes = listOf("unchanged", "unchanged", "unchanged"))),
            mapOf("unchanged" to 3),
        )
        assertEquals(
            "Every template on file already matches the repo. There is nothing to import.",
            importPlanHeadline(r),
        )
    }

    @Test
    fun `headline singularises a one-document run`() {
        val r = report(
            listOf(row(outcomes = listOf("create", "unchanged", "unchanged"))),
            mapOf("create" to 1, "unchanged" to 2),
        )
        assertEquals("1 to create, 2 already matching. Importing writes 1 document.", importPlanHeadline(r))
    }

    @Test
    fun `a skipped row does not count as a write`() {
        val r = report(
            listOf(row(outcomes = listOf("skipped", "create", "create"), differs = true)),
            mapOf("skipped" to 1, "create" to 2),
            needsChoice = listOf("kincare.reschedule.requested"),
        )
        assertEquals(2, plannedWriteCount(r))
    }

    @Test
    fun `a refused row writes nothing at all`() {
        val r = report(
            listOf(row(outcomes = listOf("blocked", "blocked", "blocked"), blocked = true)),
            mapOf("blocked" to 3),
            refused = listOf("kincare.reschedule.requested" to "html uses the Handlebars triple stash."),
        )
        assertEquals(0, plannedWriteCount(r))
        assertEquals("Refused", importRowSummary(r.rows[0]))
    }

    @Test
    fun `summary names each state in the operator's words`() {
        assertEquals("New", importRowSummary(row()))
        assertEquals(
            "Already matches the repo",
            importRowSummary(row(outcomes = listOf("unchanged", "unchanged", "unchanged"))),
        )
        assertEquals(
            "Differs, not selected for overwrite",
            importRowSummary(row(outcomes = listOf("skipped", "create", "create"), differs = true)),
        )
        assertEquals(
            "Will replace the stored copy",
            importRowSummary(row(outcomes = listOf("overwrite", "create", "create"), differs = true)),
        )
    }

    @Test
    fun `only a differing row offers the overwrite tick`() {
        assertFalse(offersOverwriteChoice(row()))
        assertFalse(offersOverwriteChoice(row(outcomes = listOf("unchanged", "unchanged", "unchanged"))))
        assertTrue(offersOverwriteChoice(row(outcomes = listOf("skipped", "create", "create"), differs = true)))
        // A refused row is not a choice. Ticking it would promise something the
        // server is going to refuse anyway.
        assertFalse(
            offersOverwriteChoice(
                row(outcomes = listOf("blocked", "blocked", "blocked"), differs = true, blocked = true),
            ),
        )
    }
}

/**
 * The template key rule, which Android did not enforce before issue #468: a key
 * with a space in it was sent to the server and came back as a zod complaint
 * about a regular expression.
 */
class TemplateKeyRuleTest {

    @Test
    fun `a dotted catalog key is accepted`() {
        assertNull(templateKeyError("kincare.reschedule.requested", emptyList()))
        assertNull(templateKeyError("invoice_new-2", emptyList()))
    }

    @Test
    fun `a blank key asks for one and explains the rule`() {
        val message = templateKeyError("   ", emptyList())
        assertEquals("A template key is required. $TEMPLATE_KEY_RULE", message)
    }

    @Test
    fun `a key with a space is refused before it reaches the server`() {
        val message = templateKeyError("has spaces", emptyList())
        assertTrue(message!!.startsWith("That key uses characters a template key cannot carry."))
        assertTrue(message.contains("kincare.reschedule.requested"))
    }

    @Test
    fun `a key with a slash is refused, since it would split the document path`() {
        assertTrue(templateKeyError("kincare/reschedule", emptyList())!!.contains("cannot carry"))
    }

    @Test
    fun `an over-long key reports its own length`() {
        val long = "a".repeat(TEMPLATE_KEY_MAX_LENGTH + 1)
        val message = templateKeyError(long, emptyList())
        assertTrue(message!!.contains("${TEMPLATE_KEY_MAX_LENGTH + 1} characters"))
    }

    @Test
    fun `a key already in the loaded bank is refused, and says what to do instead`() {
        val message = templateKeyError("invoice.new", listOf("invoice.new", "invoice.overdue"))
        assertTrue(message!!.contains("already exists"))
        assertTrue(message.contains("edit the existing one"))
    }

    @Test
    fun `a trimmed key is what gets checked`() {
        assertNull(templateKeyError("  invoice.new  ", listOf("invoice.overdue")))
        assertTrue(templateKeyError("  invoice.new  ", listOf("invoice.new")) != null)
    }
}
