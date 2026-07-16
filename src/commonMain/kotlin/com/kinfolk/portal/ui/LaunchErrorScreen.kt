package com.kinfolk.portal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
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

/**
 * Shown when the launch flow can't load access info — distinct from NoTribes
 * (which means "no kinfolks linked"). Surfaces the underlying error and lets
 * the user retry the access call or sign out.
 */
@Composable
fun LaunchErrorScreen(
    message: String,
    onRetry: () -> Unit,
    onSignOut: () -> Unit,
) {
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
                Text(
                    text = "We're having trouble loading your tribe.",
                    style = type.heritageSection,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(KinfolkSpacing.xs))
                Text(
                    text = message,
                    style = type.sansBody.copy(color = KinfolkBrand.NavySoft),
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(KinfolkSpacing.xs))
                Text(
                    text = "Nothing is lost, your pack is safe. Give it another try in a moment.",
                    style = type.sansBody.copy(color = KinfolkBrand.NavySoft),
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(KinfolkSpacing.m))
                Button(
                    onClick = onRetry,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = KinfolkBrand.KinfolkOrange,
                        contentColor = Color.White,
                    ),
                ) { Text("Try again") }
                OutlinedButton(onClick = onSignOut) { Text("Sign out") }
            }
        }
    }
}
