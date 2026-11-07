package com.tribetails.auntieos.ui.admin.scheduling
import org.junit.Assert.assertEquals
import org.junit.Test
/** #1607: the bulk bar offers only what the picked rows can take. */
class BulkActionsForSelectionTest {
    private val requests = setOf("r1", "r2")
    private val scheduled = setOf("s1", "s2")
    @Test
    fun `scheduled visits are offered Cancel and Reschedule, never Approve or Reject`() {
        assertEquals(listOf("CANCEL", "RESCHEDULE"), bulkActionsForSelection(setOf("s1", "s2"), requests, scheduled))
    }
    @Test
    fun `requests are offered Approve and Reject only`() {
        assertEquals(listOf("APPROVE", "REJECT"), bulkActionsForSelection(setOf("r1"), requests, scheduled))
    }
    @Test
    fun `a mixed pick is offered each action that fits one of them`() {
        assertEquals(
            listOf("APPROVE", "REJECT", "CANCEL", "RESCHEDULE"),
            bulkActionsForSelection(setOf("r1", "s1"), requests, scheduled),
        )
        assertEquals(emptyList<String>(), bulkActionsForSelection(emptySet(), requests, scheduled))
    }
}
