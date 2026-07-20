package com.kinfolk.portal.config

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class FeatureFlagsTest {

    // All `mytribe.*` flags were removed; every feature ships always-on. The
    // FeatureFlags type is now empty and its factories return an empty instance.

    @Test
    fun toMap_is_empty() {
        assertTrue(FeatureFlags().toMap().isEmpty())
    }

    @Test
    fun keys_is_empty() {
        assertTrue(FeatureFlags.KEYS.isEmpty())
    }

    @Test
    fun factories_return_empty_flags() {
        val empty = FeatureFlags()
        assertEquals(empty, FeatureFlags.fromMap(mapOf("mytribe.not.a.real.flag" to true)))
        assertEquals(empty, FeatureFlags.fromOverrides(mapOf("mytribe.not.a.real.flag" to true)))
        assertEquals(empty, FeatureFlags.resolve(mapOf("a" to true), mapOf("b" to false)))
        assertEquals(empty, FeatureFlags.DEFAULT)
    }
}
