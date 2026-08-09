package com.tribetails.auntieos.ui.components

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Android twin of `src/components/MergePreview.test.tsx`. Same two
 * questions: does the operator see the copy a kinfolk receives, and are the
 * merge fields that will arrive blank named on screen.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1440dp-h2400dp-xhdpi")
class MergePreviewTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `warns once per unresolved field and names the count`() {
        compose.setContent {
            AuntieOSTheme {
                MergePreview(
                    subject = "Welcome",
                    body = "Hi {{kinfolkName}}, see {{link}}.",
                    sample = mapOf("kinfolkName" to "Sandy"),
                )
            }
        }
        compose.onNodeWithText("1 merge field has no sample value: link").assertIsDisplayed()
    }

    @Test
    fun `says nothing when every field resolves`() {
        compose.setContent {
            AuntieOSTheme {
                MergePreview(
                    subject = "Welcome",
                    body = "Hi {{kinfolkName}}.",
                    sample = mapOf("kinfolkName" to "Sandy"),
                )
            }
        }
        compose.onNodeWithText("merge field", substring = true).assertDoesNotExist()
    }

    @Test
    fun `counts an unresolved field in the subject, not only the body`() {
        compose.setContent {
            AuntieOSTheme {
                MergePreview(
                    subject = "Your {{serviceType}} is confirmed",
                    body = "All set.",
                    sample = emptyMap<String, String>(),
                )
            }
        }
        compose.onNodeWithText("1 merge field has no sample value: serviceType").assertIsDisplayed()
    }

    @Test
    fun `pluralizes and names every distinct key`() {
        compose.setContent {
            AuntieOSTheme {
                MergePreview(subject = "Welcome", body = "{{link}} {{code}} {{link}}", sample = emptyMap<String, String>())
            }
        }
        compose.onNodeWithText("2 merge fields have no sample value: link, code").assertIsDisplayed()
    }

    @Test
    fun `renders the substituted body a kinfolk would read, not the raw token`() {
        compose.setContent {
            AuntieOSTheme {
                MergePreview(
                    subject = "Confirmed",
                    body = "Hi {{kinfolkName}}, see you then.",
                    sample = ENRICHABLE_SAMPLE,
                )
            }
        }
        compose.onNodeWithText("Hi Sandy Wren, see you then.").assertIsDisplayed()
    }

    @Test
    fun `shows the empty link defect verbatim, which is why this pane exists`() {
        compose.setContent {
            AuntieOSTheme {
                MergePreview(
                    subject = "A Kinfolk just finished setting up",
                    body = "See their account here: []",
                    sample = ENRICHABLE_SAMPLE,
                )
            }
        }
        compose.onNodeWithText("See their account here: []").assertIsDisplayed()
    }

    @Test
    fun `renders the footnote a caller supplies`() {
        compose.setContent {
            AuntieOSTheme {
                MergePreview(
                    subject = "Hi",
                    body = "Body.",
                    sample = emptyMap<String, String>(),
                    footnote = "merge fields resolve at send",
                )
            }
        }
        compose.onNodeWithText("merge fields resolve at send").assertIsDisplayed()
    }

    @Test
    fun `the standalone warning names the same fields without drawing a card`() {
        compose.setContent {
            AuntieOSTheme {
                MergeFieldWarning(subject = "Hi", body = "see {{link}}", sample = ENRICHABLE_SAMPLE)
            }
        }
        compose.onNodeWithText("1 merge field has no sample value: link").assertIsDisplayed()
    }

    @Test
    fun `the standalone warning stays silent when nothing is unresolved`() {
        compose.setContent {
            AuntieOSTheme {
                MergeFieldWarning(subject = "Hi", body = "Hi {{kinfolkName}}", sample = ENRICHABLE_SAMPLE)
            }
        }
        compose.onNodeWithText("merge field", substring = true).assertDoesNotExist()
    }

    @Test
    fun `counts a merge field that only appears in the html`() {
        compose.setContent {
            AuntieOSTheme {
                MergePreview(
                    subject = "Hi",
                    body = "Plain.",
                    sample = ENRICHABLE_SAMPLE,
                    html = "<a href=\"{{link}}\">Account</a>",
                )
            }
        }
        compose.onNodeWithText("1 merge field has no sample value: link").assertIsDisplayed()
    }
}
