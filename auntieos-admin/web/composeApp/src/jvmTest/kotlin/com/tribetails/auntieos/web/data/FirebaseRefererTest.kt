package com.tribetails.auntieos.web.data
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.http.HttpHeaders
import kotlinx.coroutines.runBlocking
import java.io.File
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
/**
 * #1110: the Firebase browser key is restricted by HTTP referrer, and a JVM
 * client sends no Referer of its own. Sign-in, token refresh and every Firestore
 * REST verb are built from [auntieHttpClient], so the header is read off the
 * wire at a loopback server for each verb they use.
 */
class FirebaseRefererTest {
    /** Answers [count] requests with an empty 200 and returns each one's request line plus headers. */
    private fun <T> serve(count: Int, block: (port: Int) -> T): Pair<T, List<String>> {
        val seen = mutableListOf<String>()
        ServerSocket(0).use { server ->
            val t = thread(isDaemon = true) {
                repeat(count) {
                    server.accept().use { s ->
                        val reader = s.getInputStream().bufferedReader()
                        val head = StringBuilder()
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty()) break
                            head.appendLine(line)
                        }
                        seen += head.toString()
                        s.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                    }
                }
            }
            val result = block(server.localPort)
            t.join(5_000)
            return result to seen
        }
    }
    private fun refererOf(head: String): List<String> =
        head.lines().filter { it.startsWith("Referer:", ignoreCase = true) }.map { it.substringAfter(':').trim() }
    @Test
    fun theConstantIsTheConsolesProductionOrigin() {
        assertEquals("https://auntie.tribetails.com/", FIREBASE_REFERER)
    }
    @Test
    fun postGetPatchAndDeleteEachCarryTheReferer() {
        val (_, heads) = serve(4) { port ->
            runBlocking {
                val c = auntieHttpClient()
                c.post("http://127.0.0.1:$port/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword")
                c.post("http://127.0.0.1:$port/securetoken.googleapis.com/v1/token")
                c.get("http://127.0.0.1:$port/v1/projects/p/databases/(default)/documents/kinfolk")
                c.patch("http://127.0.0.1:$port/v1/projects/p/databases/(default)/documents/kinfolk/a")
            }
        }
        // serve(4) above covers post, post, get, patch; delete is the fifth verb the REST layer uses.
        assertEquals(4, heads.size)
        heads.forEach { assertEquals(listOf(FIREBASE_REFERER), refererOf(it), it) }
        val (_, deleteHeads) = serve(1) { port ->
            runBlocking { auntieHttpClient().delete("http://127.0.0.1:$port/v1/documents/kinfolk/a") }
        }
        assertEquals(listOf(FIREBASE_REFERER), refererOf(deleteHeads.single()), deleteHeads.single())
    }
    @Test
    fun aCallerSuppliedRefererIsLeftAlone() {
        val (_, heads) = serve(1) { port ->
            runBlocking { auntieHttpClient().get("http://127.0.0.1:$port/x") { header(HttpHeaders.Referrer, "https://example.test/") } }
        }
        assertEquals(listOf("https://example.test/"), refererOf(heads.single()))
    }
    /**
     * The header rides on [auntieHttpClient], so a client built any other way would
     * silently skip it. Every `HttpClient(` construction in this module's jvmMain
     * sources must be that one factory.
     */
    @Test
    fun noJvmClientIsBuiltOutsideTheSharedFactory() {
        val root = File("src/jvmMain/kotlin")
        assertTrue(root.isDirectory, "run from the composeApp module directory: ${root.absolutePath}")
        val offenders = root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" && it.name != "AuntieHttp.jvm.kt" }
            .filter { f -> f.readLines().any { Regex("""\bHttpClient\(""").containsMatchIn(it) && !it.trimStart().startsWith("*") && !it.trimStart().startsWith("//") && !it.contains("`") } }
            .map { it.name }
            .toList()
        assertEquals(emptyList(), offenders, "these build an HttpClient without the Referer: $offenders")
    }
}
