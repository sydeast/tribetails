package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1625: approving a Text or Email draft in the desktop console sends it, after
 * the draft write lands, and the toast never claims a delivery that did not
 * happen. Before this the console toasted "approved and queued for delivery"
 * while nothing was sent.
 */
class ApproveSendTest {
    private val rosa = Kinfolk(_id = "kf1", firstName = "Dana", lastName = "Wren", email = "catch@hanasamku.com", phoneNumber = "+15555550100")

    @Test fun `only Text and Email deliver`() {
        assertEquals(ExternalChannel.Email, approveDeliveryChannel(MessageType.Email))
        assertEquals(ExternalChannel.Sms, approveDeliveryChannel(MessageType.Text))
        assertNull(approveDeliveryChannel(MessageType.Visit))
        assertNull(approveDeliveryChannel(MessageType.Blog))
    }

    @Test fun `an Email approve writes, logs, then sends, in that order`() = runTest {
        val steps = mutableListOf<String>()
        val outcome = runApprove(
            write = { steps += "write"; WriteResult.Ok(Unit) },
            audit = { steps += "audit" },
            channel = ExternalChannel.Email,
            send = { steps += "send"; WriteResult.Ok(ExternalSendResult("email", "pm1", "c***@hanasamku.com")) },
        )
        assertEquals(listOf("write", "audit", "send"), steps)
        assertEquals(ApproveOutcome.Sent(ExternalChannel.Email, "c***@hanasamku.com"), outcome)
        assertEquals("Draft #d1 approved and sent by email to c***@hanasamku.com.", approveOutcomeText("d1", outcome))
    }

    @Test fun `a refused write sends nothing and logs nothing`() = runTest {
        var sent = false
        var audited = false
        val outcome = runApprove(
            write = { WriteResult.Err("PERMISSION_DENIED") },
            audit = { audited = true },
            channel = ExternalChannel.Sms,
            send = { sent = true; WriteResult.Ok(ExternalSendResult("sms", "SM1", "***0100")) },
        )
        assertFalse(sent)
        assertFalse(audited)
        assertTrue(outcome is ApproveOutcome.WriteRefused)
    }

    @Test fun `a refused send says the household did not get it`() = runTest {
        val outcome = runApprove(
            write = { WriteResult.Ok(Unit) },
            audit = {},
            channel = ExternalChannel.Sms,
            send = { WriteResult.Err("recipient_opted_out") },
        )
        val text = approveOutcomeText("d1", outcome)
        assertTrue(text.startsWith("The draft is approved, but the send failed"), text)
        assertFalse(text.contains("queued"))
    }

    @Test fun `a KinTale approve sends nothing and does not claim a delivery`() = runTest {
        val outcome = runApprove(write = { WriteResult.Ok(Unit) }, audit = {}, channel = null, send = null)
        assertEquals(ApproveOutcome.Approved, outcome)
        val text = approveOutcomeText("d1", outcome)
        assertFalse(text.contains("queued"))
        assertFalse(text.contains("sent by"))
    }

    @Test fun `the blocker mirrors the web admin`() {
        val none = rosa.copy(email = "", phoneNumber = "")
        assertEquals("Email needs a subject.", approveSendBlocker(ExternalChannel.Email, rosa, " ", "body"))
        assertEquals(
            "Dana Wren has no email address on file. Add one in Directory before sending.",
            approveSendBlocker(ExternalChannel.Email, none, "Hi", "body"),
        )
        assertEquals(
            "Dana Wren has no phone number on file. Add one in Directory before sending.",
            approveSendBlocker(ExternalChannel.Sms, none, "", "body"),
        )
        assertNull(approveSendBlocker(null, none, "", "body"))
        assertNull(approveSendBlocker(ExternalChannel.Sms, rosa, "", "body"))
        assertEquals("The message is empty. Write something before approving.", approveSendBlocker(ExternalChannel.Sms, rosa, "", " "))
    }

    @Test fun `the address is the channel's field`() {
        assertEquals("catch@hanasamku.com", approveSendAddress(ExternalChannel.Email, rosa))
        assertEquals("+15555550100", approveSendAddress(ExternalChannel.Sms, rosa))
    }
}
