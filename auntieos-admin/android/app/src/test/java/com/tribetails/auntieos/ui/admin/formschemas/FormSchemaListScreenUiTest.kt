package com.tribetails.auntieos.ui.admin.formschemas

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.BusinessAdminMember
import com.tribetails.auntieos.data.model.BusinessAdminRoster
import com.tribetails.auntieos.data.model.FormSchemaSummary
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [FormSchemaListScreen] on the navy ground (#755): the mock's hero, its
 * controls row, its table and its footer, with no panel and no second title
 * around any of them; and FAIL LOUD, a failed read shows the failure, never
 * the empty state.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FormSchemaListScreenUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun row(
        id: String = "tribeProfile",
        name: String = "Tribe Profile",
        version: Int = 3,
        updatedAt: String = "2026-07-01T00:00:00.000Z",
        updatedBy: String = "admin1",
    ) = FormSchemaSummary(id = id, name = name, version = version, updatedAt = updatedAt, updatedBy = updatedBy)

    private fun repoReturning(rows: List<FormSchemaSummary>): AuntieRepository {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.listFormSchemas() } returns Result.success(rows)
        coEvery { repo.listBusinessAdmins() } returns Result.success(
            BusinessAdminRoster(
                members = listOf(
                    BusinessAdminMember(uid = "admin1", email = "auntie@tribetails.example"),
                ),
            ),
        )
        return repo
    }

    // A tall viewport so the whole list composes: LazyColumn only lays out
    // what fits, and this asserts on the footer under the second row.
    @Test
    @Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
    fun `draws the mock, hero kicker and New schema, the count chip, one row per schema, Reload, and no panel title`() {
        composeRule.setContent {
            AuntieOSTheme {
                FormSchemaListScreen(
                    onBack = {},
                    onOpenEditor = {},
                    repository = repoReturning(
                        listOf(
                            row(),
                            row(id = "pet_health_profile", name = "Pet Health Profile", version = 1, updatedAt = ""),
                        ),
                    ),
                )
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("THE DEN · ADMIN").assertIsDisplayed()
        composeRule.onNodeWithText("New schema").assertIsDisplayed()
        composeRule.onNodeWithText("2 schemas").assertIsDisplayed()
        composeRule.onNodeWithText("Tribe Profile").assertIsDisplayed()
        composeRule.onNodeWithText("Pet Health Profile").assertIsDisplayed()
        // The mock's `.ver`: plain mono text per row.
        composeRule.onNodeWithText("v3").assertIsDisplayed()
        composeRule.onNodeWithText("v1").assertIsDisplayed()
        // The roster resolves the uid to the admin's address on the updated line.
        composeRule.onNodeWithText("auntie@tribetails.example", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Reload").assertIsDisplayed()
        // The old wrapper panel and its title are gone; the table sits on the ground.
        assertEquals(0, composeRule.onAllNodesWithText("All schemas").fetchSemanticsNodes().size)
    }

    @Test
    fun `tapping a row opens that schema in the editor`() {
        var opened: String? = "unset"
        composeRule.setContent {
            AuntieOSTheme {
                FormSchemaListScreen(
                    onBack = {},
                    onOpenEditor = { opened = it },
                    repository = repoReturning(listOf(row(id = "meet_greet_v1", name = "Meet and Greet"))),
                )
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("Meet and Greet").performClick()
        composeRule.waitForIdle()

        assertEquals("meet_greet_v1", opened)
    }

    @Test
    fun `New schema opens the editor in create mode`() {
        var opened: String? = "unset"
        composeRule.setContent {
            AuntieOSTheme {
                FormSchemaListScreen(
                    onBack = {},
                    onOpenEditor = { opened = it },
                    repository = repoReturning(listOf(row())),
                )
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("New schema").performClick()
        composeRule.waitForIdle()

        assertEquals(null, opened)
    }

    @Test
    fun `an empty list shows the proven-empty box, with no controls row`() {
        composeRule.setContent {
            AuntieOSTheme {
                FormSchemaListScreen(onBack = {}, onOpenEditor = {}, repository = repoReturning(emptyList()))
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("No schemas yet. Tap New schema to create one.").assertIsDisplayed()
        assertEquals(0, composeRule.onAllNodesWithText("0 schemas").fetchSemanticsNodes().size)
    }

    /** "Nothing is authored" and "we could not find out" are opposite facts. */
    @Test
    fun `a failed read shows the failure, never the empty state`() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.listFormSchemas() } returns Result.failure(Exception("permission-denied"))
        coEvery { repo.listBusinessAdmins() } returns Result.success(BusinessAdminRoster())
        composeRule.setContent {
            AuntieOSTheme {
                FormSchemaListScreen(onBack = {}, onOpenEditor = {}, repository = repo)
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("listFormSchemas failed: permission-denied").assertIsDisplayed()
        composeRule.onNodeWithText("Schemas unavailable while the load is failing.").assertIsDisplayed()
        assertEquals(
            0,
            composeRule.onAllNodesWithText("No schemas yet. Tap New schema to create one.")
                .fetchSemanticsNodes().size,
        )
    }
}
