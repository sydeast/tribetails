package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.data.repository.MembersRepository.MemberPermissions
import com.tribetails.auntieos.data.repository.MembersRepository.MemberRole
import com.tribetails.auntieos.data.repository.MembersRepository.MemberStatus
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** #1888: Invite to portal is off until the household's standing is known. */
@OptIn(ExperimentalCoroutinesApi::class)
class PortalInviteStandingTest {
    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    private fun member(role: MemberRole, status: MemberStatus) =
        MembersRepository.Member("u1", null, role, status, MemberPermissions(), null)

    private fun vm(read: suspend (String) -> Result<List<MembersRepository.Member>>): DirectoryViewModel {
        val repository = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepository = mockk<KinCareRepository>(relaxed = true)
        coEvery { repository.getKinfolk() } returns Result.success(emptyList())
        coEvery { repository.getAllKin() } returns Result.success(emptyList())
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())
        return DirectoryViewModel(repository, mockk(relaxed = true), kinCareRepository, read)
    }

    @Test fun `reading until the answer, then an active primary`() = runTest(dispatcher) {
        val answer = CompletableDeferred<Result<List<MembersRepository.Member>>>()
        val model = vm { answer.await() }
        model.loadPortalAccess("k1")
        advanceUntilIdle()
        assertTrue(model.portalPrimaryReading.value)
        assertNull(model.portalPrimaryActive.value)
        answer.complete(Result.success(listOf(member(MemberRole.PRIMARY, MemberStatus.ACTIVE))))
        advanceUntilIdle()
        assertFalse(model.portalPrimaryReading.value)
        assertEquals(true, model.portalPrimaryActive.value)
    }

    @Test fun `an invited primary is not on the portal`() = runTest(dispatcher) {
        val model = vm { Result.success(listOf(member(MemberRole.PRIMARY, MemberStatus.INVITED))) }
        model.loadPortalAccess("k1")
        advanceUntilIdle()
        assertEquals(false, model.portalPrimaryActive.value)
    }

    @Test fun `a failed read leaves the standing unknown`() = runTest(dispatcher) {
        val model = vm { Result.failure(RuntimeException("offline")) }
        model.loadPortalAccess("k1")
        advanceUntilIdle()
        assertFalse(model.portalPrimaryReading.value)
        assertNull(model.portalPrimaryActive.value)
    }

    @Test fun `a late answer about the last household is dropped`() = runTest(dispatcher) {
        val first = CompletableDeferred<Result<List<MembersRepository.Member>>>()
        val model = vm { id ->
            if (id == "k1") first.await() else Result.success(listOf(member(MemberRole.PRIMARY, MemberStatus.INVITED)))
        }
        model.loadPortalAccess("k1")
        advanceUntilIdle()
        model.loadPortalAccess("k2")
        advanceUntilIdle()
        first.complete(Result.success(listOf(member(MemberRole.PRIMARY, MemberStatus.ACTIVE))))
        advanceUntilIdle()
        assertEquals(false, model.portalPrimaryActive.value)
        assertFalse(model.portalPrimaryReading.value)
    }

    @Test fun `the button says where the household stands`() {
        assertEquals("Sending…", portalInviteLabel(true, true))
        assertEquals("Already on the portal", portalInviteLabel(false, true))
        assertEquals("Invite to portal", portalInviteLabel(false, false))
        assertEquals("Invite to portal", portalInviteLabel(false, null))
    }
}
