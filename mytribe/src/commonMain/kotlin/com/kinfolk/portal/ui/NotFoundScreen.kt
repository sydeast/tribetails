package com.kinfolk.portal.ui
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
/** Same sentences as the portal web's not-found page (`screens/NotFound.tsx`). */
const val NOT_FOUND_TITLE = "We can\u2019t find that page."
const val NOT_FOUND_BODY = "The link may be old, or the address may have a typo."
const val NOT_FOUND_HOME = "Back to Home"
/**
 * What the app shows for a link it was opened with but could not place (#1293).
 * The twin of the portal web's not-found page: the wordmark, one sentence, and
 * one way back. [onHome] clears the link, so a signed-in household lands on
 * Home and a signed-out one on sign-in.
 */
@Composable
fun NotFoundScreen(onHome: () -> Unit) {
    val type = LocalKinfolkTypography.current
    Box(
        modifier = Modifier.fillMaxSize().background(KinfolkBrand.Cream),
        contentAlignment = Alignment.Center,
    ) {
        GlassCard(
            modifier = Modifier.fillMaxWidth(0.86f).padding(KinfolkSpacing.l),
            contentPadding = PaddingValues(KinfolkSpacing.xl),
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                Text("PAGE NOT FOUND", style = type.sansMeta.copy(color = KinfolkBrand.KinfolkOrange))
                Text(NOT_FOUND_TITLE, style = type.heritageSection, textAlign = TextAlign.Center)
                Text(
                    NOT_FOUND_BODY,
                    style = type.sansBody.copy(color = KinfolkBrand.NavySoft),
                    textAlign = TextAlign.Center,
                )
                Button(
                    onClick = onHome,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = KinfolkBrand.KinfolkOrange,
                        contentColor = Color.White,
                    ),
                ) { Text(NOT_FOUND_HOME) }
            }
        }
    }
}
