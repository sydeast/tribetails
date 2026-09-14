package com.kinfolk.portal.firebase

import io.ktor.client.request.get
import io.ktor.client.request.headers
import io.ktor.client.request.patch
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assume.assumeTrue
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #889: proves `FirebaseRestConfig.firestoreBase()` — what `RestFirestoreClient.root`
 * is built from — actually reaches the LOCAL Firestore emulator, not production.
 *
 * Seeds and reads with `Bearer owner`, the Firestore emulator's own admin-bypass
 * credential. That is deliberate and test-only: `Bearer owner` is never valid
 * against production, and `RestFirestoreClient` itself never sends it (see its
 * class doc — it always carries the signed-in kinfolk's real ID token, emulator
 * or not, so `firestore.rules` still gates a read). Proving the URL lands on the
 * emulator does not need a rules-permitted signed-in account; standing one up for
 * this is a separate, heavier concern this test does not take on.
 *
 * Skipped unless FIRESTORE_EMULATOR_HOST is set — the same `assumeTrue` gate
 * `KinfolkMergeEmulatorTest` (auntieos-admin) uses. Run it from mytribe/ with:
 *
 *   firebase emulators:exec --project auntieos-ttpc --only firestore \
 *     './gradlew :jvmTest --no-daemon --rerun --tests "*RestFirestoreEmulatorProofTest"'
 */
class RestFirestoreEmulatorProofTest {

    @BeforeTest
    fun requireEmulator() {
        assumeTrue(
            "FIRESTORE_EMULATOR_HOST is not set; this test only runs against the emulator",
            !System.getenv("FIRESTORE_EMULATOR_HOST").isNullOrBlank(),
        )
    }

    @Test
    fun aDocSeededOnTheEmulatorIsReadBackThroughFirestoreBase(): Unit = runBlocking {
        val id = "ec889-${System.nanoTime()}"
        val url = "${FirebaseRestConfig.firestoreBase()}/889_proof/$id"

        val putRes: HttpResponse = RestHttp.client.patch(url) {
            headers { append(HttpHeaders.Authorization, "Bearer owner") }
            contentType(ContentType.Application.Json)
            setBody("""{"fields":{"marker":{"stringValue":"889-emulator-proof"}}}""")
        }
        check(putRes.status.isSuccess()) { "seed write failed: ${putRes.status.value} ${putRes.bodyAsText()}" }

        val getRes: HttpResponse = RestHttp.client.get(url) {
            headers { append(HttpHeaders.Authorization, "Bearer owner") }
        }
        check(getRes.status.isSuccess()) { "read failed: ${getRes.status.value} ${getRes.bodyAsText()}" }
        val body = RestHttp.json.parseToJsonElement(getRes.bodyAsText()).jsonObject
        val marker = body["fields"]?.jsonObject?.get("marker")?.jsonObject?.get("stringValue")?.jsonPrimitive?.content
        assertEquals("889-emulator-proof", marker)
    }
}
