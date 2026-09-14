package com.kinfolk.portal.firebase

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.Url
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

internal object RestHttp {
    val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    /**
     * #889: true only inside `:jvmTest` — set by `mytribe/build.gradle.kts`,
     * which puts `-Dkinfolk.portal.testRuntime=true` on that one Gradle Test
     * task. A shipped desktop build never sets it, so [guardRequest] below is
     * inert in production; it exists so the test runtime cannot silently
     * reach a real Firebase host. Declared before [client]: object
     * properties initialize in source order, and the plugin installed into
     * `client` below reads this value.
     */
    private val TEST_RUNTIME: Boolean = System.getProperty("kinfolk.portal.testRuntime") == "true"

    /** The host segment of an emulator env var's "host:port" value, or null if unset. */
    private fun emulatorHostOf(envVar: String): String? =
        System.getenv(envVar)?.takeIf { it.isNotBlank() }?.substringBefore(':')

    /**
     * Hosts a request from `:jvmTest` may reach: loopback, plus whatever the
     * three Firebase emulator switches this client honors are pointed at.
     * "Non-emulator" means "not one of these", not merely "not loopback" — a
     * misconfigured `FIREBASE_AUTH_EMULATOR_HOST` pointed somewhere unexpected
     * still has to be a host this allowlist recognizes.
     */
    private fun allowedTestHosts(): Set<String> =
        setOfNotNull(
            "localhost", "127.0.0.1", "0.0.0.0", "::1",
            emulatorHostOf("FIREBASE_AUTH_EMULATOR_HOST"),
            emulatorHostOf("FUNCTIONS_EMULATOR_HOST"),
            emulatorHostOf("FIRESTORE_EMULATOR_HOST"),
        )

    /** Exposed for [RestHttpGuardTest]: pure, no client/network involved. */
    internal fun isAllowedTestHost(host: String): Boolean = host in allowedTestHosts()

    private fun guardRequest(url: Url) {
        if (!TEST_RUNTIME) return
        check(isAllowedTestHost(url.host)) {
            "RestHttp refused a real network request to '${url.host}' while :jvmTest is " +
                "running (url=$url). Point this call at an emulator via " +
                "FIREBASE_AUTH_EMULATOR_HOST / FUNCTIONS_EMULATOR_HOST / " +
                "FIRESTORE_EMULATOR_HOST, or give the test a fixture that never reaches " +
                "RestHttp.client."
        }
    }

    val client: HttpClient = HttpClient(CIO) {
        install(ContentNegotiation) {
            json(this@RestHttp.json)
        }
        expectSuccess = false
        install(
            createClientPlugin("Rest889TestNetworkGuard") {
                onRequest { request, _ -> guardRequest(request.url.build()) }
            }
        )
    }
}
