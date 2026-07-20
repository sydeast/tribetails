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
}
