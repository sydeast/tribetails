package com.kinfolk.portal.screens.account

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.Account
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1336: emptying an Account field on Android and saving must clear it. Before,
 * a blank was dropped from the request and `saveMyAccount`'s merge kept the old
 * phone, backup email, backup phone or photo.
 */
class AccountClearFieldsTest {

    private val stored = Account(
        uid = "u1", email = "catch@hanasamku.com", displayName = "Sam Lee",
        phone = "+18055550100", photoUrl = "https://res.cloudinary.com/x/a.jpg",
        backupEmail = "pawsome@hanasamku.com", backupPhone = "+18055550101",
        kinfolkIds = listOf("f1"), hasPaymentMethod = false, updatedAtMs = null,
    )

    private suspend fun sent(changes: AccountChanges): JsonObject {
        val fake = FakeFunctionsClient()
        fake.stub("saveMyAccount", buildJsonObject { put("ok", true) })
        PortalApi(fake).saveMyAccount(
            displayName = changes.displayName,
            phone = changes.phone,
            photoUrl = changes.photoUrl,
            backupEmail = changes.backupEmail,
            backupPhone = changes.backupPhone,
            clearFields = changes.clearFields,
        )
        val (name, args) = fake.calls.single()
        assertEquals("saveMyAccount", name)
        return args!!
    }

    /** The form as the screen seeds it: phones formatted, everything else raw. */
    private fun form(
        displayName: String = "Sam Lee",
        phone: String = "(805) 555-0100",
        photoUrl: String = "https://res.cloudinary.com/x/a.jpg",
        backupEmail: String = "pawsome@hanasamku.com",
        backupPhone: String = "(805) 555-0101",
    ) = accountChanges(stored, displayName, phone, photoUrl, backupEmail, backupPhone)

    @Test
    fun `an untouched form sends nothing, formatted phones included`() = runTest {
        assertTrue(sent(form()).isEmpty())
    }

    @Test
    fun `an emptied backup email is sent as JSON null and nothing else is sent`() = runTest {
        val body = sent(form(backupEmail = ""))
        assertEquals(JsonNull, body["backupEmail"])
        assertEquals(setOf("backupEmail"), body.keys)
    }

    @Test
    fun `every clearable field emptied goes as null`() = runTest {
        val body = sent(form(phone = " ", photoUrl = "", backupEmail = "", backupPhone = ""))
        assertEquals(JsonNull, body["phone"])
        assertEquals(JsonNull, body["photoUrl"])
        assertEquals(JsonNull, body["backupEmail"])
        assertEquals(JsonNull, body["backupPhone"])
        assertEquals(setOf("phone", "photoUrl", "backupEmail", "backupPhone"), body.keys)
    }

    @Test
    fun `a changed field carries its value`() = runTest {
        val body = sent(form(displayName = "Sam Q Lee", backupPhone = "(805) 555-0199"))
        assertEquals("Sam Q Lee", body["displayName"]!!.jsonPrimitive.content)
        assertEquals("(805) 555-0199", body["backupPhone"]!!.jsonPrimitive.content)
        assertEquals(setOf("displayName", "backupPhone"), body.keys)
    }

    @Test
    fun `a blank name is not sent, because the server cannot clear it`() = runTest {
        val body = sent(form(displayName = ""))
        assertTrue(body.isEmpty())
    }

    @Test
    fun `a name equal to the email was shown blank and stays unsent`() = runTest {
        val legacy = stored.copy(displayName = stored.email)
        val changes = accountChanges(legacy, "", "(805) 555-0100", stored.photoUrl!!, stored.backupEmail!!, "(805) 555-0101")
        assertTrue(sent(changes).isEmpty())
    }

    @Test
    fun `an account that never loaded sends only filled fields and clears nothing`() = runTest {
        val changes = accountChanges(null, "Sam", "", "", "pawsome@hanasamku.com", "")
        assertTrue(changes.clearFields.isEmpty())
        assertEquals(setOf("displayName", "backupEmail"), sent(changes).keys)
    }

    @Test
    fun `displayName in clearFields is ignored on the wire`() = runTest {
        val body = sent(AccountChanges(clearFields = setOf("displayName", "phone")))
        assertEquals(setOf("phone"), body.keys)
    }
}
