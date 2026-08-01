package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PortalApiTest {

    @Test
    fun `getMyHome decodes the basic shape`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyHome", buildJsonObject {
            put("kinfolkId", "demo-family-001")
            put("displayName", "The Foster")
        })
        val api = PortalApi(fake)
        val res = api.getMyHome("demo-family-001")
        assertEquals("demo-family-001", res.kinfolkId)
        assertEquals("The Foster", res.displayName)
        assertEquals(1, fake.calls.size)
        assertEquals("getMyHome", fake.calls[0].first)
    }

    @Test
    fun `getMyHome throws when displayName is missing`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyHome", buildJsonObject { put("kinfolkId", "x") })
        val api = PortalApi(fake)
        assertFailsWith<IllegalStateException> { api.getMyHome("x") }
    }

    @Test
    fun `getMyInvoices splits open paid credits and exposes account balance`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 250L)
            put("open", buildJsonArray {
                add(buildJsonObject {
                    put("id", "1001")
                    put("kinfolkId", "3")
                    put("total", 315.0)
                    put("amountDue", 100.0)
                    put("isPaid", false)
                    put("status", "open")
                })
            })
            put("paid", buildJsonArray {
                add(buildJsonObject {
                    put("id", "1000")
                    put("kinfolkId", "3")
                    put("total", 250.0)
                    put("amountDue", 0.0)
                    put("isPaid", true)
                    put("status", "paid")
                })
            })
            put("credits", buildJsonArray {
                add(buildJsonObject {
                    put("id", "credit-1")
                    put("kinfolkId", "3")
                    put("total", -25.0)
                    put("amountDue", -25.0)
                    put("status", "credit")
                    put("creditAmountCents", 2500L)
                    put("originalPaymentIntentId", "pi_xyz")
                })
            })
        })
        val api = PortalApi(fake)
        val res = api.getMyInvoices("3")
        assertEquals(1, res.open.size)
        assertEquals(1, res.paid.size)
        assertEquals(1, res.credits.size)
        assertEquals(250L, res.accountBalanceCents)
        assertEquals(InvoiceStatus.Open, res.open[0].status)
        assertEquals(InvoiceStatus.Credit, res.credits[0].status)
        assertEquals(2500L, res.credits[0].creditAmountCents)
        assertEquals("pi_xyz", res.credits[0].originalPaymentIntentId)
        assertTrue(res.paid[0].isPaid)
    }

    @Test
    fun `redeemCredit forwards target and decodes refund result`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("redeemCredit", buildJsonObject {
            put("ok", true)
            put("redeemedAmountCents", 5000L)
            put("target", "originalPaymentMethod")
            put("refundId", "re_abc")
        })
        val api = PortalApi(fake)
        val res = api.redeemCredit("inv-c", kinfolkId = "3", target = CreditTarget.OriginalPaymentMethod)
        assertEquals(true, res.ok)
        assertEquals(5000L, res.redeemedAmountCents)
        assertEquals(CreditTarget.OriginalPaymentMethod, res.target)
        assertEquals("re_abc", res.refundId)
    }

    @Test
    fun `redeemCredit accountBalance returns updated balance`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("redeemCredit", buildJsonObject {
            put("ok", true)
            put("redeemedAmountCents", 2500L)
            put("target", "accountBalance")
            put("newAccountBalanceCents", 7500L)
        })
        val api = PortalApi(fake)
        val res = api.redeemCredit("inv-c", target = CreditTarget.AccountBalance)
        assertEquals(CreditTarget.AccountBalance, res.target)
        assertEquals(7500L, res.newAccountBalanceCents)
    }

    @Test
    fun `getMyKin maps active and noLongerWithUs`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject {
                    put("id", "k1")
                    put("name", "Buddy")
                    put("status", "active")
                    put("ageYears", 5.0)
                })
                add(buildJsonObject {
                    put("id", "k2")
                    put("name", "Mr Biggles")
                    put("status", "noLongerWithUs")
                })
            })
        })
        val api = PortalApi(fake)
        val res = api.getMyKin()
        assertEquals(2, res.kin.size)
        assertEquals(KinStatus.Active, res.kin[0].status)
        assertEquals(KinStatus.NoLongerWithUs, res.kin[1].status)
        assertEquals(5.0, res.kin[0].ageYears)
    }

    @Test
    fun `getMyBookings extracts liveVisit when present`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", buildJsonObject {
                put("id", "b1")
                put("kinfolkId", "3")
                put("status", "active")
                put("title", "Walk")
                put("startTimeMs", 1000L)
                put("visitProgress", "active")
            })
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "b2")
                    put("status", "confirmed")
                })
            })
            put("recent", buildJsonArray {})
            put("envelopes", buildJsonArray {
                add(buildJsonObject {
                    put("batchId", "batch-1")
                    put("envelopeStatus", "partiallyConfirmed")
                    put("pattern", "weekly")
                    put("serviceName", "Drop-in Visit")
                    put("visitCount", 2L)
                    put("confirmedCount", 1L)
                    put("completedCount", 0L)
                    put("kinCares", buildJsonArray {
                        add(buildJsonObject {
                            put("id", "kc1")
                            put("status", "confirmed")
                            put("batchId", "batch-1")
                        })
                        add(buildJsonObject {
                            put("id", "kc2")
                            put("status", "requested")
                            put("batchId", "batch-1")
                        })
                    })
                })
            })
        })
        val api = PortalApi(fake)
        val res = api.getMyBookings()
        val live = res.liveVisit
        assertNotNull(live)
        assertEquals(BookingStatus.Active, live.status)
        assertEquals(VisitProgress.Active, live.visitProgress)
        assertEquals(1, res.upcoming.size)
        assertTrue(res.recent.isEmpty())
        // Envelope wire shape decodes alongside the unchanged buckets.
        assertEquals(1, res.envelopes.size)
        val env = res.envelopes[0]
        assertEquals("batch-1", env.batchId)
        assertEquals(EnvelopeStatus.PartiallyConfirmed, env.envelopeStatus)
        assertEquals(2, env.visitCount)
        assertEquals(2, env.kinCares.size)
        assertEquals("kc1", env.kinCares[0].id)
        assertEquals("batch-1", env.kinCares[0].batchId)
    }

    @Test
    fun `payInvoice forwards URL pair to the function`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("payInvoice", buildJsonObject {
            put("checkoutUrl", "https://checkout.stripe.com/abc")
            put("sessionId", "cs_123")
            put("amountCents", 12500L)
            put("currency", "usd")
        })
        val api = PortalApi(fake)
        val res = api.payInvoice(
            invoiceId = "1001",
            kinfolkId = "3",
            successUrl = "https://x/ok",
            cancelUrl = "https://x/cancel",
        )
        assertEquals("cs_123", res.sessionId)
        assertEquals(12500L, res.amountCents)
        assertEquals("https://checkout.stripe.com/abc", res.checkoutUrl)
        val (name, payload) = fake.calls.single()
        assertEquals("payInvoice", name)
        assertNotNull(payload)
    }

    @Test
    fun `getMyKinTales returns empty list when stub omits tales`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject { put("hasMore", false) })
        val api = PortalApi(fake)
        val res = api.getMyKinTales()
        assertTrue(res.tales.isEmpty())
        assertEquals(false, res.hasMore)
    }

    @Test
    fun `addSecondaryContact sends kin_edit and home_access true when the PRIMARY opts in`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("addSecondaryContact", buildJsonObject { put("inviteId", "inv-1") })
        val api = PortalApi(fake)
        val id = api.addSecondaryContact(
            kinfolkId = "3",
            invitedEmail = "partner@example.com",
            secondaryLabel = "Co-Parent",
            kinEdit = true,
            homeAccess = true,
        )
        assertEquals("inv-1", id)
        val (name, payload) = fake.calls.single()
        assertEquals("addSecondaryContact", name)
        assertNotNull(payload)
        assertEquals("partner@example.com", payload["invitedEmail"]?.jsonPrimitive?.content)
        assertEquals("Co-Parent", payload["secondaryLabel"]?.jsonPrimitive?.content)
        val perms = payload["permissions"]?.jsonObject
        assertNotNull(perms)
        // The two invite-time access toggles must reach the permissions payload.
        assertEquals(true, perms["kin_edit"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(true, perms["home_access"]?.jsonPrimitive?.booleanOrNull)
        // Messaging / kintales stay on by default; billing is NEVER exposed as true here.
        assertEquals(false, perms["billing_full"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(true, perms["messaging_direct"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(true, perms["messaging_group"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(true, perms["kintales_only"]?.jsonPrimitive?.booleanOrNull)
    }

    @Test
    fun `addSecondaryContact defaults kin_edit and home_access to false`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("addSecondaryContact", buildJsonObject { put("inviteId", "inv-2") })
        val api = PortalApi(fake)
        api.addSecondaryContact(kinfolkId = "3", invitedEmail = "friend@example.com")
        val perms = fake.calls.single().second?.get("permissions")?.jsonObject
        assertNotNull(perms)
        assertEquals(false, perms["kin_edit"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(false, perms["home_access"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(false, perms["billing_full"]?.jsonPrimitive?.booleanOrNull)
    }

    @Test
    fun `listMembers parses roles status and permission flags incl home_access`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listMembers", buildJsonObject {
            put("members", buildJsonArray {
                add(buildJsonObject {
                    put("uid", "u1")
                    put("role", "PRIMARY")
                    put("status", "ACTIVE")
                    put("secondaryLabel", JsonNull)
                    put("invitedEmail", "owner@example.com")
                    put("permissions", buildJsonObject {
                        put("billing_full", true)
                        put("messaging_direct", true)
                        put("messaging_group", true)
                        put("kin_edit", true)
                        put("kintales_only", true)
                        put("home_access", true)
                    })
                })
                add(buildJsonObject {
                    put("uid", "u2")
                    put("role", "SECONDARY")
                    put("status", "ACTIVE")
                    put("secondaryLabel", "Co-Parent")
                    put("invitedEmail", "partner@example.com")
                    put("permissions", buildJsonObject {
                        put("messaging_direct", true)
                        put("messaging_group", false)
                        put("kin_edit", true)
                        put("home_access", true)
                        // billing_full + kintales_only intentionally absent -> default false
                    })
                })
                add(buildJsonObject {
                    put("uid", "u3")
                    put("role", "SECONDARY")
                    put("status", "INVITED")
                    put("secondaryLabel", "Dog Walker")
                    put("invitedEmail", "walker@example.com")
                    put("permissions", buildJsonObject {
                        put("messaging_direct", false)
                        put("messaging_group", false)
                        put("kin_edit", false)
                        put("home_access", false)
                    })
                })
            })
        })
        val api = PortalApi(fake)
        val members = api.listMembers("3")
        assertEquals(3, members.size)

        val primary = members[0]
        assertEquals("u1", primary.uid)
        assertEquals("PRIMARY", primary.role)
        assertEquals("ACTIVE", primary.status)
        assertNull(primary.secondaryLabel)
        assertEquals("owner@example.com", primary.invitedEmail)
        assertTrue(primary.permissions.billing_full)
        assertTrue(primary.permissions.home_access)

        val sec1 = members[1]
        assertEquals("u2", sec1.uid)
        assertEquals("SECONDARY", sec1.role)
        assertEquals("Co-Parent", sec1.secondaryLabel)
        assertTrue(sec1.permissions.messaging_direct)
        assertEquals(false, sec1.permissions.messaging_group)
        assertTrue(sec1.permissions.kin_edit)
        assertTrue(sec1.permissions.home_access)
        // Absent flags default to false.
        assertEquals(false, sec1.permissions.billing_full)
        assertEquals(false, sec1.permissions.kintales_only)

        val sec2 = members[2]
        assertEquals("INVITED", sec2.status)
        assertEquals(false, sec2.permissions.home_access)
        assertEquals(false, sec2.permissions.kin_edit)

        val (name, payload) = fake.calls.single()
        assertEquals("listMembers", name)
        assertEquals("3", payload?.get("kinfolkId")?.jsonPrimitive?.content)
    }

    /**
     * RULING: "Primary kinfolk is allowed to set the permissions of the
     * secondary, including billing if they want ... besides admin, primary
     * kinfolk can set permissions for the secondary."
     *
     * This used to assert billing_full was NOT sent. It is sent now, and the
     * server's schema accepts it; kintales_only is still withheld everywhere.
     */
    @Test
    fun `updateSecondaryPermissions sends the five writable flags, billing included`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("updateSecondaryPermissions", buildJsonObject { put("ok", true) })
        val api = PortalApi(fake)
        api.updateSecondaryPermissions(
            familyId = "f1",
            targetUid = "u2",
            billingFull = true,
            messagingDirect = true,
            messagingGroup = false,
            kinEdit = true,
            homeAccess = true,
        )
        val (name, payload) = fake.calls.single()
        assertEquals("updateSecondaryPermissions", name)
        assertNotNull(payload)
        assertEquals("f1", payload["familyId"]?.jsonPrimitive?.content)
        assertEquals("u2", payload["targetUid"]?.jsonPrimitive?.content)
        val perms = payload["permissions"]?.jsonObject
        assertNotNull(perms)
        // Every writable flag reaches the payload, including a toggle-OFF (false).
        assertEquals(true, perms["billing_full"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(true, perms["messaging_direct"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(false, perms["messaging_group"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(true, perms["kin_edit"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(true, perms["home_access"]?.jsonPrimitive?.booleanOrNull)
        // kintales_only is a product invariant no surface may turn off.
        assertNull(perms["kintales_only"])
    }
    /** A toggle-OFF must reach the server, or revoking billing would silently no-op. */
    @Test
    fun `updateSecondaryPermissions sends billing_full false when revoked`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("updateSecondaryPermissions", buildJsonObject { put("ok", true) })
        val api = PortalApi(fake)
        api.updateSecondaryPermissions(
            familyId = "f1",
            targetUid = "u2",
            billingFull = false,
            messagingDirect = true,
            messagingGroup = true,
            kinEdit = false,
            homeAccess = false,
        )
        val perms = fake.calls.single().second?.get("permissions")?.jsonObject
        assertNotNull(perms)
        assertEquals(false, perms["billing_full"]?.jsonPrimitive?.booleanOrNull)
    }

    @Test
    fun `getMyAccount handles missing optional fields`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyAccount", buildJsonObject {
            put("uid", "u1")
            put("hasPaymentMethod", false)
        })
        val api = PortalApi(fake)
        val a = api.getMyAccount()
        assertEquals("u1", a.uid)
        assertNull(a.email)
        assertNull(a.phone)
        assertEquals(false, a.hasPaymentMethod)
    }
}
