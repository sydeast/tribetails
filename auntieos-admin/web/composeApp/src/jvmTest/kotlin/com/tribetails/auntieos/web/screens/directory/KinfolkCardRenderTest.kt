package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.toAwtImage
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.NO_EMERGENCY_CONTACT
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import java.io.File
import javax.imageio.ImageIO
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #829 review: at the grid's 290dp minimum, a card with a phone, an email, a last
 * visit, kin, and no Emergency Contact must keep every footer element inside the
 * fixed 196dp card, with both pills on one line. The PNG is written for a human
 * look (path in the assertion message and stdout).
 */
@OptIn(ExperimentalTestApi::class)
class KinfolkCardRenderTest {

    @Test
    fun theFlaggedCardFitsAtTheMinimumWidth() = runDesktopComposeUiTest {
        val kf = Kinfolk(
            _id = "kf1",
            firstName = "Dana",
            lastName = "Montgomery-Alvarez",
            phoneNumber = "8055550100",
            email = "dana@example.com",
            status = "active",
        )
        val kin = listOf(Kin(_id = "k1", name = "Biscuit"), Kin(_id = "k2", name = "Marmalade"), Kin(_id = "k3", name = "Pepper"), Kin(_id = "k4", name = "Juniper"))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                Box(Modifier.width(290.dp).height(196.dp).testTag("card")) {
                    KinfolkCard(kf = kf, kin = kin, lastVisit = "2026-09-01", isNew = false, onClick = {})
                }
            }
        }
        waitForIdle()

        val out = File(System.getProperty("java.io.tmpdir"), "kinfolk-card-290.png")
        ImageIO.write(onRoot().captureToImage().toAwtImage(), "png", out)
        println("KinfolkCardRenderTest PNG: ${out.absolutePath}")

        // The card is clickable, so its texts merge into the card's node; the
        // unmerged tree gives each element its own bounds.
        fun text(t: String, substring: Boolean = false) =
            onNodeWithText(t, substring = substring, ignoreCase = true, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        fun described(d: String) =
            onNodeWithContentDescription(d, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot

        val card = onNodeWithTag("card").fetchSemanticsNode().boundsInRoot
        val flag = text(NO_EMERGENCY_CONTACT)
        val name = text("Dana Montgomery-Alvarez")
        val chip = text("Biscuit")
        val phone = described("Open profile to call")
        val email = described("Open profile to email")
        val visit = text("Last visit", substring = true)
        val status = text("active")
        println("KinfolkCardRenderTest bounds: card=$card name=$name flag=$flag chip=$chip phone=$phone email=$email visit=$visit status=$status")

        // Content sits inside the card's 18dp padding; anything past it is clipped.
        val inner = Rect(card.left + 18f, card.top + 18f, card.right - 18f, card.bottom - 18f)
        fun visibleInside(r: Rect, what: String) {
            assertTrue(r.width > 0f && r.height > 0f, "$what collapsed to $r (PNG: ${out.absolutePath})")
            assertTrue(
                r.left >= inner.left - 0.5f && r.right <= inner.right + 0.5f && r.top >= inner.top - 0.5f && r.bottom <= inner.bottom + 0.5f,
                "$what $r is outside the card's content area $inner (PNG: ${out.absolutePath})",
            )
        }
        visibleInside(flag, "the No Emergency Contact pill text")
        visibleInside(name, "the household name")
        visibleInside(chip, "the first kin chip")
        visibleInside(phone, "the phone button")
        visibleInside(email, "the email button")
        visibleInside(visit, "Last visit")
        visibleInside(status, "the status pill text")

        // The flag is in the header, above the chips, and on one line.
        assertTrue(flag.bottom <= chip.top, "the flag $flag is not above the kin chips $chip")
        assertTrue(flag.height <= status.height + 1f, "the flag wrapped: $flag vs $status")
        // The chip avatar is 28dp; a chip row squeezed below that clips it.
        assertTrue(chip.top >= flag.bottom && phone.top - chip.top >= 28f, "the kin chip row is squeezed: chip=$chip footer=$phone")
        // Footer order, no overlaps.
        assertTrue(phone.right <= email.left && email.right <= visit.left && visit.right <= status.left, "footer elements overlap")
    }
}
