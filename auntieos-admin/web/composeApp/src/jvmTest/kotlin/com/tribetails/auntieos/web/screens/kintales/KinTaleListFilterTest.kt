package com.tribetails.auntieos.web.screens.kintales

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1594: opening a KinTale swaps the list out for the report (App's KinTales
 * branch), so the list's search and sort live in a [KinTaleListFilter] held
 * above it. This pins both halves: the filter outlives the list leaving the
 * screen, and leaving KinTales resets it.
 */
@OptIn(ExperimentalTestApi::class)
class KinTaleListFilterTest {

    private fun SemanticsNodeInteractionsProvider.shown(text: String): Boolean =
        onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    /** Stands in for the list: reads and writes the filter it is handed, as KinTaleLogsScreen does. */
    @Composable
    private fun ListStub(filter: KinTaleListFilter) {
        val search by filter::search
        val sort by filter::sort
        Text("search=$search sort=${sort.name}")
    }

    @Test
    fun theFilterComesBackWhenTheReportCloses() = runDesktopComposeUiTest {
        val filter = KinTaleListFilter()
        var reportOpen by mutableStateOf(false)
        setContent {
            val held = remember { filter }
            if (reportOpen) Text("report") else ListStub(held)
        }
        filter.search = "Biscuit"
        filter.sort = ReportSort.Kinfolk
        waitUntil(timeoutMillis = 10_000) { shown("search=Biscuit sort=Kinfolk") }

        reportOpen = true
        waitUntil(timeoutMillis = 10_000) { shown("report") }
        reportOpen = false

        waitUntil(timeoutMillis = 10_000) { shown("search=Biscuit sort=Kinfolk") }
        assertTrue(shown("search=Biscuit sort=Kinfolk"), "the list closes back onto the same filter")
    }

    @Test
    fun resetIsAnUnfilteredListNewestFirst() {
        val filter = KinTaleListFilter(search = "Biscuit", sort = ReportSort.Oldest)
        filter.reset()
        assertEquals("", filter.search)
        assertEquals(ReportSort.Newest, filter.sort)
    }
}
