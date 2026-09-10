package com.tribetails.auntieos.ui.admin.formschemas

import com.tribetails.auntieos.data.model.FormSchemaSummary
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.TimeZone

/**
 * Pure-JVM tests for the schema row's "last updated" text and for the list
 * order it sits in.
 *
 * The default zone is pinned to a west-of-UTC zone for the whole class, the
 * same discipline `lib/formSchemaFormat.test.ts` uses on the React side: the
 * label is LOCAL by design (AO-18), so on a UTC CI box a UTC-vs-local bug would
 * be invisible. America/Chicago is UTC-5 in August, so a 10:15Z instant must
 * read 05:15 and never 10:15.
 */
class FormSchemaUpdatedLabelTest {

    private var originalZone: TimeZone? = null

    @Before fun pinZone() {
        originalZone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("America/Chicago"))
    }

    @After fun restoreZone() {
        originalZone?.let { TimeZone.setDefault(it) }
    }

    private fun summary(
        id: String = "tribeProfile",
        name: String = "Tribe Profile",
        version: Int = 3,
        updatedAt: String = "2026-07-01T00:00:00.000Z",
        updatedBy: String = "admin1",
    ) = FormSchemaSummary(
        id = id,
        name = name,
        version = version,
        updatedAt = updatedAt,
        updatedBy = updatedBy,
    )

    // ── formSchemaUpdatedLabel: the well-formed case ────────────────────────

    @Test fun `formats a real ISO instant as local MM-DD HH mm`() {
        assertEquals("08-02 05:15", formSchemaUpdatedLabel("2026-08-02T10:15:00.000Z"))
    }

    @Test fun `never leaks the raw machine timestamp`() {
        val out = formSchemaUpdatedLabel("2026-08-02T10:15:00.000Z")
        assertFalse(out.contains("T"))
        assertFalse(out.contains("Z"))
        assertFalse(out.contains(".000"))
    }

    @Test fun `shows the local calendar day, not the UTC one`() {
        // 01:00 UTC on the 17th is 20:00 on the 16th in Chicago. Slicing the raw
        // string (what KinTaleLogsScreen still does) would print the 17th.
        assertEquals("07-16 20:00", formSchemaUpdatedLabel("2026-07-17T01:00:00.000Z"))
    }

    @Test fun `zero-pads a single-digit month, day, hour and minute`() {
        assertEquals("01-05 03:07", formSchemaUpdatedLabel("2026-01-05T09:07:00.000Z"))
    }

    @Test fun `reads an explicit offset as the same instant`() {
        assertEquals(
            formSchemaUpdatedLabel("2026-08-02T10:15:00.000Z"),
            formSchemaUpdatedLabel("2026-08-02T05:15:00-05:00"),
        )
    }

    @Test fun `reads a designator-less local datetime as local, matching JS`() {
        assertEquals("08-02 05:15", formSchemaUpdatedLabel("2026-08-02T05:15:00"))
    }

    @Test fun `anchors a date-only value at UTC midnight, matching JS`() {
        assertEquals("08-01 19:00", formSchemaUpdatedLabel("2026-08-02"))
    }

    // ── formSchemaUpdatedLabel: the sad + negative cases ────────────────────

    @Test fun `says date unknown for a blank updatedAt`() {
        assertEquals(NO_UPDATED_AT_LABEL, formSchemaUpdatedLabel(""))
        assertEquals("date unknown", formSchemaUpdatedLabel(""))
    }

    @Test fun `says date unknown for a whitespace-only updatedAt`() {
        assertEquals("date unknown", formSchemaUpdatedLabel("   "))
    }

    @Test fun `echoes an unreadable value verbatim, never a crash or a fake date`() {
        for (bad in listOf("not-a-date", "sometime last Tuesday", "2026-13-45T99:99:99Z", "???")) {
            assertEquals(bad, formSchemaUpdatedLabel(bad))
        }
    }

    @Test fun `trims an unreadable value rather than echoing its padding`() {
        assertEquals("not-a-date", formSchemaUpdatedLabel("  not-a-date  "))
    }

    @Test fun `never returns blank, so the row can never lose the part`() {
        for (input in listOf("", "   ", "not-a-date", "2026-08-02T10:15:00.000Z")) {
            assertTrue(formSchemaUpdatedLabel(input).isNotBlank())
        }
    }

    // ── formSchemaUpdatedMeta: the subtitle tail ────────────────────────────

    @Test fun `meta reads updated LABEL by WHO`() {
        assertEquals(
            "updated 08-02 05:15 by e2e-admin",
            formSchemaUpdatedMeta("2026-08-02T10:15:00.000Z", "e2e-admin"),
        )
    }

    @Test fun `meta drops the by clause when updatedBy is blank`() {
        assertEquals("updated 08-02 05:15", formSchemaUpdatedMeta("2026-08-02T10:15:00.000Z", "  "))
    }

    @Test fun `meta is honest when the whole pair is absent`() {
        assertEquals("updated date unknown", formSchemaUpdatedMeta("", ""))
    }

    // ── formSchemaSort: the order the label sits in ─────────────────────────

    @Test fun `sorts most-recently-updated first`() {
        val rows = listOf(
            summary(id = "sep", updatedAt = "2026-09-01T00:00:00.000Z"),
            summary(id = "jan", updatedAt = "2026-01-31T23:59:59.999Z"),
            summary(id = "oct", updatedAt = "2026-10-01T00:00:00.000Z"),
            summary(id = "lastYear", updatedAt = "2025-12-31T23:59:59.999Z"),
        )
        assertEquals(
            listOf("oct", "sep", "jan", "lastYear"),
            formSchemaSort(rows, SortColumn.UPDATED_AT, descending = true).map { it.id },
        )
    }

    @Test fun `separates instants differing only in the clock or the millis`() {
        val rows = listOf(
            summary(id = "early", updatedAt = "2026-08-02T09:15:00.000Z"),
            summary(id = "late", updatedAt = "2026-08-02T10:15:00.000Z"),
            summary(id = "latest", updatedAt = "2026-08-02T10:15:00.001Z"),
        )
        assertEquals(
            listOf("latest", "late", "early"),
            formSchemaSort(rows, SortColumn.UPDATED_AT, descending = true).map { it.id },
        )
    }

    @Test fun `sorts a blank updatedAt last in the shipped descending order`() {
        val rows = listOf(
            summary(id = "blank", updatedAt = ""),
            summary(id = "dated", updatedAt = "2026-01-01T00:00:00.000Z"),
        )
        assertEquals(
            listOf("dated", "blank"),
            formSchemaSort(rows, SortColumn.UPDATED_AT, descending = true).map { it.id },
        )
        // Order-independent: feeding it the other way round must not change the answer.
        assertEquals(
            listOf("dated", "blank"),
            formSchemaSort(rows.reversed(), SortColumn.UPDATED_AT, descending = true).map { it.id },
        )
    }

    // A blank updatedAt/updatedBy sorting first on ASCENDING was the bug the
    // sort strip exposed: sortColumn/sortDescending were dead state before this
    // change, so descending was the only order anyone ever saw a row in.
    @Test fun `sorts a blank updatedAt last on ASCENDING too, not first`() {
        val rows = listOf(
            summary(id = "blank", updatedAt = ""),
            summary(id = "dated", updatedAt = "2026-01-01T00:00:00.000Z"),
        )
        assertEquals(
            listOf("dated", "blank"),
            formSchemaSort(rows, SortColumn.UPDATED_AT, descending = false).map { it.id },
        )
    }

    @Test fun `sorts a blank updatedBy last in BOTH directions`() {
        val rows = listOf(
            summary(id = "blank", updatedBy = ""),
            summary(id = "has", updatedBy = "admin1"),
        )
        assertEquals(
            listOf("has", "blank"),
            formSchemaSort(rows, SortColumn.UPDATED_BY, descending = false).map { it.id },
        )
        assertEquals(
            listOf("has", "blank"),
            formSchemaSort(rows, SortColumn.UPDATED_BY, descending = true).map { it.id },
        )
    }

    @Test fun `sorts by name and version, both directions`() {
        val rows = listOf(
            summary(id = "b", name = "Bravo", version = 2),
            summary(id = "a", name = "Alpha", version = 4),
            summary(id = "c", name = "Charlie", version = 1),
        )
        assertEquals(
            listOf("a", "b", "c"),
            formSchemaSort(rows, SortColumn.NAME, descending = false).map { it.id },
        )
        assertEquals(
            listOf("c", "b", "a"),
            formSchemaSort(rows, SortColumn.NAME, descending = true).map { it.id },
        )
        assertEquals(
            listOf("c", "b", "a"),
            formSchemaSort(rows, SortColumn.VERSION, descending = false).map { it.id },
        )
        assertEquals(
            listOf("a", "b", "c"),
            formSchemaSort(rows, SortColumn.VERSION, descending = true).map { it.id },
        )
    }

    @Test fun `sorts by updatedBy on the RESOLVED label, not the raw uid`() {
        val rows = listOf(
            summary(id = "row1", updatedBy = "uid-a"),
            summary(id = "row2", updatedBy = "uid-b"),
        )
        val emailByUid = mapOf("uid-a" to "zed@tribetails.example", "uid-b" to "ann@tribetails.example")
        assertEquals(
            listOf("row2", "row1"),
            formSchemaSort(rows, SortColumn.UPDATED_BY, descending = false) { emailByUid[it] ?: it }
                .map { it.id },
        )
    }

    @Test fun `never drops or duplicates a row, whatever the input classes are`() {
        val rows = listOf(
            summary(id = "iso", updatedAt = "2026-08-02T10:15:00.000Z"),
            summary(id = "blank", updatedAt = ""),
            summary(id = "junk", updatedAt = "not-a-date"),
        )
        val out = formSchemaSort(rows, SortColumn.UPDATED_AT, descending = true)
        assertEquals(3, out.size)
        assertEquals(listOf("blank", "iso", "junk"), out.map { it.id }.sorted())
    }
}
