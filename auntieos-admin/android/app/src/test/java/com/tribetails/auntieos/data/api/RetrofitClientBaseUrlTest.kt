package com.tribetails.auntieos.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the Settings "Save" crash. `SettingsViewModel.saveBaseUrl` used to
 * store and apply `url.trimEnd('/')`, and Retrofit's `baseUrl(String)` throws
 * IllegalArgumentException("baseUrl must end in /") inside a bare
 * `viewModelScope.launch`, which reaches the uncaught handler and kills the app.
 *
 * MEASURED BOUNDARY, not assumed. Retrofit delegates to OkHttp `HttpUrl`, which
 * normalizes a bare host to path "/", so `trimEnd('/')` on a bare host survives:
 *   "https://example.com"      -> accepted (HttpUrl gives it path "/")
 *   "https://example.com/api"  -> THROWS "baseUrl must end in /"
 * So the crash needed a URL with a path segment, and the shipped
 * DEFAULT_BASE_URL (a bare host) never tripped it. The live-crash claim
 * "every Save, whatever you type" is wrong; the path case is the real one.
 *
 * [buildN8n accepts a path URL with no trailing slash] is the load-bearing
 * regression test: it fails against the old `trimEnd('/')` line. The bare-host
 * case is kept as a boundary marker, and is explicitly NOT proof of the fix.
 */
class RetrofitClientBaseUrlTest {

    @Test
    fun `normalizeBaseUrl appends the slash Retrofit requires`() {
        assertEquals(
            "https://example.com/",
            RetrofitClient.normalizeBaseUrl("https://example.com")
        )
    }

    @Test
    fun `normalizeBaseUrl leaves an already-correct URL alone`() {
        assertEquals(
            "https://example.com/",
            RetrofitClient.normalizeBaseUrl("https://example.com/")
        )
    }

    @Test
    fun `normalizeBaseUrl collapses repeated trailing slashes`() {
        assertEquals(
            "https://example.com/",
            RetrofitClient.normalizeBaseUrl("https://example.com///")
        )
    }

    @Test
    fun `normalizeBaseUrl preserves a path segment`() {
        assertEquals(
            "https://example.com/api/",
            RetrofitClient.normalizeBaseUrl("https://example.com/api")
        )
    }

    @Test
    fun `normalizeBaseUrl trims surrounding whitespace`() {
        // A pasted URL commonly carries a trailing newline or space.
        assertEquals(
            "https://example.com/",
            RetrofitClient.normalizeBaseUrl("  https://example.com  ")
        )
    }

    @Test
    fun `normalizeBaseUrl falls back to the default when blank`() {
        assertEquals(RetrofitClient.DEFAULT_BASE_URL, RetrofitClient.normalizeBaseUrl(""))
        assertEquals(RetrofitClient.DEFAULT_BASE_URL, RetrofitClient.normalizeBaseUrl("   "))
    }

    @Test
    fun `normalizeBaseUrl output always ends in a slash`() {
        val inputs = listOf(
            "https://example.com",
            "https://example.com/",
            "https://example.com//",
            "https://example.com/deep/path",
            " https://example.com ",
            "",
        )
        for (input in inputs) {
            assertTrue(
                "normalizeBaseUrl(\"$input\") must end in '/'",
                RetrofitClient.normalizeBaseUrl(input).endsWith("/")
            )
        }
    }

    @Test
    fun `buildN8n accepts a path URL with no trailing slash`() {
        // THE regression test. Against the old `trimEnd('/')` line this throws
        // IllegalArgumentException: baseUrl must end in /: https://example.com/api
        RetrofitClient.buildN8n("https://example.com/api")
    }

    @Test
    fun `buildN8n accepts a bare host with no trailing slash`() {
        // Boundary marker, NOT proof of the fix: OkHttp HttpUrl normalizes a bare
        // host to path "/", so this shape passed even before the normalizer.
        RetrofitClient.buildN8n("https://example.com")
    }

    @Test
    fun `buildN8n accepts the stored default`() {
        RetrofitClient.buildN8n(RetrofitClient.DEFAULT_BASE_URL)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `buildN8n still rejects a URL with no scheme`() {
        // Deliberately NOT repaired by the normalizer: guessing http vs https for
        // the operator would be a silent wrong answer. SettingsViewModel catches
        // this and surfaces it in baseUrlError instead of crashing.
        RetrofitClient.buildN8n("example.com")
    }
}
