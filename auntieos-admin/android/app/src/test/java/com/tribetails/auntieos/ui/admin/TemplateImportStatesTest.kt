package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.data.repository.decodeImportReport
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

    /** #892 review 2: the reason a refused template gives, shown beside "Refused". */
    @Test
    fun `a refused row gives its reason, and every other row gives none`() {
        val reason = "email: html puts a merge field straight into an attribute without quotes, like href={{link}}."
        val refused = row(blocked = true, outcomes = listOf("blocked", "blocked", "blocked")).copy(issues = listOf(reason))
        assertEquals("Refused", importRowSummary(refused))
        assertEquals(reason, importRowReason(refused))
        assertNull(importRowReason(row()))
        assertNull(importRowReason(row(blocked = true).copy(issues = emptyList())))
    }

    @Test
    fun `decoding a report keeps each row's issues`() {
        val decoded = decodeImportReport(
            mapOf(
                "dryRun" to true,
                "rows" to listOf(
                    mapOf(
                        "templateId" to "assignment.assigned",
                        "channels" to emptyList<Any>(),
                        "blocked" to true,
                        "issues" to listOf("email: first.", "sms: second."),
                    ),
                    mapOf("templateId" to "invoice.new", "channels" to emptyList<Any>()),
                ),
            ),
        )
        assertEquals(listOf("email: first.", "sms: second."), decoded.rows[0].issues)
        assertEquals("email: first. sms: second.", importRowReason(decoded.rows[0]))
        assertEquals(emptyList<String>(), decoded.rows[1].issues)
    }

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

    /** #1060: Tick all reaches exactly the rows that have a box. */
    @Test
    fun `tick all covers differing rows and never a refused or matching one`() {
        val differing = row(templateId = "a", outcomes = listOf("skipped", "create", "create"), differs = true)
        val refused = row(templateId = "b", outcomes = listOf("blocked", "blocked", "blocked"), differs = true, blocked = true)
        val matching = row(templateId = "c", outcomes = listOf("unchanged", "unchanged", "unchanged"))
        val other = row(templateId = "d", outcomes = listOf("skipped", "unchanged", "unchanged"), differs = true)
        val r = report(listOf(differing, refused, matching, other), mapOf("skipped" to 2))
        assertEquals(listOf("a", "d"), tickableTemplateIds(r))
    }
    @Test
    fun `tick all ticks everything when some or none are ticked, and clears when all are`() {
        val tickable = listOf("a", "d")
        assertEquals(listOf("a", "d"), toggleAllTicks(emptyList(), tickable))
        assertEquals(listOf("a", "d"), toggleAllTicks(listOf("a"), tickable))
        assertEquals(emptyList<String>(), toggleAllTicks(listOf("a", "d"), tickable))
        assertEquals(emptyList<String>(), toggleAllTicks(emptyList(), emptyList()))
    }
    @Test
    fun `the tick count reads N of M ticked and only counts rows that can be ticked`() {
        val tickable = listOf("a", "d")
        assertEquals("0 of 2 ticked", tickCountLabel(emptyList(), tickable))
        assertEquals("1 of 2 ticked", tickCountLabel(listOf("a", "zzz"), tickable))
        assertEquals("2 of 2 ticked", tickCountLabel(listOf("a", "d"), tickable))
    }
    @Test
    fun `a ticked skipped row says importing replaces it, an unticked one keeps the server line`() {
        val server = "The stored email copy differs from the repo copy. Your stored copy stays as it is. " +
            "Tick this template to replace it with the repo wording."
        val c = channel("email", "skipped", listOf(server))
        assertEquals(server, importChannelNote(c, ticked = false))
        assertEquals(
            "The stored email copy differs from the repo copy. Importing replaces your stored copy with the repo wording.",
            importChannelNote(c, ticked = true),
        )
        // Only a skipped line changes. A created channel keeps what the server said.
        assertEquals("x", importChannelNote(channel("sms", "create", listOf("x")), ticked = true))
        assertEquals(
            "Differs, selected for overwrite",
            importRowSummary(row(outcomes = listOf("skipped", "create", "create"), differs = true), ticked = true),
        )
    }
    /** #1060: Tick all must turn Import on even when nothing else was to write. */
    @Test
    fun `ticking a skipped row counts its skipped channels as writes, a refused row never`() {
        val a = row(templateId = "a", outcomes = listOf("skipped", "unchanged", "unchanged"), differs = true)
        val b = row(templateId = "b", outcomes = listOf("skipped", "skipped", "unchanged"), differs = true)
        val refused = row(templateId = "c", outcomes = listOf("blocked", "blocked", "blocked"), differs = true, blocked = true)
        val r = report(listOf(a, b, refused), mapOf("skipped" to 3))
        assertEquals(0, plannedWriteCountWithTicks(r, emptyList()))
        assertEquals(1, plannedWriteCountWithTicks(r, listOf("a")))
        assertEquals(3, plannedWriteCountWithTicks(r, listOf("a", "b", "c")))
        // The server's own meaning is untouched.
        assertEquals(0, plannedWriteCount(r))
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
