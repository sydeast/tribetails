package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.ActionCodeSettings
import com.google.firebase.auth.FirebaseAuth
import com.tribetails.auntieos.data.api.N8nApi
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #892: an admin reset link opens the project's email action page, which lives on
 * the portal (Identity Toolkit's callbackUri is one URL per project). Without a
 * continue URL the staff member finishes on the kinfolk portal's sign-in. This
 * pins that the Android send passes ActionCodeSettings that bring them back to
 * the admin sign-in.
 *
 * Same topology as [AuntieRepositorySignInAdminTest]: one mockk FirebaseAuth,
 * completed Tasks so `await()` resolves inline on the JVM.
 */
class AuntieRepositoryPasswordResetTest {

    private val auth = mockk<FirebaseAuth>()
    private val repo = AuntieRepository(
        n8n = mockk<N8nApi>(),
        authGate = AuthGate { auth },
        authProvider = { auth },
    )

    @Test
    fun `reset email continues to the admin sign-in`() {
        val settings = slot<ActionCodeSettings>()
        every { auth.sendPasswordResetEmail(any(), capture(settings)) } returns Tasks.forResult(null)

        val result = runBlocking { repo.sendPasswordReset("  ops@tribetails.com ") }

        assertTrue(result.isSuccess)
        verify(exactly = 1) { auth.sendPasswordResetEmail("ops@tribetails.com", any()) }
        assertEquals("https://auntie.tribetails.com/signin", settings.captured.url)
        assertFalse(settings.captured.canHandleCodeInApp())
    }

    @Test
    fun `a blank email never reaches Firebase`() {
        val result = runBlocking { repo.sendPasswordReset("   ") }

        assertTrue(result.isFailure)
        verify(exactly = 0) { auth.sendPasswordResetEmail(any(), any<ActionCodeSettings>()) }
    }
}
