package com.tribetails.auntieos.ui.admin

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.ui.theme.AuntieTheme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import com.tribetails.auntieos.ui.components.PrimaryButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.ui.components.LoadingScreen

import com.tribetails.auntieos.ui.theme.BrandCream

@Composable
fun AdminGate(
    repository: AuntieRepository,
    onDenied: () -> Unit,
    content: @Composable () -> Unit
) {
    var status by remember { mutableStateOf<AdminGateStatus>(AdminGateStatus.Checking) }

    LaunchedEffect(Unit) {
        status = repository.isCurrentUserAdmin().fold(
            onSuccess = { if (it) AdminGateStatus.Allowed else AdminGateStatus.Denied },
            onFailure = { AdminGateStatus.Error(it.message ?: "Unknown error") }
        )
    }

    when (val s = status) {
        AdminGateStatus.Checking -> LoadingScreen(message = "Verifying admin access…", modifier = Modifier.fillMaxSize())
        AdminGateStatus.Allowed -> content()
        AdminGateStatus.Denied -> AdminDeniedScreen(reason = "This device's account does not have the admin claim.", onBack = onDenied)
        is AdminGateStatus.Error -> AdminDeniedScreen(reason = "Admin check failed: ${s.message}", onBack = onDenied)
    }
}

private sealed class AdminGateStatus {
    data object Checking : AdminGateStatus()
    data object Allowed : AdminGateStatus()
    data object Denied : AdminGateStatus()
    data class Error(val message: String) : AdminGateStatus()
}

@Composable
private fun AdminDeniedScreen(reason: String, onBack: () -> Unit) {
    Box(
        modifier = Modifier.fillMaxSize().background(AuntieTheme.colors.background).padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Icon(Lucide.Lock, contentDescription = null, tint = BrandCream)
            Text("Admin access required", color = BrandCream, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
            Text(reason, color = BrandCream, fontSize = 14.sp)
            PrimaryButton(label = "Back", onClick = onBack)
        }
    }
}
