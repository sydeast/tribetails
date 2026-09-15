package com.kinfolk.portal.firebase

import java.net.InetAddress
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #889 review, item 3/4: the one classifier RestEndpoints and RestHttp both build on. */
class NetworkHostValidationTest {

    @Test
    fun acceptsLoopback() {
        assertTrue(isLoopbackOrPrivateHost("localhost"))
        assertTrue(isLoopbackOrPrivateHost("LOCALHOST"))
        assertTrue(isLoopbackOrPrivateHost("127.0.0.1"))
        assertTrue(isLoopbackOrPrivateHost("127.5.6.7"))
        assertTrue(isLoopbackOrPrivateHost("::1"))
    }

    @Test
    fun acceptsPrivateIpv4Ranges() {
        assertTrue(isLoopbackOrPrivateHost("10.0.0.1"))
        assertTrue(isLoopbackOrPrivateHost("172.16.0.1"))
        assertTrue(isLoopbackOrPrivateHost("172.31.255.255"))
        assertTrue(isLoopbackOrPrivateHost("192.168.1.1"))
    }

    @Test
    fun rejectsJustOutsideThe172PrivateBlock() {
        assertFalse(isLoopbackOrPrivateHost("172.15.255.255"))
        assertFalse(isLoopbackOrPrivateHost("172.32.0.0"))
    }

    @Test
    fun acceptsIpv6UniqueLocalAddresses() {
        assertTrue(isLoopbackOrPrivateHost("fc00::1"))
        assertTrue(isLoopbackOrPrivateHost("fd12:3456:789a::1"))
    }

    @Test
    fun rejectsPublicAddressesAndDnsNames() {
        assertFalse(isLoopbackOrPrivateHost("8.8.8.8"))
        assertFalse(isLoopbackOrPrivateHost("1.1.1.1"))
        assertFalse(isLoopbackOrPrivateHost("2001:4860:4860::8888"))
        assertFalse(isLoopbackOrPrivateHost("firestore.googleapis.com"))
        assertFalse(isLoopbackOrPrivateHost("guard-bypass.invalid"))
        assertFalse(isLoopbackOrPrivateHost("emulator.internal.example.com"))
    }

    @Test
    fun stripsIpv6Brackets() {
        assertTrue(isLoopbackOrPrivateHost("[::1]"))
        assertTrue(isLoopbackOrPrivateHost("[fc00::1]"))
    }

    @Test
    fun rejectsGarbage() {
        assertFalse(isLoopbackOrPrivateHost(""))
        assertFalse(isLoopbackOrPrivateHost("999.999.999.999"))
        assertFalse(isLoopbackOrPrivateHost("not an address"))
    }

    /**
     * #889 review round 3, item 2: mutation (a) against this classifier was a
     * loosened check (a "contains localhost" or "contains 127." style bug)
     * that no existing test caught. These adversarial shapes pin the exact
     * cases such a bug would let through.
     */
    @Test
    fun rejectsLookalikeHostsThatAreNotActuallyLoopbackOrPrivate() {
        assertFalse(isLoopbackOrPrivateHost("localhost.evil.com"), "a domain that merely starts with localhost")
        assertFalse(isLoopbackOrPrivateHost("a.localhost"), "a subdomain of localhost is not localhost itself")
        assertFalse(isLoopbackOrPrivateHost("127.0.0.1.nip.io"), "a DNS name that embeds a loopback-looking prefix")
        assertFalse(isLoopbackOrPrivateHost("8.127.0.0"), "contains \"127.\" as a substring but is not loopback or private")
        assertFalse(isLoopbackOrPrivateHost("2130706433"), "decimal notation for 127.0.0.1: not our dotted-quad shape")
        assertFalse(isLoopbackOrPrivateHost("127.1"), "short-form IPv4 for 127.0.0.1: not four dotted groups")
        assertFalse(isLoopbackOrPrivateHost("0x7f.1"), "hex notation: not our dotted-quad shape")
        assertFalse(isLoopbackOrPrivateHost("localhost."), "a trailing-dot FQDN is not the bare word localhost")
    }

    /**
     * #889 review round 3, item 1: an IPv4-shaped string with an out-of-range
     * octet used to reach InetAddress.getByName, and the JDK's own literal
     * fast path rejects it (not 0 to 255), so it fell through to a real DNS
     * lookup instead of throwing. The resolver is injected here so this
     * proves the literal-invalid path never calls it at all, not merely
     * that the eventual answer is false (a lookup that later fails would
     * also return false, and would hide exactly this regression).
     */
    @Test
    fun neverCallsTheResolverForOutOfRangeOrMalformedLiterals() {
        var calls = 0
        val countingResolver: (String) -> InetAddress = { calls++; InetAddress.getByName(it) }

        for (bad in listOf("999.1.1.1", "256.0.0.1", "127.0.0.999", "not an address", "")) {
            calls = 0
            assertFalse(isLoopbackOrPrivateHost(bad, countingResolver), bad)
            assertFalse(calls > 0, "resolver should never be called for '$bad', was called $calls time(s)")
        }
    }

    @Test
    fun stillCallsTheResolverForAWellFormedLiteral() {
        var called = false
        val resolver: (String) -> InetAddress = { called = true; InetAddress.getByName(it) }
        assertTrue(isLoopbackOrPrivateHost("127.0.0.1", resolver))
        assertTrue(called, "a well-formed literal should still be resolved to classify loopback/private")
    }
}
