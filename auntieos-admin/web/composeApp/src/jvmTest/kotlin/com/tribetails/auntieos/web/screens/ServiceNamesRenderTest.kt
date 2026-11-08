package com.tribetails.auntieos.web.screens

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1592: a service pill for a stored `serviceType` says the KinCare's name,
 * from the catalog the app root provides. "Long walk" runs 60 minutes, so a
 * stored `visit_60` reads as "Long walk".
 */
@OptIn(ExperimentalTestApi::class)
class ServiceNamesRenderTest {
    private val catalog = BusinessSettings(
        serviceRates = mapOf("Long walk" to "45"),
        serviceDurations = mapOf("Long walk" to "60"),
    ).serviceCatalog()

    @Test
    fun aStoredKeyPillSaysTheKinCareName() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                CompositionLocalProvider(LocalServiceCatalog provides catalog) {
                    BookingServicePill("visit_60")
                }
            }
        }
        onNodeWithText("Long walk").assertIsDisplayed()
        assertEquals(0, onAllNodesWithText("visit_60").fetchSemanticsNodes().size)
    }

    @Test
    fun withNoCatalogThePillKeepsTheStoredText() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) { BookingServicePill("Off-Book Visit") }
        }
        onNodeWithText("Off-Book Visit").assertIsDisplayed()
    }

    @Test
    fun settingsGiveTheCatalogBothMaps() {
        assertEquals("Long walk", catalog.nameOf("visit_60"))
    }
}
