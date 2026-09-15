package com.kinfolk.portal.firebase

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.HttpClientEngineConfig
import io.ktor.client.engine.HttpClientEngineFactory
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpSend
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.plugin
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
     * #889: true only inside :jvmTest, set by mytribe/build.gradle.kts, which
     * puts -Dkinfolk.portal.testRuntime=true on that one Gradle Test task. A
     * shipped desktop build never sets it, so the guard installed by
     * buildClient is inert in production; it exists so the test runtime
     * cannot silently reach a real Firebase host. Declared before client so
     * client's default guardRequests argument reads a set value.
     */
    private val TEST_RUNTIME: Boolean = System.getProperty("kinfolk.portal.testRuntime") == "true"

    /**
     * #889 review, item 4: a request from :jvmTest may reach loopback or a
     * private-network address, and nothing else. The three emulator env vars
     * are no longer consulted here: FirebaseRestConfig already refuses to
     * honor one that is not loopback/private (see RestEndpoints), so a URL
     * this client ever builds from one of them is already covered by this
     * same check; trusting the env var's raw value a second time here bought
     * nothing and (with the old substringBefore(':') split) broke on an
     * IPv6 host.
     */
    internal fun isAllowedTestHost(host: String): Boolean = isLoopbackOrPrivateHost(host)

    private fun guardRequest(url: Url) {
        check(isAllowedTestHost(url.host)) {
            "RestHttp refused a real network request to '${url.host}' while :jvmTest is " +
                "running (url=$url). Point this call at a loopback or private-network " +
                "emulator host, or give the test a fixture that never reaches RestHttp.client."
        }
    }

    /**
     * Builds a Ktor client with this app's JSON content negotiation and,
     * when [guardRequests] is true, the :jvmTest network guard.
     *
     * #889 review, item 7: installed as an HttpSend interceptor AFTER the
     * client is built (client.plugin(HttpSend).intercept { ... }), not as an
     * onRequest hook on install. HttpRedirect's own interceptor is already on
     * the send pipeline by the time this runs, so ours sits inside it and
     * fires again for every hop a redirect follows, not just the first
     * request. An onRequest-only guard, by contrast, only sees the initial
     * request; a 3xx response to an allowed host could then redirect
     * anywhere and slip past it.
     *
     * Exposed (not just the production [client] below) so a test can build a
     * MockEngine client that carries the exact same guard, or explicitly
     * turns it off for a mock that never touches a network at all.
     */
    fun <T : HttpClientEngineConfig> buildClient(
        engineFactory: HttpClientEngineFactory<T>,
        guardRequests: Boolean = TEST_RUNTIME,
        configure: HttpClientConfig<T>.() -> Unit = {},
    ): HttpClient {
        val built = HttpClient(engineFactory) {
            install(ContentNegotiation) {
                json(this@RestHttp.json)
            }
            expectSuccess = false
            configure()
        }
        if (guardRequests) {
            built.plugin(HttpSend).intercept { request ->
                guardRequest(request.url.build())
                execute(request)
            }
        }
        return built
    }

    val client: HttpClient = buildClient(CIO)
}
