package com.tribetails.auntieos.web.ui.components

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * #867: what a screen shows in place of its loading shimmer when the read it is
 * waiting on failed (signed out, refused, or timed out). Without it the shimmer
 * never ends and the operator cannot tell a slow network from a broken one.
 */
@Composable
fun LoadErrorBanner(title: String, message: String, modifier: Modifier = Modifier) {
    AuntieBanner(modifier = modifier, tone = AuntieBannerTone.Error, title = title) {
        Text(message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error)
    }
}
