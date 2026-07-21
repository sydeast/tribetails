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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography

@Composable
fun NoTribesOnboarding(onMessageAuntie: () -> Unit = {}) {
    val type = LocalKinfolkTypography.current
    Box(
        modifier = Modifier.fillMaxSize().background(KinfolkBrand.Cream),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier.fillMaxSize().background(KinfolkGradients.headerWash),
        )
        GlassCard(
            modifier = Modifier.fillMaxWidth(0.86f).padding(KinfolkSpacing.l),
            contentPadding = PaddingValues(KinfolkSpacing.xl),
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                Text(
                    text = "Welcome to MyTribe!",
                    style = type.heritageDisplay,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(KinfolkSpacing.xs))
                Text(
                    text = "We're so glad you're here. Your Auntie is putting the final touches on your Tribe. Once you're set up, this is where you'll find live visits, KinTales, schedules, and everything that keeps your Kin happy.",
                    style = type.sansBody,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(KinfolkSpacing.s))
                Text(
                    text = "If you've got questions or need help getting started, send your Auntie a message and she'll get you sorted.",
                    style = type.sansBody.copy(color = KinfolkBrand.NavySoft),
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(KinfolkSpacing.m))
                Button(
                    onClick = onMessageAuntie,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = KinfolkBrand.KinfolkOrange,
                        contentColor = Color.White,
                    ),
                ) { Text("Message Auntie") }
            }
        }
    }
}
