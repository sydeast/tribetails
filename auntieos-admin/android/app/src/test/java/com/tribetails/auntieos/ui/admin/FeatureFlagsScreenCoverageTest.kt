package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.config.FeatureFlags
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Guards that the admin Feature Flags screen lists EXACTLY the registry's keys, no flag can
 * be silently missing from the toggles, and no stale/typo'd key can linger after a rename.
 * Android parity with the web FeatureFlagsScreenCoverageTest.
 */
class FeatureFlagsScreenCoverageTest {
    @Test fun adminRows_coverEveryGatedRegistryKey_exactly() {
        val rowKeys = FLAGS.map { it.key }.toSet()
        // #3: built features default-ON live in ALWAYS_ON and intentionally have no row;
        // the screen lists exactly the remaining (genuinely-gated) flags. A new gated flag
        // still must get a row, so this stays fail-loud for real additions.
        val expected = FeatureFlags.KEYS.toSet() - FeatureFlags.ALWAYS_ON
        assertEquals("admin FLAGS rows must equal the gated registry keys", expected, rowKeys)
    }

    @Test fun adminRows_noDuplicateKeys() {
        assertEquals(FLAGS.size, FLAGS.map { it.key }.toSet().size)
    }

    /**
     * What the toggle SHOWS for a flag the Firestore doc has never mentioned.
     *
     * `repo.getFeatureFlags()` hands back the raw, SPARSE override map, not a
     * resolved one, so a key nobody has written is simply absent. Reading that
     * absence as "off" was harmless while every gated flag defaulted off. The
     * Inbox arrangement flag defaults ON, and the same reading would have drawn
     * its toggle OFF while the sections it gates were plainly on the screen,
     * then made the operator's first tap write `true`, a no-op that reads as a
     * broken control. So a row's displayed value is resolved through the
     * registry, exactly as the screens that consume the flag resolve it.
     */
    @Test fun flagRowValue_showsTheRegistryDefault_forAKeyTheDocNeverMentions() {
        assertEquals(true, flagRowValue(emptyMap(), FeatureFlags.KEY_INBOX_WAITING_SECTIONS))
        assertEquals(false, flagRowValue(emptyMap(), FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP))
    }

    @Test fun flagRowValue_showsTheStoredOverrideWhenThereIsOne() {
        val doc = mapOf(FeatureFlags.KEY_INBOX_WAITING_SECTIONS to false)
        assertEquals(false, flagRowValue(doc, FeatureFlags.KEY_INBOX_WAITING_SECTIONS))
    }

    @Test fun flagRowValue_ignoresAKeyOutsideTheRegistry() {
        // Same rule as fromOverrides: an unknown key can never surprise a row.
        assertEquals(
            false,
            flagRowValue(mapOf("auntieos.totally.bogus" to true), "auntieos.totally.bogus"),
        )
    }
}
