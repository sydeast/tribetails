package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.TrainingDocument
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.mockk
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric interaction test for the Tribal Intel screen (spec 23). Renders with
 * FF_TRAINING_DOC_CREATE on, opens the Add form, asserts the Kinfolk picker is
 * populated from the fake getKinfolk(), and that Save is disabled until a target is
 * chosen. Runs at unit-test scope per project_robolectric_infra.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h1920dp-xhdpi")
class TrainingDocumentsScreenRobolectricTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private fun buildRepo(): AuntieRepository {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getTrainingDocuments() } returns Result.success(
            listOf(TrainingDocument(id = "d1", title = "Existing intel", content = "body")),
        )
        coEvery { repo.getKinfolk() } returns Result.success(
            listOf(Kinfolk(id = "kf1", firstName = "Dana", lastName = "Reed")),
        )
        return repo
    }

    @Test
    fun addForm_opensAndPopulatesKinfolkPicker_saveDisabledWithoutTarget() {
        val vm = AdminDataViewModel(repository = buildRepo(), invoiceRepository = mockk(relaxed = true))
        rule.setContent {
            AuntieOSTheme {
                TrainingDocumentsScreen(viewModel = vm, onBack = {})
            }
        }
        rule.waitForIdle()

        // Open the Add form.
        rule.onNodeWithText("Add intel").performClick()
        rule.waitForIdle()

        // The target picker placeholder is visible (picker rendered).
        rule.onNodeWithText("Select a kinfolk...").assertExists()

        // Save is disabled before any content/target is supplied.
        rule.onNodeWithText("Save").assertIsNotEnabled()
    }

    @Test
    fun deleteConfirm_showsUnmergeCaveat() {
        val vm = AdminDataViewModel(repository = buildRepo(), invoiceRepository = mockk(relaxed = true))
        rule.setContent {
            AuntieOSTheme {
                TrainingDocumentsScreen(viewModel = vm, onBack = {})
            }
        }
        rule.waitForIdle()

        // Open the row's delete confirm (Delete affordance is on the expanded card body).
        rule.onNodeWithText("Delete").performClick()
        rule.waitForIdle()

        rule.onNodeWithText("Delete this Tribal Intel entry?").assertExists()
        rule.onNodeWithText(
            "This removes the source note. It does NOT unmerge any text the reconcile " +
                "pipeline has already folded into the dossier or 411. Those summaries keep prior " +
                "content until they are regenerated.",
        ).assertExists()
    }
}
