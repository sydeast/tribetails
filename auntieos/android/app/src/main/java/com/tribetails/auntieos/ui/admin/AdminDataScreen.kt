package com.tribetails.auntieos.ui.admin

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.ui.components.AuntieCard
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieTopBar
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

data class AdminDataCard(
    val title: String,
    val description: String,
    val icon: ImageVector,
    val count: String = "",
    val route: String
)

@Composable
fun AdminDataScreen(
    onBack: () -> Unit,
    onNavigateToInvoices: () -> Unit,
    onNavigateToKinTaleLogs: () -> Unit,
    onNavigateToTrainingDocs: () -> Unit,
    onNavigateToKinCareSessions: () -> Unit,
    vm: AdminDataViewModel = viewModel(),
) {
    // Live counts drive the badges + confirm each bank is populated. Previously
    // these were hardcoded literals ("15"/"84"/...) and the load* fns were never
    // called, so the banks read as full while the sub-screens were empty (I10).
    val invoices by vm.invoices.collectAsState()
    val reports by vm.kinCareReports.collectAsState()
    val sessions by vm.kinCareSessions.collectAsState()
    val trainingDocs by vm.trainingDocuments.collectAsState()
    val loadError by vm.error.collectAsState()

    LaunchedEffect(Unit) {
        vm.loadInvoices()
        vm.loadKinCareReports()
        vm.loadKinCareSessions()
        vm.loadTrainingDocuments()
    }

    val dataCards = listOf(
        AdminDataCard(
            title       = "Invoices",
            description = "View and manage client invoices, billing status, and payment history",
            icon        = Lucide.Receipt,
            count       = invoices.size.toString(),
            route       = "invoices"
        ),
        AdminDataCard(
            title       = "KinTales",
            description = "Visit recaps sent home to Kinfolk after every session",
            icon        = Lucide.FileText,
            count       = reports.size.toString(),
            route       = "kintale_logs"
        ),
        AdminDataCard(
            title       = "Auntie Time",
            description = "Day-of view - Kin Cares in flight, scheduled, and just completed",
            icon        = Lucide.Clock3,
            count       = sessions.size.toString(),
            route       = "auntie_time"
        ),
        AdminDataCard(
            title       = "Tribal Intel",
            description = "Training materials, guides, and educational resources",
            icon        = Lucide.BookOpen,
            count       = trainingDocs.size.toString(),
            route       = "training_docs"
        )
    )

    AuntieScreenScaffold(title = "Admin Data", onBack = onBack) {
        LazyColumn(
            modifier            = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding      = PaddingValues(vertical = 16.dp)
        ) {
            item {
                Text(
                    text     = "Select a data category to view and manage:",
                    style    = AuntieTheme.typography.bodyLarge,
                    color    = AuntieTheme.colors.textPrimary,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
            }

            // Fail-loud: a load failure surfaces here, never a silent empty bank.
            loadError?.let { err ->
                item {
                    AuntieCard(
                        modifier       = Modifier.fillMaxWidth(),
                        containerColor = AuntieTheme.colors.error.copy(alpha = 0.1f),
                        border         = BorderStroke(0.5.dp, AuntieTheme.colors.error),
                        shape          = RoundedCornerShape(12.dp),
                    ) {
                        Row(
                            modifier          = Modifier.fillMaxWidth().padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                imageVector        = Lucide.CircleAlert,
                                contentDescription = null,
                                tint               = AuntieTheme.colors.error,
                                modifier           = Modifier.size(20.dp)
                            )
                            Spacer(Modifier.width(12.dp))
                            Text(
                                text  = "Couldn't load admin data: $err",
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.error,
                            )
                        }
                    }
                }
            }

            items(dataCards.size) { index ->
                val card = dataCards[index]
                AdminDataCardItem(
                    card    = card,
                    onClick = {
                        when (card.route) {
                            "invoices"     -> onNavigateToInvoices()
                            "kintale_logs" -> onNavigateToKinTaleLogs()
                            "training_docs"-> onNavigateToTrainingDocs()
                            "auntie_time"  -> onNavigateToKinCareSessions()
                        }
                    }
                )
            }
        }
    }
}

@Composable
private fun AdminDataCardItem(
    card:    AdminDataCard,
    onClick: () -> Unit
) {
    AuntieCard(
        modifier       = Modifier.fillMaxWidth(),
        containerColor = AuntieTheme.colors.surface,
        border         = BorderStroke(0.5.dp, AuntieTheme.colors.border),
        shape          = RoundedCornerShape(12.dp),
        onClick        = onClick,
    ) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector        = card.icon,
                contentDescription = null,
                modifier           = Modifier.size(40.dp),
                tint               = AuntieTheme.colors.kinfolkOrange
            )

            Spacer(Modifier.width(16.dp))

            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text       = card.title,
                        style      = AuntieTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color      = AuntieTheme.colors.textPrimary
                    )
                    if (card.count.isNotEmpty()) {
                        Spacer(Modifier.width(8.dp))
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .background(AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.2f))
                        ) {
                            Text(
                                text       = card.count,
                                modifier   = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                style      = AuntieTheme.typography.labelSmall,
                                color      = AuntieTheme.colors.kinfolkOrange,
                                fontWeight = FontWeight.Medium
                            )
                        }
                    }
                }

                Spacer(Modifier.height(4.dp))

                Text(
                    text  = card.description,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f)
                )
            }

            Spacer(Modifier.width(8.dp))

            Icon(
                imageVector        = Lucide.ChevronRight,
                contentDescription = null,
                tint               = AuntieTheme.colors.textPrimary.copy(alpha = 0.5f)
            )
        }
    }
}
