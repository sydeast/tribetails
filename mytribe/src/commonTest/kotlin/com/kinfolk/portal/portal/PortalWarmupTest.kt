package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.screens.schedule.bookingDateKey
import com.kinfolk.portal.screens.schedule.bookingHorizonEnd
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1282: the portal warm-up on Android. `FakeFunctionsClient` answers every
 * unstubbed name with an error and `attempt {}` swallows it, so a run that
 * merely returns proves nothing; the assertions are on which callables were
 * asked, with what.
 */
class PortalWarmupTest {

    private val today = LocalDate(2026, 11, 2)

    private fun home(billingAccess: Boolean) =
        MyHomeResult(kinfolkId = "kin-1", displayName = "The Ruiz Tribe", billingAccess = billingAccess)

    /** Every callable a screen reads on first open, money aside. getFormSchema is asked four times. */
    private val screenReads = listOf(
        "getMyAccount", "getFormSchema",
        "getNotificationCatalog", "getMyNotificationPrefs",
        "getMyTribeProfile", "getFormSchema", "getFormSchema", "getVetClinics", "getBusinessContact", "listMembers",
        "getServiceCatalog", "getBusinessClosures", "getBookingPolicy",
        "getMyVisits",
        "getMyKinPhotos",
        "getFormSchema", "getBreeds",
    )
    private val moneyReads = listOf("getMyInvoices", "getAccountCreditHistory", "getMyPaymentMethod")

    @Test
    fun `with billing access every screen read fires, money included`() = runTest {
        val fake = FakeFunctionsClient()
        PortalWarmup(fake).run(home(billingAccess = true), today)
        assertEquals((screenReads + moneyReads).sorted(), fake.calls.map { it.first }.sorted())
    }

    @Test
    fun `without billing access the money reads are skipped and nothing else is`() = runTest {
        val fake = FakeFunctionsClient()
        PortalWarmup(fake).run(home(billingAccess = false), today)
        val names = fake.calls.map { it.first }
        assertEquals(screenReads.sorted(), names.sorted())
        for (money in moneyReads) assertFalse(money in names, "$money must not fire without billing access")
    }

    @Test
    fun `a failing read does not propagate and the others still fire`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyTribeProfile", RuntimeException("Your session was ended (session-revoked)."))
        fake.stub("getBookingPolicy", buildJsonObject { put("mode", "clock") })

        val outcomes = PortalWarmup(fake).run(home(billingAccess = true), today)

        assertTrue(outcomes.single { it.name == "getMyTribeProfile" }.result.isFailure)
        assertTrue(outcomes.single { it.name == "getBookingPolicy" }.result.isSuccess)
        assertEquals(screenReads.size + moneyReads.size, fake.calls.size)
    }

    @Test
    fun `the household id travels with every household-scoped read`() = runTest {
        val fake = FakeFunctionsClient()
        PortalWarmup(fake).run(home(billingAccess = true), today)
        val scoped = listOf(
            "getMyTribeProfile", "listMembers", "getServiceCatalog", "getMyVisits", "getMyKinPhotos",
            "getMyInvoices", "getAccountCreditHistory", "getMyPaymentMethod",
        )
        for (name in scoped) {
            val payload = fake.calls.single { it.first == name }.second
            assertEquals("kin-1", payload?.get("kinfolkId")?.jsonPrimitive?.content, "$name payload")
        }
    }

    @Test
    fun `closures ask for today through the booking horizon, like the wizard`() = runTest {
        val fake = FakeFunctionsClient()
        PortalWarmup(fake).run(home(billingAccess = false), today)
        val payload = fake.calls.single { it.first == "getBusinessClosures" }.second!!
        assertEquals("2026-11-02", payload["fromDate"]?.jsonPrimitive?.content)
        assertEquals(bookingDateKey(bookingHorizonEnd(today)), payload["toDate"]?.jsonPrimitive?.content)
    }

    @Test
    fun `visits and photos read the screens' own page sizes`() = runTest {
        val fake = FakeFunctionsClient()
        PortalWarmup(fake).run(home(billingAccess = false), today)
        assertEquals("10", fake.calls.single { it.first == "getMyVisits" }.second!!["limit"]?.jsonPrimitive?.content)
        assertEquals("12", fake.calls.single { it.first == "getMyKinPhotos" }.second!!["limit"]?.jsonPrimitive?.content)
    }

    @Test
    fun `the form schemas asked for are the four the screens read`() = runTest {
        val fake = FakeFunctionsClient()
        PortalWarmup(fake).run(home(billingAccess = false), today)
        val schemas = fake.calls.filter { it.first == "getFormSchema" }.map { it.second!!["schemaId"]?.jsonPrimitive?.content }
        assertEquals(listOf("account", "homeAccess", "kinProfile", "tribeProfile"), schemas.sortedBy { it })
    }
    @Test
    fun `the shell runs only on a home payload that actually resolved`() {
        val resolved = home(billingAccess = true)
        assertEquals(resolved, PortalWarmup.warmupPayload(resolved, homeError = null))
        assertEquals(null, PortalWarmup.warmupPayload(null, homeError = null))
    }
    @Test
    fun `a failed home read warms nothing, however its fallback payload reads`() {
        // The shell's fallback after a failed getMyHome carries the default billingAccess = true.
        val fallback = MyHomeResult(kinfolkId = "kin-1", displayName = "The kin-1 Tribe")
        assertEquals(null, PortalWarmup.warmupPayload(fallback, homeError = "deadline exceeded"))
    }
}
