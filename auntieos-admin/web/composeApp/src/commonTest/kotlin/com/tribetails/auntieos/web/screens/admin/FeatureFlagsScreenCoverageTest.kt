package com.tribetails.auntieos.web.screens.admin

import com.tribetails.auntieos.web.config.FeatureFlags
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 0D, the Feature Flags admin screen must list EVERY registry flag, so promoting
 * a flag into [FeatureFlags] without giving it a toggle row fails loud here.
 */
class FeatureFlagsScreenCoverageTest {

    @Test fun `admin screen lists exactly the gated registry keys`() {
        val screenKeys = FLAGS.map { it.key }.toSet()
        // #3: built features default-ON live in ALWAYS_ON and intentionally have no row;
        // the screen lists exactly the remaining (genuinely-gated) flags. A NEW flag not
        // in ALWAYS_ON still must have a row, so this stays fail-loud for real additions.
        val expected = FeatureFlags.KEYS.toSet() - FeatureFlags.ALWAYS_ON
        assertEquals(expected, screenKeys, "Feature Flags screen rows must match the gated registry keys")
    }

    @Test fun `no duplicate flag rows`() {
        val keys = FLAGS.map { it.key }
        assertEquals(keys.size, keys.toSet().size, "duplicate flag row in the admin screen")
    }
}
