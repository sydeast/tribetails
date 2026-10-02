package com.kinfolk.portal.firebase
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
/**
 * #1110: the Firebase browser key is restricted by HTTP referrer, and a JVM
 * client sends no Referer of its own. Every REST call must carry the portal's
 * origin, so each request type is driven through its real client class and the
 * header is read off the request the mock engine saw. The responses are not the
 * point (some are bare `{}`), so a parse failure after the request left is ignored.
 */
class RestRefererTest {
    private val expected = "https://kinfolk.tribetails.com/"
    private fun clientCapturing(seen: MutableList<Pair<String, String?>>) =
        RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    seen += request.url.toString() to request.headers[HttpHeaders.Referrer]
                    respond(
                        content = """{"fields":{},"result":{"ok":true}}""",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }
    private fun assertEveryRequestCarriesTheReferer(seen: List<Pair<String, String?>>, host: String) {
        val hits = seen.filter { it.first.contains(host) }
        assertEquals(1, hits.size, "expected exactly one request to $host, saw $seen")
        assertEquals(expected, hits.single().second, "Referer on ${hits.single().first}")
    }
    @Test
    fun theConstantIsThePortalsProductionOrigin() {
        assertEquals(expected, FirebaseRestConfig.REFERER)
    }
    @Test
    fun identityToolkitSignInCarriesTheReferer() = runBlocking {
        val seen = mutableListOf<Pair<String, String?>>()
        runCatching { RestAuthClient(clientCapturing(seen), RestEndpoints(env = { null })).signInWithPassword("a@b.com", "pw") }
        assertEveryRequestCarriesTheReferer(seen, "identitytoolkit.googleapis.com/v1/accounts:signInWithPassword")
    }
    @Test
    fun identityToolkitLookupAndUpdateCarryTheReferer() = runBlocking {
        val seen = mutableListOf<Pair<String, String?>>()
        val auth = RestAuthClient(clientCapturing(seen), RestEndpoints(env = { null }))
        runCatching { auth.lookup("tok") }
        runCatching { auth.update("tok", password = "new-password") }
        assertEveryRequestCarriesTheReferer(seen, "accounts:lookup")
        assertEveryRequestCarriesTheReferer(seen, "accounts:update")
    }
    @Test
    fun secureTokenRefreshCarriesTheReferer() = runBlocking {
        val seen = mutableListOf<Pair<String, String?>>()
        runCatching { RestAuthClient(clientCapturing(seen), RestEndpoints(env = { null })).refresh("rt") }
        assertEveryRequestCarriesTheReferer(seen, "securetoken.googleapis.com/v1/token")
    }
    @Test
    fun firestoreRestReadCarriesTheReferer() = runBlocking {
        val seen = mutableListOf<Pair<String, String?>>()
        runCatching { RestFirestoreClient({ "tok" }, clientCapturing(seen), RestEndpoints(env = { null })).getDocument("kinfolk", "abc") }
        assertEveryRequestCarriesTheReferer(seen, "firestore.googleapis.com/v1/projects/auntieos-ttpc/databases/(default)/documents/kinfolk/abc")
    }
    @Test
    fun callableRequestsCarryTheReferer() = runBlocking {
        val seen = mutableListOf<Pair<String, String?>>()
        runCatching { RestFunctionsClient({ "tok" }, clientCapturing(seen), RestEndpoints(env = { null })).call("getMyHome", null) }
        assertEveryRequestCarriesTheReferer(seen, "cloudfunctions.net/getMyHome")
    }
}
