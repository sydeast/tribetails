package com.kinfolk.portal.firebase

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #889 review, item 3: RestEndpoints validates each emulator host env var
 * before trusting it, and warns on stderr rather than throwing, both for a
 * rejected host and for a partial (1 or 2 of 3) configuration. The env
 * reader and warn sink are injected here so none of this touches process
 * environment variables or real stderr.
 */
class RestEndpointsTest {

    private fun endpoints(env: Map<String, String>, warnings: MutableList<String> = mutableListOf()): RestEndpoints =
        RestEndpoints(env = { env[it] }, warn = { warnings += it })

    @Test
    fun acceptsALoopbackHost() {
        val e = endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "127.0.0.1:9099"))
        assertEquals("127.0.0.1:9099", e.AUTH_EMULATOR_HOST)
        assertTrue(e.emulatorActive)
    }

    @Test
    fun acceptsTheBareWordLocalhost() {
        val e = endpoints(mapOf("FUNCTIONS_EMULATOR_HOST" to "localhost:5001"))
        assertEquals("localhost:5001", e.FUNCTIONS_EMULATOR_HOST)
    }

    @Test
    fun acceptsAnIpv6LoopbackHost() {
        val e = endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "[::1]:9099"))
        assertEquals("[::1]:9099", e.AUTH_EMULATOR_HOST)
    }

    @Test
    fun acceptsPrivateRangeHosts() {
        for (host in listOf("10.0.0.5:8080", "172.16.0.1:8080", "172.31.255.255:8080", "192.168.1.1:8080")) {
            val e = endpoints(mapOf("FIRESTORE_EMULATOR_HOST" to host))
            assertEquals(host, e.FIRESTORE_EMULATOR_HOST, "$host should be accepted")
        }
    }

    @Test
    fun rejectsHostsJustOutsideThe172PrivateRange() {
        for (host in listOf("172.15.0.1:8080", "172.32.0.1:8080")) {
            val warnings = mutableListOf<String>()
            val e = endpoints(mapOf("FIRESTORE_EMULATOR_HOST" to host), warnings)
            assertNull(e.FIRESTORE_EMULATOR_HOST, "$host should be rejected")
            assertTrue(warnings.any { it.contains("FIRESTORE_EMULATOR_HOST") }, "expected a warning for $host")
        }
    }

    @Test
    fun rejectsAPublicIpAndWarns() {
        val warnings = mutableListOf<String>()
        val e = endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "8.8.8.8:9099"), warnings)
        assertNull(e.AUTH_EMULATOR_HOST)
        assertFalse(e.emulatorActive)
        assertTrue(warnings.any { it.contains("FIREBASE_AUTH_EMULATOR_HOST") && it.contains("8.8.8.8:9099") })
    }

    @Test
    fun rejectsADnsNameEvenIfItSoundsLocal() {
        val warnings = mutableListOf<String>()
        val e = endpoints(mapOf("FUNCTIONS_EMULATOR_HOST" to "emulator.internal.example.com:5001"), warnings)
        assertNull(e.FUNCTIONS_EMULATOR_HOST)
        assertTrue(warnings.isNotEmpty())
    }

    @Test
    fun warnsWhenOnlyOneOfThreeSwitchesIsSet() {
        val warnings = mutableListOf<String>()
        endpoints(mapOf("FIRESTORE_EMULATOR_HOST" to "127.0.0.1:8080"), warnings)
        assertTrue(warnings.any { it.contains("only 1 of 3") })
    }

    @Test
    fun warnsWhenTwoOfThreeSwitchesAreSet() {
        val warnings = mutableListOf<String>()
        endpoints(
            mapOf(
                "FIRESTORE_EMULATOR_HOST" to "127.0.0.1:8080",
                "FUNCTIONS_EMULATOR_HOST" to "127.0.0.1:5001",
            ),
            warnings,
        )
        assertTrue(warnings.any { it.contains("only 2 of 3") })
    }

    @Test
    fun noPartialWarningWhenAllThreeOrNoneAreSet() {
        val allThree = mutableListOf<String>()
        endpoints(
            mapOf(
                "FIREBASE_AUTH_EMULATOR_HOST" to "127.0.0.1:9099",
                "FUNCTIONS_EMULATOR_HOST" to "127.0.0.1:5001",
                "FIRESTORE_EMULATOR_HOST" to "127.0.0.1:8080",
            ),
            allThree,
        )
        assertTrue(allThree.none { it.contains("of 3") })

        val none = mutableListOf<String>()
        endpoints(emptyMap(), none)
        assertTrue(none.none { it.contains("of 3") })
    }

    @Test
    fun gcloudProjectOverrideIsHonoredOnlyWhenEmulatorActiveAndDemoPrefixed() {
        val active = endpoints(
            mapOf("FIRESTORE_EMULATOR_HOST" to "127.0.0.1:8080", "GCLOUD_PROJECT" to "demo-test"),
        )
        assertEquals("demo-test", active.PROJECT_ID)

        val activeRealProject = endpoints(
            mapOf("FIRESTORE_EMULATOR_HOST" to "127.0.0.1:8080", "GCLOUD_PROJECT" to "auntieos-ttpc-staging"),
        )
        assertEquals("auntieos-ttpc", activeRealProject.PROJECT_ID, "a non demo- override must be ignored")

        val inactive = endpoints(mapOf("GCLOUD_PROJECT" to "demo-test"))
        assertEquals("auntieos-ttpc", inactive.PROJECT_ID, "the override is ignored in prod mode")
    }

    @Test
    fun functionsBaseUsesTheOverriddenProjectIdWhenTheEmulatorIsActive() {
        val e = endpoints(
            mapOf("FUNCTIONS_EMULATOR_HOST" to "127.0.0.1:5001", "GCLOUD_PROJECT" to "demo-test"),
        )
        assertEquals("http://127.0.0.1:5001/demo-test/us-central1", e.functionsBase())
    }

    /**
     * #889 review round 3, item 3: the bug. Only FIRESTORE_EMULATOR_HOST was
     * set (no FUNCTIONS_EMULATOR_HOST), plus a demo- override, and
     * functionUrl's PRODUCTION branch (emulatorHost null, since no Functions
     * emulator is configured) still interpolated the overridden project id,
     * turning a real callable URL into https://.../demo-x.cloudfunctions.net/....
     * Every production-routed URL below must carry the real project id
     * regardless of which single switch, if any, is set alongside the
     * override.
     */
    @Test
    fun aGcloudProjectOverrideNeverLeaksIntoAProductionRoutedUrl() {
        val onlyFirestore = endpoints(
            mapOf("FIRESTORE_EMULATOR_HOST" to "127.0.0.1:8080", "GCLOUD_PROJECT" to "demo-x"),
        )
        assertEquals(
            "https://us-central1-auntieos-ttpc.cloudfunctions.net/requestPasswordReset",
            onlyFirestore.functionUrl("requestPasswordReset"),
            "no Functions emulator is configured, so this must stay on the real project",
        )
        assertEquals(
            "https://identitytoolkit.googleapis.com/v1",
            onlyFirestore.identityToolkitBase(),
        )

        val onlyAuth = endpoints(
            mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "127.0.0.1:9099", "GCLOUD_PROJECT" to "demo-x"),
        )
        assertEquals(
            "https://firestore.googleapis.com/v1/projects/auntieos-ttpc/databases/(default)/documents",
            onlyAuth.firestoreBase(),
            "no Firestore emulator is configured, so this must stay on the real project",
        )
        assertEquals(
            "https://us-central1-auntieos-ttpc.cloudfunctions.net/getMyHome",
            onlyAuth.functionUrl("getMyHome"),
        )

        val onlyFunctions = endpoints(
            mapOf("FUNCTIONS_EMULATOR_HOST" to "127.0.0.1:5001", "GCLOUD_PROJECT" to "demo-x"),
        )
        assertEquals(
            "https://firestore.googleapis.com/v1/projects/auntieos-ttpc/databases/(default)/documents",
            onlyFunctions.firestoreBase(),
            "no Firestore emulator is configured, so this must stay on the real project",
        )
        // The one case where the override IS honored: the emulator branch of the switch that is actually set.
        assertEquals(
            "http://127.0.0.1:5001/demo-x/us-central1/getMyHome",
            onlyFunctions.functionUrl("getMyHome"),
        )
    }

    @Test
    fun aRejectedSwitchIsReportedThroughEmulatorConfigRejected() {
        val rejected = endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "8.8.8.8:9099"))
        assertTrue(rejected.emulatorConfigRejected)
        assertFalse(rejected.emulatorActive)

        val accepted = endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "127.0.0.1:9099"))
        assertFalse(accepted.emulatorConfigRejected)

        val unset = endpoints(emptyMap())
        assertFalse(unset.emulatorConfigRejected)
    }

    /** #889 review round 3, item 4: rebuilt from the parsed host:port, so extra URI parts are refused, not carried through. */
    @Test
    fun rejectsAHostWithUserinfoPathQueryOrFragment() {
        val cases = listOf(
            "127.0.0.1#@evil.com",
            "user@127.0.0.1:9099",
            "127.0.0.1:9099/@evil.com",
            "127.0.0.1:9099?x=@evil.com",
            "127.0.0.1:9099#@evil.com",
        )
        for (raw in cases) {
            val warnings = mutableListOf<String>()
            val e = endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to raw), warnings)
            assertNull(e.AUTH_EMULATOR_HOST, "'$raw' must be rejected")
            assertTrue(warnings.isNotEmpty(), "'$raw' should warn")
        }
    }

    @Test
    fun rejectsAHostWithNoPort() {
        val e = endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "127.0.0.1"))
        assertNull(e.AUTH_EMULATOR_HOST, "a port is required")
    }

    @Test
    fun acceptsAPlainHostAndPortWithNothingElse() {
        val e = endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "127.0.0.1:9099"))
        assertEquals("127.0.0.1:9099", e.AUTH_EMULATOR_HOST)
    }

    @Test
    fun rebuildsABracketedIpv6HostAndPortFromTheParsedAuthority() {
        val e = endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "[::1]:9099"))
        assertEquals("[::1]:9099", e.AUTH_EMULATOR_HOST)
    }
}
