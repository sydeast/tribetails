package com.kinfolk.portal.firebase

import java.net.InetAddress

/**
 * True only for a host a local Firebase emulator can plausibly run on:
 * loopback (localhost, 127.0.0.0/8, ::1) or a private range (10/8, 172.16/12,
 * 192.168/16, fc00::/7). [host] must be the bare word "localhost" or a
 * literal IP address; a DNS name never resolves here, and neither does an
 * IPv4-shaped string with an out-of-range octet.
 *
 * #889 review round 3, item 1: [resolve] used to always be
 * InetAddress::getByName called on the raw literal, and that literal check
 * (see [ipv4LiteralOrNull]/[ipv6LiteralOrNull]) accepted an out-of-range
 * octet like "999.1.1.1". A string in that shape does not match the JDK's
 * OWN internal IPv4-literal fast path, so getByName fell through to a real
 * DNS lookup instead of throwing, which is slow (50 to 60ms) and, in a test,
 * a real network call this whole check exists to avoid. Every octet is now
 * validated as 0 to 255 before [resolve] is ever called, and an IPv6
 * candidate is passed bracketed ("[$host]"), the unambiguous literal syntax,
 * so malformed input throws immediately instead of falling through to DNS.
 *
 * [resolve] defaults to real resolution but is a parameter so a test can
 * assert the literal-invalid path never calls it at all.
 *
 * Shared by [RestEndpoints] (which emulator host env var to trust) and
 * `RestHttp` (which host the `:jvmTest` guard may let a request reach).
 */
internal fun isLoopbackOrPrivateHost(
    host: String,
    resolve: (String) -> InetAddress = InetAddress::getByName,
): Boolean {
    val stripped = host.removePrefix("[").removeSuffix("]")
    if (stripped.equals("localhost", ignoreCase = true)) return true
    val literalForm = ipv4LiteralOrNull(stripped) ?: ipv6LiteralOrNull(stripped) ?: return false
    val addr = try {
        resolve(literalForm)
    } catch (_: Exception) {
        return false
    }
    if (addr.isLoopbackAddress) return true
    val bytes = addr.address
    return when (bytes.size) {
        4 -> addr.isSiteLocalAddress // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
        16 -> (bytes[0].toInt() and 0xFE) == 0xFC // fc00::/7, unique local address
        else -> false
    }
}

private val IPV4_SHAPE = Regex("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$")
private val IPV6_SHAPE = Regex("^[0-9a-fA-F:.]+$")

/**
 * [host] passed back unchanged if it is a dotted-quad with every octet 0 to
 * 255, else null. Deliberately strict: no short forms ("127.1"), no decimal
 * or hex forms ("2130706433", "0x7f.1"), exactly four dot-separated groups.
 */
private fun ipv4LiteralOrNull(host: String): String? {
    if (!IPV4_SHAPE.matches(host)) return null
    val inRange = host.split('.').all { part -> (part.toIntOrNull() ?: return null) in 0..255 }
    return if (inRange) host else null
}

/**
 * A host shaped like an IPv6 address (hex digits, colons, optionally an
 * embedded IPv4 tail), returned bracketed for [resolve]. Bracket syntax is
 * unambiguous IPv6-literal syntax to the JDK, so a malformed candidate
 * throws instead of being retried as a DNS name.
 */
private fun ipv6LiteralOrNull(host: String): String? =
    if (host.contains(':') && IPV6_SHAPE.matches(host)) "[$host]" else null
