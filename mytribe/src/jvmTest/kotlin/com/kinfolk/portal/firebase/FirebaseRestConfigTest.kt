package com.kinfolk.portal.firebase

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #889: pins the emulator-vs-production switch for every URL this client
 * builds. Each builder takes its emulator host as a parameter rather than
 * relying on a live `FIREBASE_AUTH_EMULATOR_HOST` / `FUNCTIONS_EMULATOR_HOST`
 * env var, so these run the same whether or not an emulator happens to be
 * exported into this JVM's environment.
 */
class FirebaseRestConfigTest {

    @Test
    fun functionUrlUsesTheFunctionsEmulatorWhenAHostIsGiven() {
        assertEquals(
            "http://127.0.0.1:5001/auntieos-ttpc/us-central1/requestPasswordReset",
            FirebaseRestConfig.functionUrl("requestPasswordReset", emulatorHost = "127.0.0.1:5001"),
        )
        assertEquals(
            "http://127.0.0.1:5001/auntieos-ttpc/us-central1/recordFailedLogin",
            FirebaseRestConfig.functionUrl("recordFailedLogin", emulatorHost = "127.0.0.1:5001"),
        )
    }

    @Test
    fun functionUrlUsesProductionCloudfunctionsNetWhenNoHostIsGiven() {
        assertEquals(
            "https://us-central1-auntieos-ttpc.cloudfunctions.net/requestPasswordReset",
            FirebaseRestConfig.functionUrl("requestPasswordReset", emulatorHost = null),
        )
    }

    @Test
    fun functionUrlHonoursANonDefaultRegionInBothModes() {
        assertEquals(
            "http://localhost:5001/auntieos-ttpc/europe-west1/someFn",
            FirebaseRestConfig.functionUrl("someFn", region = "europe-west1", emulatorHost = "localhost:5001"),
        )
        assertEquals(
            "https://europe-west1-auntieos-ttpc.cloudfunctions.net/someFn",
            FirebaseRestConfig.functionUrl("someFn", region = "europe-west1", emulatorHost = null),
        )
    }

    @Test
    fun identityToolkitBaseUsesTheAuthEmulatorWhenAHostIsGiven() {
        assertEquals(
            "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1",
            FirebaseRestConfig.identityToolkitBase(emulatorHost = "127.0.0.1:9099"),
        )
    }

    @Test
    fun identityToolkitBaseUsesProductionWhenNoHostIsGiven() {
        assertEquals(
            "https://identitytoolkit.googleapis.com/v1",
            FirebaseRestConfig.identityToolkitBase(emulatorHost = null),
        )
    }

    @Test
    fun secureTokenBaseUsesTheAuthEmulatorWhenAHostIsGiven() {
        assertEquals(
            "http://127.0.0.1:9099/securetoken.googleapis.com/v1",
            FirebaseRestConfig.secureTokenBase(emulatorHost = "127.0.0.1:9099"),
        )
    }

    @Test
    fun secureTokenBaseUsesProductionWhenNoHostIsGiven() {
        assertEquals(
            "https://securetoken.googleapis.com/v1",
            FirebaseRestConfig.secureTokenBase(emulatorHost = null),
        )
    }
}
