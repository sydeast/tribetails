package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure half of the Integrations panel: how a server verdict becomes words on
 * a row. No Firebase, no Compose.
 *
 * The two rules worth pinning, because both are ways a panel lies quietly:
 *
 *  - an unrecognised status decodes to UNKNOWN, so an older APK meeting a newer
 *    server says "we cannot tell" on one row instead of inventing a verdict for
 *    it or losing the other six;
 *  - the "no deployed function declares this" warning is withheld when the
 *    server could not read the declared set, because a false `declared` there is
 *    an artefact of the failed read and printing it would send the operator to
 *    edit a function that was already correct.
 */
class IntegrationsHealthMappingTest {

    private fun secret(
        name: String = "STRIPE_SECRET_KEY",
        required: Boolean = true,
        declared: Boolean = true,
        resolves: Boolean = true,
        length: Int = 41,
    ) = IntegrationSecretState(
        name = name,
        required = required,
        purpose = "Creates the payment intent.",
        declared = declared,
        resolves = resolves,
        length = length,
    )

    // ── status decode ────────────────────────────────────────────────────────

    @Test
    fun `each server status decodes to its own value`() {
        assertEquals(IntegrationStatus.WORKING, IntegrationStatus.from("working"))
        assertEquals(IntegrationStatus.CONFIGURED, IntegrationStatus.from("configured"))
        assertEquals(IntegrationStatus.MISSING, IntegrationStatus.from("missing"))
        assertEquals(IntegrationStatus.UNKNOWN, IntegrationStatus.from("unknown"))
    }

    @Test
    fun `an unrecognised status is UNKNOWN, never quietly WORKING`() {
        assertEquals(IntegrationStatus.UNKNOWN, IntegrationStatus.from("degraded"))
        assertEquals(IntegrationStatus.UNKNOWN, IntegrationStatus.from(null))
        assertEquals(IntegrationStatus.UNKNOWN, IntegrationStatus.from(""))
    }

    // ── pill words ───────────────────────────────────────────────────────────

    @Test
    fun `pill words match the React admin word for word`() {
        assertEquals("Working", integrationStatusLabel(IntegrationStatus.WORKING))
        assertEquals("Set up, not verified", integrationStatusLabel(IntegrationStatus.CONFIGURED))
        assertEquals("Missing", integrationStatusLabel(IntegrationStatus.MISSING))
        assertEquals("Could not check", integrationStatusLabel(IntegrationStatus.UNKNOWN))
    }

    @Test
    fun `a check that could not be made never reads as one that passed`() {
        assertFalse(
            integrationStatusLabel(IntegrationStatus.UNKNOWN)
                .equals(integrationStatusLabel(IntegrationStatus.WORKING), ignoreCase = true),
        )
    }

    // ── secret lines ─────────────────────────────────────────────────────────

    @Test
    fun `a set secret reports its length and never its value`() {
        val line = integrationSecretLine(secret(), declaredKnown = true)
        assertEquals("STRIPE_SECRET_KEY · set, 41 characters", line)
    }

    @Test
    fun `an unset secret says so plainly`() {
        val line = integrationSecretLine(secret(resolves = false, length = 0), declaredKnown = true)
        assertTrue(line.contains("not set"))
    }

    @Test
    fun `an undeclared secret is flagged when the server did look`() {
        val line = integrationSecretLine(secret(declared = false), declaredKnown = true)
        assertTrue(line.contains("no deployed function declares this"))
    }

    @Test
    fun `the undeclared flag is withheld when the server could not look`() {
        val line = integrationSecretLine(secret(declared = false), declaredKnown = false)
        assertFalse(line.contains("no deployed function declares this"))
    }

    @Test
    fun `an optional secret is marked optional`() {
        assertTrue(integrationSecretLine(secret(required = false), true).contains("optional"))
        assertFalse(integrationSecretLine(secret(required = true), true).contains("optional"))
    }

    // ── checked-at stamp ─────────────────────────────────────────────────────

    @Test
    fun `a readable stamp renders as a time`() {
        assertTrue(integrationsCheckedLabel("2026-07-31T12:00:00.000Z").startsWith("Checked "))
    }

    @Test
    fun `an unreadable stamp says so rather than vanishing`() {
        val label = integrationsCheckedLabel("not-a-time")
        assertTrue(label.contains("could not be read"))
        assertTrue(label.contains("not-a-time"))
    }

    @Test
    fun `a missing stamp is named, so an old answer is never read as a fresh one`() {
        assertTrue(integrationsCheckedLabel("").contains("did not stamp"))
    }
}
