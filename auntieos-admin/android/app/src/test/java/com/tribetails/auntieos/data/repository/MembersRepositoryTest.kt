package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The [MembersRepository] wire contract. (B1)
 *
 * These payloads are HAND-MIRRORED against the server zod Args in
 * `mytribe/functions/src/admin`, so the tests pin the exact key set: a key
 * added or dropped here is contract drift the compiler cannot see. Same
 * reasoning as KinCareRepositoryTest.
 *
 * FirebaseFunctions is fully mocked, so nothing here needs network or Android
 * static init.
 */
class MembersRepositoryTest {

    private fun passingAuthGate(): AuthGate {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        return gate
    }

    private fun repoWith(functions: FirebaseFunctions, authGate: AuthGate = passingAuthGate()) =
        MembersRepository(functionsProvider = { functions }, authGate = authGate)

    private fun callableReturning(
        functions: FirebaseFunctions,
        name: String,
        data: Any?,
        payload: io.mockk.CapturingSlot<Map<String, Any?>>? = null,
    ): HttpsCallableReference {
        val ref = mockk<HttpsCallableReference>()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns data
        if (payload != null) {
            every { ref.call(capture(payload)) } returns Tasks.forResult(result)
        } else {
            every { ref.call(any()) } returns Tasks.forResult(result)
        }
        every { functions.getHttpsCallable(name) } returns ref
        return ref
    }

    // ── listMembers ─────────────────────────────────────────────────────────

    @Test
    fun `HAPPY listMembers sends the kinfolkId and decodes a full member`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = slot<Map<String, Any?>>()
        callableReturning(
            functions, "listMembers",
            mapOf(
                "members" to listOf(
                    mapOf(
                        "uid" to "u1",
                        "secondaryLabel" to "Spouse",
                        "role" to "SECONDARY",
                        "status" to "ACTIVE",
                        "invitedEmail" to "marcus@example.com",
                        "permissions" to mapOf(
                            "billing_full" to true,
                            "messaging_direct" to true,
                            "kintales_only" to true,
                        ),
                    ),
                ),
            ),
            payload,
        )

        val result = repoWith(functions).listMembers("fam1")

        assertTrue(result.isSuccess)
        assertEquals("fam1", payload.captured["kinfolkId"])
        val member = result.getOrThrow().single()
        assertEquals("u1", member.uid)
        assertEquals("marcus@example.com", member.label)
        assertEquals(MembersRepository.MemberRole.SECONDARY, member.role)
        assertEquals(MembersRepository.MemberStatus.ACTIVE, member.status)
        assertTrue(member.permissions.billingFull)
        // Absent flags read false, never null, so the shape is always complete.
        assertFalse(member.permissions.homeAccess)
        assertFalse(member.permissions.kinEdit)
    }

    @Test
    fun `listMembers refuses a blank household id without calling anything`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val result = repoWith(functions).listMembers("  ")
        assertTrue(result.isFailure)
        io.mockk.verify(exactly = 0) { functions.getHttpsCallable(any()) }
    }

    @Test
    fun `UNAUTHORIZED listMembers surfaces permission-denied rather than an empty roster`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns
            Tasks.forException(RuntimeException("permission-denied: Admin claim required."))
        every { functions.getHttpsCallable("listMembers") } returns ref

        val result = repoWith(functions).listMembers("fam1")

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("Admin claim required"))
    }

    @Test
    fun `listMembers fails loud on a non-map payload instead of showing nobody`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        callableReturning(functions, "listMembers", "not a map")
        val result = repoWith(functions).listMembers("fam1")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("non-map payload"))
    }

    // ── listInvites ─────────────────────────────────────────────────────────

    @Test
    fun `HAPPY listInvites sends the familyId and decodes a live invite`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = slot<Map<String, Any?>>()
        callableReturning(
            functions, "listInvites",
            mapOf(
                "invites" to listOf(
                    mapOf(
                        "inviteId" to "rq_8fk29abc",
                        "invitedEmail" to "jane@example.com",
                        "secondaryLabel" to "Sister",
                        "proposedRole" to "SECONDARY",
                        "status" to "EMAIL_SENT",
                        "effectiveStatus" to "EMAIL_SENT",
                        "redeemable" to true,
                        "createdAt" to "2026-05-26T00:00:00.000Z",
                        "expiresAt" to "2026-06-09T00:00:00.000Z",
                    ),
                ),
                "scanned" to 1,
            ),
            payload,
        )

        val result = repoWith(functions).listInvites("fam1")

        assertTrue(result.isSuccess)
        assertEquals("fam1", payload.captured["familyId"])
        val invite = result.getOrThrow().single()
        assertEquals("rq_8fk29abc", invite.inviteId)
        assertEquals(MembersRepository.InviteStatus.EMAIL_SENT, invite.effectiveStatus)
        assertTrue(invite.redeemable)
        assertNull(invite.revokedAt)
    }

    @Test
    fun `THE CASE THAT MATTERS listInvites carries the server's lapsed verdict, not the raw status`() = runBlocking {
        // expireStaleInvites sweeps at 02:00, so Firestore still says EMAIL_SENT
        // while the server has already worked out the invite is dead.
        val functions = mockk<FirebaseFunctions>()
        callableReturning(
            functions, "listInvites",
            mapOf(
                "invites" to listOf(
                    mapOf(
                        "inviteId" to "rq_lapsed",
                        "status" to "EMAIL_SENT",
                        "effectiveStatus" to "EXPIRED",
                        "redeemable" to false,
                    ),
                ),
            ),
        )

        val invite = repoWith(functions).listInvites("fam1").getOrThrow().single()

        assertEquals(MembersRepository.InviteStatus.EMAIL_SENT, invite.status)
        assertEquals(MembersRepository.InviteStatus.EXPIRED, invite.effectiveStatus)
        assertFalse(invite.redeemable)
    }

    @Test
    fun `NEGATIVE an absent redeemable reads NOT redeemable, so Revoke is never offered on a guess`() {
        val invites = decodeInvites(
            mapOf("invites" to listOf(mapOf("inviteId" to "rq_1", "status" to "EMAIL_SENT"))),
        )
        assertFalse(invites.single().redeemable)
        // No effectiveStatus sent: falls back to the raw status, never re-derived
        // on the device.
        assertEquals(MembersRepository.InviteStatus.EMAIL_SENT, invites.single().effectiveStatus)
    }

    @Test
    fun `NEGATIVE a revoked invite decodes REVOKED and keeps its revoked date`() {
        val invite = decodeInvites(
            mapOf(
                "invites" to listOf(
                    mapOf(
                        "inviteId" to "rq_r",
                        "status" to "REVOKED",
                        "effectiveStatus" to "REVOKED",
                        "redeemable" to false,
                        "revokedAt" to "2026-05-19T00:00:00.000Z",
                    ),
                ),
            ),
        ).single()
        assertEquals(MembersRepository.InviteStatus.REVOKED, invite.effectiveStatus)
        assertFalse(invite.redeemable)
        assertEquals("2026-05-19", inviteDate(invite.revokedAt))
    }

    @Test
    fun `rows with no id are dropped, since nothing could revoke them`() {
        val rows = decodeInvites(
            mapOf("invites" to listOf(mapOf("inviteId" to ""), mapOf("inviteId" to "rq_2"), "junk")),
        )
        assertEquals(listOf("rq_2"), rows.map { it.inviteId })
    }

    @Test
    fun `a missing invites array is an error, not an empty list`() {
        val err = runCatching { decodeInvites(mapOf("scanned" to 0)) }.exceptionOrNull()
        assertTrue(err!!.message!!.contains("carried no invites"))
    }

    // ── mintInvite ──────────────────────────────────────────────────────────

    /**
     * RULING (2026-08-04): the admin invites the PRIMARY. The secondary is
     * invited by the household's own primary, from MyTribe, through
     * `addSecondaryContact`.
     *
     * Five cases lived here, four of them passing MemberRole.SECONDARY and a
     * permission set, one asserting the label default. All of them described
     * the admin-side secondary invite the ruling removes, and none of them
     * ever asked what role the call actually minted.
     */
    @Test
    fun `HAPPY mintInvite sends a PRIMARY claim and returns the new id`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = slot<Map<String, Any?>>()
        callableReturning(functions, "mintInvite", mapOf("inviteId" to "rq_new"), payload)

        val result = repoWith(functions).mintInvite(
            familyId = "fam1",
            invitedEmail = "  jane@example.com ",
        )

        assertTrue(result.isSuccess)
        assertEquals("rq_new", result.getOrNull())
        assertEquals("fam1", payload.captured["familyId"])
        assertEquals("jane@example.com", payload.captured["invitedEmail"])
        assertEquals("PRIMARY", payload.captured["proposedRole"])
    }

    @Test
    fun `mintInvite offers no role, label or permission set to send`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = slot<Map<String, Any?>>()
        callableReturning(functions, "mintInvite", mapOf("inviteId" to "rq_new"), payload)

        repoWith(functions).mintInvite("fam1", "jane@example.com")

        // The server writes FULL_PERMISSIONS for a primary claim; a client that
        // sent its own set would be choosing something the role already decides.
        assertEquals(setOf("familyId", "invitedEmail", "proposedRole"), payload.captured.keys)
    }

    @Test
    fun `NEGATIVE mintInvite refuses a blank or malformed email with no round trip`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val repo = repoWith(functions)

        assertTrue(repo.mintInvite("fam1", "  ").isFailure)
        assertTrue(repo.mintInvite("fam1", "jane").isFailure)
        assertTrue(repo.mintInvite("  ", "jane@example.com").isFailure)
        io.mockk.verify(exactly = 0) { functions.getHttpsCallable(any()) }
    }

    @Test
    fun `ERROR mintInvite propagates a send failure instead of reporting an invite`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns Tasks.forException(RuntimeException("SMTP2GO rejected the send"))
        every { functions.getHttpsCallable("mintInvite") } returns ref

        val result = repoWith(functions).mintInvite("fam1", "jane@example.com")

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("SMTP2GO"))
    }

    @Test
    fun `ERROR mintInvite fails when the response carries no inviteId`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        callableReturning(functions, "mintInvite", mapOf("ok" to true))
        val result = repoWith(functions).mintInvite("fam1", "jane@example.com")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("no inviteId"))
    }


    // ── revokeInvite / setMemberPermissions / removeMember ──────────────────

    @Test
    fun `HAPPY revokeInvite sends the invite id`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = slot<Map<String, Any?>>()
        callableReturning(functions, "revokeInvite", mapOf("ok" to true), payload)

        assertTrue(repoWith(functions).revokeInvite("rq_1").isSuccess)
        assertEquals(mapOf("inviteId" to "rq_1"), payload.captured)
    }

    @Test
    fun `ERROR revokeInvite propagates not-found for an invite that is already gone`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns Tasks.forException(RuntimeException("not-found: invite not found"))
        every { functions.getHttpsCallable("revokeInvite") } returns ref

        val result = repoWith(functions).revokeInvite("rq_gone")

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("invite not found"))
    }

    @Test
    fun `HAPPY setMemberPermission sends exactly the one flag that moved`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = slot<Map<String, Any?>>()
        callableReturning(functions, "setMemberPermissions", mapOf("ok" to true), payload)

        val result = repoWith(functions).setMemberPermission(
            "fam1", "u1", MembersRepository.PermissionKey.BILLING_FULL, true,
        )

        assertTrue(result.isSuccess)
        assertEquals("fam1", payload.captured["familyId"])
        assertEquals("u1", payload.captured["targetUid"])
        assertEquals(mapOf("billing_full" to true), payload.captured["permissions"])
    }

    @Test
    fun `NEGATIVE the permission key set carries no kintales_only, which no callable accepts`() {
        val wireNames = MembersRepository.PermissionKey.entries.map { it.wireName }
        assertFalse(wireNames.contains("kintales_only"))
        assertEquals(
            listOf("billing_full", "messaging_direct", "messaging_group", "kin_edit", "home_access").sorted(),
            wireNames.sorted(),
        )
    }

    @Test
    fun `ERROR setMemberPermission propagates permission-denied so the toggle can revert`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns
            Tasks.forException(RuntimeException("permission-denied: Admin claim required."))
        every { functions.getHttpsCallable("setMemberPermissions") } returns ref

        val result = repoWith(functions).setMemberPermission(
            "fam1", "u1", MembersRepository.PermissionKey.BILLING_FULL, true,
        )

        assertTrue(result.isFailure)
    }

    @Test
    fun `HAPPY removeMember sends the household id and target uid`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = slot<Map<String, Any?>>()
        callableReturning(functions, "removeMember", mapOf("ok" to true), payload)

        assertTrue(repoWith(functions).removeMember("fam1", "u1").isSuccess)
        assertEquals(mapOf("familyId" to "fam1", "targetUid" to "u1"), payload.captured)
    }

    @Test
    fun `NEGATIVE removeMember refuses blank ids without a round trip`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val repo = repoWith(functions)
        assertTrue(repo.removeMember("", "u1").isFailure)
        assertTrue(repo.removeMember("fam1", " ").isFailure)
        io.mockk.verify(exactly = 0) { functions.getHttpsCallable(any()) }
    }

    // ── pure decoders ───────────────────────────────────────────────────────

    @Test
    fun `an unknown role or status decodes to the conservative member of its set`() {
        assertEquals(MembersRepository.MemberRole.SECONDARY, decodeRole("WAT"))
        assertEquals(MembersRepository.MemberRole.PRIMARY, decodeRole("PRIMARY"))
        assertEquals(MembersRepository.MemberStatus.INVITED, decodeMemberStatus("WAT"))
        // PENDING keeps the row visible and revocable rather than hiding it.
        assertEquals(MembersRepository.InviteStatus.PENDING, decodeInviteStatus("WAT"))
    }

    @Test
    fun `a member with no uid is dropped, since the UI could not address it`() {
        val rows = decodeMembers(mapOf("members" to listOf(mapOf("uid" to ""), mapOf("uid" to "u2"))))
        assertEquals(listOf("u2"), rows.map { it.uid })
    }

    @Test
    fun `a member label falls back email then label then uid, and is never blank`() {
        val base = MembersRepository.Member(
            uid = "u1", secondaryLabel = null, role = MembersRepository.MemberRole.SECONDARY,
            status = MembersRepository.MemberStatus.ACTIVE,
            permissions = MembersRepository.MemberPermissions(), invitedEmail = null,
        )
        assertEquals("u1", base.label)
        assertEquals("Spouse", base.copy(secondaryLabel = "Spouse").label)
        assertEquals("a@b.com", base.copy(secondaryLabel = "Spouse", invitedEmail = "a@b.com").label)
    }

    @Test
    fun `a date is the ISO day or null, never today`() {
        assertEquals("2026-05-26", inviteDate("2026-05-26T13:45:00.000Z"))
        assertNull(inviteDate(null))
        assertNull(inviteDate("nope"))
    }

    @Test
    fun `SECURITY the invite handle is truncated, because the full id is the claim token`() {
        assertEquals("rq_8fk29…", inviteHandle("rq_8fk29aLONGTAIL"))
        assertEquals("short", inviteHandle("short"))
    }
}
