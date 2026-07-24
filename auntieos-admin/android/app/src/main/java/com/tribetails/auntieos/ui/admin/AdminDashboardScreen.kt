package com.tribetails.auntieos.ui.admin

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.ui.theme.AuntieTheme

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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.components.AuntieCard
import com.tribetails.auntieos.ui.components.AuntieIconBtn
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieTopBar

@Composable
fun AdminDashboardScreen(
    onNavigateToSchedule: () -> Unit,
    onNavigateToBookingManagement: () -> Unit = {},
    onNavigateToSettings: () -> Unit,
    onNavigateToLogs: () -> Unit,
    onNavigateToBusinessData: () -> Unit = {},
    onNavigateToFormSchemas: () -> Unit = {},
    onNavigateToServices: () -> Unit = {},
    onNavigateToKinTaleTemplates: () -> Unit = {},
    onNavigateToTemplates: () -> Unit = {},
    onNavigateToFeatureFlags: () -> Unit = {},
    onNavigateToCoveragePackages: () -> Unit = {},
) {
    AuntieScreenScaffold(
        title = "Dashboard",
        actions = {
            AuntieIconBtn(onClick = onNavigateToLogs) {
                Icon(
                    imageVector        = Lucide.List,
                    contentDescription = "Activity Logs",
                    tint               = AuntieTheme.colors.textDim,
                )
            }
            AuntieIconBtn(onClick = onNavigateToSettings) {
                Icon(
                    imageVector        = Lucide.Settings,
                    contentDescription = "Settings",
                    tint               = AuntieTheme.colors.textDim,
                )
            }
        },
    ) {
        LazyColumn(
            modifier            = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding      = PaddingValues(top = 8.dp, bottom = 24.dp),
        ) {
            // ── Operations ──────────────────────────────────────────────────
            item { DashboardSectionLabel("Operations") }
            item {
                AdminDashTile(
                    icon        = Lucide.CalendarDays,
                    accentColor = AuntieTheme.colors.kinfolkOrange,
                    title       = "Booking Management",
                    description = "Create, edit, confirm, or cancel bookings. Review pending requests.",
                    onClick     = onNavigateToBookingManagement,
                )
            }
            item {
                AdminDashTile(
                    icon        = Lucide.Receipt,
                    accentColor = AuntieTheme.colors.tertiary,
                    title       = "Coverage Packages",
                    description = "Build a visit menu + coverage rules, then price a multi-day stay from a rule-valid daily schedule.",
                    onClick     = onNavigateToCoveragePackages,
                )
            }
            item {
                AdminDashTile(
                    icon        = Lucide.SlidersHorizontal,
                    accentColor = AuntieTheme.colors.kinTeal,
                    title       = "Scheduling Options",
                    description = "Google sync, blocks, holidays, special hours, and conflict settings.",
                    onClick     = onNavigateToSchedule,
                )
            }

            // ── Service Setup ────────────────────────────────────────────────
            item { DashboardSectionLabel("Service Setup") }
            item {
                AdminDashTile(
                    icon        = Lucide.PawPrint,
                    accentColor = AuntieTheme.colors.packPink,
                    title       = "Service Management",
                    description = "Base services, add-ons, pricing, surcharges, discounts, and promo codes.",
                    onClick     = onNavigateToServices,
                )
            }
            item {
                AdminDashTile(
                    icon        = Lucide.LayoutList,
                    accentColor = AuntieTheme.colors.kinTeal,
                    title       = "Form Schemas",
                    description = "Author the kinfolk-facing dynamic forms (sections, fields, types).",
                    onClick     = onNavigateToFormSchemas,
                )
            }
            item {
                AdminDashTile(
                    icon        = Lucide.PenLine,
                    accentColor = AuntieTheme.colors.snuggleCoral,
                    title       = "KinTale Templates",
                    description = "Build report templates per service type with conditional fields.",
                    onClick     = onNavigateToKinTaleTemplates,
                )
            }
            item {
                AdminDashTile(
                    icon        = Lucide.Mail,
                    accentColor = AuntieTheme.colors.kinTeal,
                    title       = "Templates",
                    description = "Author email templates and bind them to notification triggers.",
                    onClick     = onNavigateToTemplates,
                )
            }

            // ── Business Data ────────────────────────────────────────────────
            item { DashboardSectionLabel("Business Data") }
            item {
                AdminDashTile(
                    icon        = Lucide.ChartBar,
                    accentColor = AuntieTheme.colors.warning,
                    title       = "Business Data",
                    description = "View invoices, payments, visit logs, and training documents.",
                    onClick     = onNavigateToBusinessData,
                )
            }

            // ── Configuration ───────────────────────────────────────────────
            item { DashboardSectionLabel("Configuration") }
            item {
                AdminDashTile(
                    icon        = Lucide.Flag,
                    accentColor = AuntieTheme.colors.accent,
                    title       = "Feature Flags",
                    description = "Toggle the central auntieos.* flags. Takes effect on next app load.",
                    onClick     = onNavigateToFeatureFlags,
                )
            }
        }
    }
}

@Composable
private fun DashboardSectionLabel(title: String) {
    Text(
        text     = title.uppercase(),
        style    = AuntieTheme.typography.labelSmall,
        color    = AuntieTheme.colors.textFaint,
        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp, start = 4.dp),
    )
}

@Composable
private fun AdminDashTile(
    icon:        ImageVector,
    accentColor: Color,
    title:       String,
    description: String,
    onClick:     () -> Unit,
) {
    AuntieCard(
        modifier       = Modifier.fillMaxWidth(),
        shape          = RoundedCornerShape(20.dp),
        containerColor = AuntieTheme.colors.surface,
        border         = BorderStroke(1.dp, AuntieTheme.colors.borderSoft),
        onClick        = onClick,
    ) {
        Row(
            modifier              = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment     = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(accentColor.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector        = icon,
                    contentDescription = null,
                    tint               = accentColor,
                    modifier           = Modifier.size(22.dp),
                )
            }

            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text  = title,
                    style = AuntieTheme.typography.titleSmall,
                    color = AuntieTheme.colors.textPrimary,
                )
                Text(
                    text  = description,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }

            Icon(
                imageVector        = Lucide.ChevronRight,
                contentDescription = null,
                tint               = AuntieTheme.colors.textFaint,
                modifier           = Modifier.size(20.dp),
            )
        }
    }
}
