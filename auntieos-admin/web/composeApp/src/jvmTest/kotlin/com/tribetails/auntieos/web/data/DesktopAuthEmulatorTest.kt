package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #898: the desktop console had no way to point Firebase Auth calls at a local
 * emulator, so testing a callable against the Functions emulator still needed a
 * real production sign-in token. [identityToolkitAccountsBase] and
 * [secureTokenUrl] are the pure URL builders `FirebaseRestAuth` composes its
 * IDENTITY/SECURETOKEN bases from; a trusted `FIREBASE_AUTH_EMULATOR_HOST`
 * switches both, mirroring [JvmFirestoreRest]'s FIRESTORE_EMULATOR_HOST and
 * FUNCTIONS_EMULATOR_HOST switches and the portal's `FirebaseRestConfig`
 * (#889) exactly.
 */
class DesktopAuthEmulatorTest {

    @Test
    fun productionUrlsAreUsedWhenNoEmulatorHostIsSet() {
        assertEquals("https://identitytoolkit.googleapis.com/v1/accounts", identityToolkitAccountsBase(null))
        assertEquals("https://securetoken.googleapis.com/v1/token", secureTokenUrl(null))
    }

    @Test
    fun theEmulatorHostRepointsBothAuthUrls() {
        assertEquals(
            "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts",
            identityToolkitAccountsBase("127.0.0.1:9099"),
        )
        assertEquals(
            "http://127.0.0.1:9099/securetoken.googleapis.com/v1/token",
            secureTokenUrl("127.0.0.1:9099"),
        )
    }

    @Test
    fun anIpv6EmulatorHostIsCarriedThroughUnchanged() {
        assertEquals(
            "http://[::1]:9099/identitytoolkit.googleapis.com/v1/accounts",
            identityToolkitAccountsBase("[::1]:9099"),
        )
        assertEquals("http://[::1]:9099/securetoken.googleapis.com/v1/token", secureTokenUrl("[::1]:9099"))
    }

    /**
     * #898: `trustedEmulatorHost` is the same gate [JvmFirestoreRest] uses for
     * FIRESTORE_EMULATOR_HOST/FUNCTIONS_EMULATOR_HOST. A value that does not
     * name a loopback or private address is refused loudly and treated as
     * unset, so a stale FIREBASE_AUTH_EMULATOR_HOST can never point a
     * production sign-in at some other host.
     */
    @Test
    fun anUntrustedAuthEmulatorHostIsRefusedAndReported() {
        val reports = mutableListOf<String>()
        assertEquals(
            "127.0.0.1:9099",
            trustedEmulatorHost("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099") { reports += it },
        )
        assertTrue(reports.isEmpty(), "$reports")

        assertEquals(
            null,
            trustedEmulatorHost("FIREBASE_AUTH_EMULATOR_HOST", "identitytoolkit.googleapis.com:443") { reports += it },
        )
        assertEquals(1, reports.size)
        assertTrue(
            reports.single().contains("FIREBASE_AUTH_EMULATOR_HOST=identitytoolkit.googleapis.com:443"),
            reports.single(),
        )
    }

    /** #898: the test network guard must allow the Auth emulator host too, or a jvmTest against it would trip NetworkBlockedError. */
    @Test
    fun theGuardAllowsAConfiguredAuthEmulatorHost() {
        val emulators = listOf(null, null, "192.168.1.20:9099")
        assertEquals(null, NetworkGuard.blockReason("192.168.1.20", emulators))
        assertTrue(NetworkGuard.blockReason("identitytoolkit.googleapis.com", emulators) != null)
    }
}
