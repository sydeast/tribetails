package com.tribetails.auntieos.ui.members

import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.data.repository.decodeAllInvites
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * [InvitesViewModel] and its pure filter/group helpers, the Android mirror of
 * `auntieos-admin/src/screens/Invites.tsx`.
 *
 * The behaviours worth pinning are the honest ones: an unreadable list must
 * never render as an empty one, "outstanding" must mean what the operator's
 * question means, and a lapsed invite must be filed by its EFFECTIVE status
 * rather than the stale one Firestore still holds.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InvitesViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: MembersRepository

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
    }

    @After fun tearDown() = Dispatchers.resetMain()

    private fun invite(
        id: String = "rq_1",
        household: String = "the Demos",
        tribeId: String = "f1",
        status: MembersRepository.InviteStatus = MembersRepository.InviteStatus.PENDING,
        effective: MembersRepository.InviteStatus = status,
    ) = MembersRepository.AdminInvite(
        invite = MembersRepository.Invite(
            inviteId = id,
            invitedEmail = "jane@example.com",
            secondaryLabel = null,
            proposedRole = MembersRepository.MemberRole.PRIMARY,
            status = status,
            effectiveStatus = effective,
            redeemable = effective == MembersRepository.InviteStatus.PENDING ||
                effective == MembersRepository.InviteStatus.EMAIL_SENT,
            createdAt = "2026-08-01T00:00:00.000Z",
            sentToInviteeAt = "2026-08-01T00:01:00.000Z",
            expiresAt = "2026-08-15T00:00:00.000Z",
            revokedAt = null,
        ),
        tribeId = tribeId,
        householdName = household,
    )

    // ── load ────────────────────────────────────────────────────────────────

    @Test
    fun `HAPPY load fills the list and defaults the filter to outstanding`() = runTest {
        coEvery { repo.listAllInvites() } returns Result.success(
            listOf(
                invite(id = "i1", household = "the Demos"),
                invite(id = "i2", household = "the Sparrows", status = MembersRepository.InviteStatus.ACCEPTED),
            ),
        )

        val vm = InvitesViewModel(repository = repo)
        vm.load()

        val state = vm.uiState.value
        assertEquals(InviteFilter.OUTSTANDING, state.filter)
        assertTrue(state.loaded)
        assertNull(state.error)
        assertEquals(listOf("i1"), state.visible.map { it.invite.inviteId })
        assertEquals(2, state.all.size)
    }

    /**
     * FAIL LOUD. "Nobody has been invited" and "we could not find out" are
     * opposite facts, and only one is good news. `loaded` is what earns the
     * empty state, so a failed read can never draw it.
     */
    @Test
    fun `SAD a failed read reports the callable and never earns the empty state`() = runTest {
        coEvery { repo.listAllInvites() } returns Result.failure(Exception("permission-denied"))

        val vm = InvitesViewModel(repository = repo)
        vm.load()

        val state = vm.uiState.value
        assertFalse(state.loaded)
        assertNotNull(state.error)
        assertTrue(state.error!!.contains("listAllInvites failed"))
        assertTrue(state.error!!.contains("permission-denied"))
        assertTrue(state.all.isEmpty())
    }

    @Test
    fun `SAD a failed RELOAD does not demote a list that was already read`() = runTest {
        coEvery { repo.listAllInvites() } returns Result.success(listOf(invite()))
        val vm = InvitesViewModel(repository = repo)
        vm.load()

        coEvery { repo.listAllInvites() } returns Result.failure(Exception("backend unavailable"))
        vm.load()

        val state = vm.uiState.value
        assertTrue(state.loaded)
        assertEquals(1, state.all.size)
        assertNotNull(state.error)
    }

    @Test
    fun `changing the filter re-slices the same rows without a second read`() = runTest {
        coEvery { repo.listAllInvites() } returns Result.success(
            listOf(
                invite(id = "i1"),
                invite(id = "i2", status = MembersRepository.InviteStatus.ACCEPTED),
            ),
        )
        val vm = InvitesViewModel(repository = repo)
        vm.load()

        vm.setFilter(InviteFilter.ACCEPTED)

        assertEquals(listOf("i2"), vm.uiState.value.visible.map { it.invite.inviteId })
        io.mockk.coVerify(exactly = 1) { repo.listAllInvites() }
    }

    @Test
    fun `counts every filter off the loaded rows, so a chip never claims a number nobody read`() = runTest {
        coEvery { repo.listAllInvites() } returns Result.failure(Exception("nope"))
        val vm = InvitesViewModel(repository = repo)
        vm.load()

        assertEquals(0, vm.uiState.value.countFor(InviteFilter.OUTSTANDING))
        assertEquals(0, vm.uiState.value.countFor(InviteFilter.ALL))
    }

    // ── pure helpers ────────────────────────────────────────────────────────

    /**
     * "Outstanding" answers "who never accepted". An EXPIRED invite belongs
     * there; a REVOKED one does not, because revocation was a decision already
     * taken about it.
     */
    @Test
    fun `outstanding is pending, sent and expired, and never revoked`() {
        val rows = listOf(
            invite(id = "p", status = MembersRepository.InviteStatus.PENDING),
            invite(id = "s", status = MembersRepository.InviteStatus.EMAIL_SENT),
            invite(id = "x", status = MembersRepository.InviteStatus.EXPIRED),
            invite(id = "a", status = MembersRepository.InviteStatus.ACCEPTED),
            invite(id = "r", status = MembersRepository.InviteStatus.REVOKED),
        )
        assertEquals(listOf("p", "s", "x"), filterInvites(rows, InviteFilter.OUTSTANDING).map { it.invite.inviteId })
        assertEquals(listOf("a"), filterInvites(rows, InviteFilter.ACCEPTED).map { it.invite.inviteId })
        assertEquals(listOf("r"), filterInvites(rows, InviteFilter.REVOKED).map { it.invite.inviteId })
        assertEquals(5, filterInvites(rows, InviteFilter.ALL).size)
    }

    /**
     * `expireStaleInvites` sweeps at 02:00, so a lapsed invite still READS as
     * EMAIL_SENT for up to a day. Filing it under Pending would send the
     * operator chasing something that is already over.
     */
    @Test
    fun `a lapsed invite is filed by its effective status, not its stored one`() {
        val lapsed = invite(
            id = "l",
            status = MembersRepository.InviteStatus.EMAIL_SENT,
            effective = MembersRepository.InviteStatus.EXPIRED,
        )
        assertEquals(listOf("l"), filterInvites(listOf(lapsed), InviteFilter.OUTSTANDING).map { it.invite.inviteId })
        assertEquals(
            "Expired",
            groupInvitesByStatus(listOf(lapsed)).first { it.rows.isNotEmpty() }.heading,
        )
    }

    /** The mock's order, which is also the order HouseholdMembers stacks them. */
    @Test
    fun `sections come back in the mock order, empty ones included`() {
        assertEquals(
            listOf("Pending", "Accepted", "Expired", "Revoked"),
            groupInvitesByStatus(emptyList()).map { it.heading },
        )
        assertEquals(
            listOf("status: PENDING / EMAIL_SENT", "status: ACCEPTED", "status: EXPIRED", "status: REVOKED"),
            groupInvitesByStatus(emptyList()).map { it.statusNote },
        )
    }

    // ── the row's words ─────────────────────────────────────────────────────

    /**
     * The mock's provenance line: sent (or created), then the one date that
     * matters for the row's state. Only dates the server returned; a missing
     * one reads "unknown", never today. Mirrors `inviteDateParts` on web.
     */
    @Test
    fun `the date words name the date that matters for the state, and no other`() {
        fun withStatus(status: MembersRepository.InviteStatus) = invite(status = status).invite.copy(
            sentToInviteeAt = "2026-05-26T00:00:00.000Z",
            expiresAt = "2026-06-09T00:00:00.000Z",
            revokedAt = "2026-05-19T00:00:00.000Z",
        )
        assertEquals(
            listOf("Sent 2026-05-26", "expires 2026-06-09"),
            adminInviteDateParts(withStatus(MembersRepository.InviteStatus.EMAIL_SENT)),
        )
        assertEquals(
            listOf("Sent 2026-05-26", "expired 2026-06-09"),
            adminInviteDateParts(withStatus(MembersRepository.InviteStatus.EXPIRED)),
        )
        assertEquals(
            listOf("Sent 2026-05-26", "revoked 2026-05-19"),
            adminInviteDateParts(withStatus(MembersRepository.InviteStatus.REVOKED)),
        )
        // No acceptance timestamp comes back from the server, so nothing is
        // shown for one: an expiry on an accepted invite is a date nobody acts on.
        assertEquals(
            listOf("Sent 2026-05-26"),
            adminInviteDateParts(withStatus(MembersRepository.InviteStatus.ACCEPTED)),
        )
    }

    @Test
    fun `the date words fall back to created, and say unknown when the server had nothing`() {
        val neverSent = invite().invite.copy(sentToInviteeAt = null, expiresAt = null)
        assertEquals(listOf("Created 2026-08-01", "expires unknown"), adminInviteDateParts(neverSent))
        val revokedUndated = invite(status = MembersRepository.InviteStatus.REVOKED).invite.copy(revokedAt = null)
        assertEquals(listOf("Sent 2026-08-01", "revoked unknown"), adminInviteDateParts(revokedUndated))
    }

    /** The full id is the claim token: the line carries the handle and never a URL. */
    @Test
    fun `the meta line ends with the truncated handle and never the household`() {
        val line = adminInviteMetaLine(invite(id = "rq_8fk29aLONGTAIL", household = "the Demos"))
        assertEquals("Sent 2026-08-01 · expires 2026-08-15 · inviteId rq_8fk29…", line)
        assertFalse(line.contains("rq_8fk29aLONGTAIL"))
        assertFalse(line.contains("?invite="))
        assertFalse(line.contains("the Demos"))
    }

    /** The mock's own tints, not the shared Members-screen ones. */
    @Test
    fun `each status takes the tint the mock draws`() {
        assertEquals(AuntieStatusTone.Orange, invitePillTone(MembersRepository.InviteStatus.PENDING))
        assertEquals(AuntieStatusTone.Orange, invitePillTone(MembersRepository.InviteStatus.EMAIL_SENT))
        assertEquals(AuntieStatusTone.Teal, invitePillTone(MembersRepository.InviteStatus.ACCEPTED))
        assertEquals(AuntieStatusTone.Error, invitePillTone(MembersRepository.InviteStatus.REVOKED))
        assertEquals(AuntieStatusTone.Muted, invitePillTone(MembersRepository.InviteStatus.EXPIRED))
        assertEquals("Primary", roleLabel(MembersRepository.MemberRole.PRIMARY))
        assertEquals("Secondary", roleLabel(MembersRepository.MemberRole.SECONDARY))
    }

    // ── decoder ─────────────────────────────────────────────────────────────

    @Test
    fun `HAPPY decodeAllInvites carries the household name and id onto every row`() {
        val rows = decodeAllInvites(
            mapOf(
                "invites" to listOf(
                    mapOf(
                        "inviteId" to "rq_1",
                        "tribeId" to "f1",
                        "householdName" to "the Demos",
                        "status" to "PENDING",
                        "effectiveStatus" to "PENDING",
                        "redeemable" to true,
                    ),
                ),
            ),
        )
        val row = rows.single()
        assertEquals("f1", row.tribeId)
        assertEquals("the Demos", row.householdName)
        assertEquals("rq_1", row.invite.inviteId)
        assertTrue(row.invite.redeemable)
    }

    /**
     * An older APK meeting a newer server, or the reverse: a row with no name
     * says what is missing rather than drawing a card with a blank heading,
     * which would read as "no household".
     */
    @Test
    fun `NEGATIVE a nameless row says so rather than rendering blank`() {
        val row = decodeAllInvites(
            mapOf("invites" to listOf(mapOf("inviteId" to "rq_1", "tribeId" to "f1"))),
        ).single()
        assertEquals("(household name missing: f1)", row.householdName)
    }

    @Test
    fun `NEGATIVE rows with no invite id are dropped, since nothing could act on them`() {
        val rows = decodeAllInvites(
            mapOf("invites" to listOf(mapOf("inviteId" to ""), mapOf("inviteId" to "rq_2"), "junk")),
        )
        assertEquals(listOf("rq_2"), rows.map { it.invite.inviteId })
    }

    @Test
    fun `a missing invites array is an error, not an empty list`() {
        val err = runCatching { decodeAllInvites(mapOf("scanned" to 0)) }.exceptionOrNull()
        assertTrue(err!!.message!!.contains("carried no invites"))
    }
}
