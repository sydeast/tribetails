package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.CommunicationType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Message-type selector + blog-no-recipient rule (spec 19 items 1/2). */
class MessageTypeTest {

    @Test
    fun typesMapToBackendCommunicationType() {
        assertEquals(CommunicationType.VISIT_REPORT, MessageType.Visit.type)
        assertEquals(CommunicationType.SMS, MessageType.Text.type)
        assertEquals(CommunicationType.EMAIL, MessageType.Email.type)
        assertEquals(CommunicationType.BLOG_POST, MessageType.Blog.type)
    }

    @Test
    fun blogIsRecipientLess() {
        assertTrue(MessageType.Visit.needsRecipient)
        assertTrue(MessageType.Text.needsRecipient)
        assertTrue(MessageType.Email.needsRecipient)
        assertFalse(MessageType.Blog.needsRecipient)
    }

    @Test
    fun generateRecipientOmittedForBlog() {
        assertEquals("Wanda Thorne", generateRecipient(MessageType.Visit, "Wanda Thorne"))
        assertEquals("", generateRecipient(MessageType.Blog, "Wanda Thorne"))
    }
}
