package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #391: the notification prefs screen's sub-section boundary was the FAINTEST
 * thing on it (plain `labelMedium`, no uppercase, no divider) while every
 * channel row below it drew its own hairline. [NotifSubsectionHeading] is what
 * replaced it; these pin the two structural facts that make it a boundary
 * rather than more of the same texture: the rule exists on every sub-section
 * but the first, and the title is genuinely transformed (not just styled) to
 * uppercase.
 *
 * Mounts [NotifSubsectionHeading] directly rather than the full
 * [AdminNotificationPrefsScreen]: that screen reads `AuntieOSApp.instance
 * .repository` itself with no injectable seam, so this is the only piece of
 * #391's Android change actually testable without wiring a fake Firebase
 * backend, which is well outside this issue's scope.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NotifSubsectionHeadingTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `the first sub-section in a hat carries no divider`() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                NotifSubsectionHeading(title = "Bookings and visits", isFirst = true)
            }
        }
        rule.onAllNodesWithTag("mynotif-section-divider").assertCountEquals(0)
        rule.onNodeWithText("BOOKINGS AND VISITS").assertExists()
    }

    @Test
    fun `every sub-section after the first draws exactly one divider above it`() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                Column {
                    NotifSubsectionHeading(title = "Bookings and visits", isFirst = true)
                    NotifSubsectionHeading(title = "Messages", isFirst = false)
                    NotifSubsectionHeading(title = "Billing and payments", isFirst = false)
                }
            }
        }
        // Three sub-sections, two boundaries between them: the first carries
        // none, the second and third carry exactly one apiece.
        rule.onAllNodesWithTag("mynotif-section-divider").assertCountEquals(2)
    }

    @Test
    fun `the title is genuinely uppercased, not merely styled to look it`() {
        // A CSS-style text-transform would leave the underlying string alone;
        // this asserts the rendered node, so a regression that stops calling
        // .uppercase() and relies on styling instead is caught here too.
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                NotifSubsectionHeading(title = "KinTales and comments", isFirst = false)
            }
        }
        rule.onNodeWithText("KINTALES AND COMMENTS").assertExists()
        rule.onNodeWithText("KinTales and comments").assertDoesNotExist()
    }
}
