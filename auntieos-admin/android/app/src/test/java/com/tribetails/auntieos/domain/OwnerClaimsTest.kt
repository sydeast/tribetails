package com.tribetails.auntieos.domain

import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GetTokenResult
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.AuthGate
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The owner gate matches the web role rule (`lib/access.ts`): the `admin`
 * claim and not the Auntie role.
 */
class OwnerClaimsTest {

    @Test
    fun `the owner claim alone is the owner`() {
        assertTrue(isOwnerClaims(mapOf("admin" to true)))
    }

    @Test
    fun `an account carrying the Auntie role is not the owner, whatever else it carries`() {
        assertFalse(isOwnerClaims(mapOf("admin" to true, "staffRole" to "auntie")))
        assertFalse(isOwnerClaims(mapOf("staffRole" to "auntie")))
    }

    @Test
    fun `no claim, a non-true admin value, or no token is not the owner`() {
        assertFalse(isOwnerClaims(emptyMap()))
        assertFalse(isOwnerClaims(mapOf("admin" to "true")))
        assertFalse(isOwnerClaims(mapOf("admin" to false)))
        assertFalse(isOwnerClaims(null))
    }

    @Test
    fun `an unknown future role on the owner claim leaves the owner as the owner`() {
        assertTrue(isOwnerClaims(mapOf("admin" to true, "staffRole" to "bookkeeper")))
    }

    private fun repoWithClaims(claims: Map<String, Any?>): AuntieRepository {
        val token = mockk<GetTokenResult>()
        every { token.claims } returns claims
        val user = mockk<FirebaseUser>(relaxed = true)
        every { user.getIdToken(true) } returns Tasks.forResult(token)
        val auth = mockk<FirebaseAuth>(relaxed = true)
        every { auth.currentUser } returns user
        return AuntieRepository(n8n = mockk<N8nApi>(), authGate = AuthGate { auth }, authProvider = { auth })
    }

    @Test
    fun `AdminGate's check admits the owner and refuses an account holding both claims`() = runBlocking {
        assertEquals(true, repoWithClaims(mapOf("admin" to true)).isCurrentUserAdmin().getOrNull())
        assertEquals(
            false,
            repoWithClaims(mapOf("admin" to true, "staffRole" to "auntie")).isCurrentUserAdmin().getOrNull(),
        )
        assertEquals(false, repoWithClaims(mapOf("staffRole" to "auntie")).isCurrentUserAdmin().getOrNull())
    }
}
