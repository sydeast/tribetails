package com.tribetails.auntieos.web.data

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.java.Java
import io.ktor.client.network.sockets.ConnectTimeoutException
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.api.Send
import io.ktor.client.plugins.api.createClientPlugin

/**
 * #867: a request the test runtime refused to send.
 *
 * An [Error] and not an [Exception] on purpose. The REST layer turns every
 * `Exception` into a quiet `WriteResult.Err` (`JvmFirestoreRest.callable`,
 * `JvmMediaUpload.upload`, sign-in), and a leak that becomes an Err is a leak
 * nobody sees. The stderr marker written by [NetworkGuard.onBlocked] covers the
 * paths that catch `Throwable` (the polling reads), and Gradle fails the run on it.
 */
class NetworkBlockedError(message: String) : Error(message)

/**
 * #867: in a JVM test, no request may leave the process except to an emulator.
 *
 * Switched on by the `auntieos.test.blockNetwork` system property, which the
 * `jvmTest` task in `composeApp/build.gradle.kts` sets for every test class. The
 * desktop app never sets it. Loopback is always allowed, and so is the host of
 * `FIRESTORE_EMULATOR_HOST` or `FUNCTIONS_EMULATOR_HOST` when one is set.
 */
object NetworkGuard {
    const val PROPERTY = "auntieos.test.blockNetwork"

    /** Written to stderr for every refused request. The jvmTest task fails the run when it sees it. */
    const val MARKER = "[AuntieOS][network-guard] BLOCKED"

    val enabled: Boolean get() = System.getProperty(PROPERTY) == "true"

    /** Where a refused request is reported. A test that trips the guard on purpose swaps this out. */
    @Volatile
    var onBlocked: (String) -> Unit = { System.err.println(it) }

    private fun emulatorHosts(): List<String?> =
        listOf(System.getenv("FIRESTORE_EMULATOR_HOST"), System.getenv("FUNCTIONS_EMULATOR_HOST"))

    /**
     * Pure: why a request to [host] is refused, or null when it may go. [emulatorHosts]
     * are `host:port` values. An emulator host only counts when it is itself a
     * loopback or private address, so a stale variable naming a real host allows nothing.
     */
    fun blockReason(host: String, emulatorHosts: List<String?>): String? {
        val h = host.trim().removePrefix("[").removeSuffix("]").lowercase()
        if (isLoopbackHost(h)) return null
        val allowed = emulatorHosts
            .mapNotNull { it?.trim()?.takeIf { v -> v.isNotEmpty() }?.let(::emulatorHostOf) }
            .filter(::isLoopbackOrPrivateHost)
        if (h in allowed) return null
        return "$host is not loopback or a configured emulator host"
    }

    internal fun check(method: String, url: String, host: String) {
        if (!enabled) return
        val reason = blockReason(host, emulatorHosts()) ?: return
        val line = "$MARKER $method $url ($reason)"
        onBlocked(line)
        throw NetworkBlockedError(line)
    }
}

/** The bare, lower-cased host of an emulator `host:port` value (`[::1]:8080` gives `::1`). */
internal fun emulatorHostOf(hostPort: String): String {
    val v = hostPort.trim()
    val bare = if (v.startsWith("[")) v.substringAfter("[").substringBefore("]") else v.substringBeforeLast(':', v)
    return bare.lowercase()
}

/**
 * Four dotted decimal octets, or null. A literal parse only: nothing here resolves a name.
 * #867 review: ASCII digits only (`Char.isDigit` also takes other scripts' digits), and no
 * leading zero on a multi-digit octet, which some resolvers read as octal (`010` is 8).
 */
private fun ipv4Octets(host: String): List<Int>? {
    val parts = host.split('.')
    if (parts.size != 4) return null
    val octets = parts.map { p ->
        if (p.isEmpty() || p.length > 3 || !p.all { it in '0'..'9' } || (p.length > 1 && p[0] == '0')) return null
        p.toInt()
    }
    return octets.takeIf { o -> o.all { it in 0..255 } }
}

/** `localhost`, 127.0.0.0/8 or `::1`. */
internal fun isLoopbackHost(host: String): Boolean {
    val h = host.trim().removePrefix("[").removeSuffix("]").lowercase()
    if (h == "localhost" || h == "::1" || h == "0:0:0:0:0:0:0:1") return true
    return ipv4Octets(h)?.first() == 127
}

/**
 * #867: loopback, or a literal private IPv4 address (10/8, 172.16/12, 192.168/16).
 * A host name other than `localhost` is refused without a lookup, so a stale
 * emulator variable naming a real host can never be trusted.
 */
internal fun isLoopbackOrPrivateHost(host: String): Boolean {
    if (isLoopbackHost(host)) return true
    val o = ipv4Octets(host.trim().lowercase()) ?: return false
    return o[0] == 10 || (o[0] == 172 && o[1] in 16..31) || (o[0] == 192 && o[1] == 168)
}

/**
 * #867: the value of an emulator variable when it may be used, or null. A value
 * naming anything but a loopback or private address is refused loudly: printed to
 * stderr and reported, and then treated as unset, so the emulator's `owner` token
 * and a signed-in ID token never go to a real host.
 */
internal fun trustedEmulatorHost(variable: String, value: String?, report: (String) -> Unit = ::reportEmulatorRefusal): String? {
    val v = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    if (isLoopbackOrPrivateHost(emulatorHostOf(v))) return v
    report("[AuntieOS][emulator] $variable=$v is not a loopback or private address. Ignoring it and using production.")
    return null
}

private fun reportEmulatorRefusal(line: String) {
    System.err.println(line)
    com.tribetails.auntieos.web.observability.reportMessage(line, fatal = false)
}


/**
 * Runs in the Send pipeline, after every request transform (a `defaultRequest`
 * host included) and before the engine, for every attempt, redirects included.
 * A timeout is not remapped here: Ktor raises the request timeout from outside
 * this pipeline, so the readable message is applied where results are consumed
 * ([transportMessage]).
 */
private val AuntieTransport = createClientPlugin("AuntieTransport") {
    on(Send) { request ->
        NetworkGuard.check(request.method.value, request.url.buildString(), request.url.host)
        proceed(request)
    }
}

internal actual fun auntieHttpClient(
    requestTimeoutMs: Long,
    block: HttpClientConfig<*>.() -> Unit,
): HttpClient = HttpClient(Java) {
    install(AuntieTransport)
    install(HttpTimeout) {
        connectTimeoutMillis = AUNTIE_CONNECT_TIMEOUT_MS
        requestTimeoutMillis = requestTimeoutMs
    }
    block()
}

/**
 * #867: callables whose function declares a longer `timeoutSeconds` than the
 * default request timeout covers. Each value is the function's own ceiling plus
 * a minute for a cold start.
 */
private val LONG_CALLABLE_TIMEOUT_MS = mapOf(
    // mytribe/functions/src/admin/broadcastMessage.ts: timeoutSeconds 540.
    "broadcastMessage" to 600_000L,
)

internal fun callableRequestTimeoutMs(name: String): Long = LONG_CALLABLE_TIMEOUT_MS[name] ?: AUNTIE_REQUEST_TIMEOUT_MS

internal actual fun Throwable.isTransportTimeout(): Boolean =
    this is HttpRequestTimeoutException || this is ConnectTimeoutException ||
        this is java.net.SocketTimeoutException || this is java.net.http.HttpTimeoutException
