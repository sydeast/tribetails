package com.tribetails.auntieos.ui.admin

import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #1594: the KinTale list is its own back-stack destination, and opening a
 * KinTale takes it off the screen. Navigation brings it back through saved
 * state, the same path a restore takes, so this pins that the search and the
 * sort come back with it instead of resetting.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class KinTaleListFilterRestoreTest {

    @get:Rule
    val rule = createComposeRule()

    @Test
    fun searchAndSortSurviveARestore() {
        val tester = StateRestorationTester(rule)
        var filter: KinTaleListFilter? = null
        tester.setContent { filter = rememberKinTaleListFilter() }

        rule.runOnIdle {
            filter!!.search = "Biscuit"
            filter!!.sort = ReportSort.Kinfolk
        }
        filter = null
        tester.emulateSavedInstanceStateRestore()

        rule.runOnIdle {
            assertEquals("Biscuit", filter!!.search)
            assertEquals(ReportSort.Kinfolk, filter!!.sort)
        }
    }

    @Test
    fun aFreshListOpensUnfilteredNewestFirst() {
        var filter: KinTaleListFilter? = null
        rule.setContent { filter = rememberKinTaleListFilter() }
        rule.runOnIdle {
            assertEquals("", filter!!.search)
            assertEquals(ReportSort.Newest, filter!!.sort)
        }
    }
}
