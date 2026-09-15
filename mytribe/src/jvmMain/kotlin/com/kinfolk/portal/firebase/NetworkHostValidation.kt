package com.kinfolk.portal.firebase

import java.net.InetAddress

/**
 * True only for a host a local Firebase emulator can plausibly run on:
 * loopback (localhost, 127.0.0.0/8, ::1) or a private range (10/8, 172.16/12,
 * 192.168/16, fc00::/7). [host] must be the bare word "localhost" or a literal
 * IP address; a DNS name never resolves here, so this never makes a network
 * call.
 *
 * Shared by [RestEndpoints] (which emulator host env var to trust) and
 * `RestHttp` (which host the `:jvmTest` guard may let a request reach).
 */
internal fun isLoopbackOrPrivateHost(host: String): Boolean {
    val stripped = host.removePrefix("[").removeSuffix("]")
    if (stripped.equals("localhost", ignoreCase = true)) return true
    if (!isLiteralIpAddress(stripped)) return false
    val addr = try {
        InetAddress.getByName(stripped)
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

private val IPV4_LITERAL = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
private val IPV6_LITERAL_CHARS = Regex("^[0-9a-fA-F:.]+$")

/** True for something shaped like a literal IPv4/IPv6 address, never a DNS name. */
private fun isLiteralIpAddress(host: String): Boolean =
    IPV4_LITERAL.matches(host) || (host.contains(':') && IPV6_LITERAL_CHARS.matches(host))
