package com.kinfolk.portal.firebase

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
}
