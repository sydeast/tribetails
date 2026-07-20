@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.ComposeUiTest
import com.kinfolk.portal.theme.KinfolkPortalTheme
import kotlinx.serialization.json.JsonObject

/** Wraps content in the production theme so LocalKinfolkTypography is available. */
@Composable
fun ThemedTestRoot(content: @Composable () -> Unit) {
    KinfolkPortalTheme(content = content)
}

/**
 * Convenience: lets ComposeUiTest set themed content with one call.
 * Note: not strictly needed (callers can wrap manually) but tightens tests.
 */
fun ComposeUiTest.setThemedContent(content: @Composable () -> Unit) {
    setContent { ThemedTestRoot(content) }
}

/** Builds a JsonObject from a vararg of pairs. Test ergonomics. */
fun jsonOf(vararg pairs: Pair<String, kotlinx.serialization.json.JsonElement>): JsonObject =
    JsonObject(pairs.toMap())
