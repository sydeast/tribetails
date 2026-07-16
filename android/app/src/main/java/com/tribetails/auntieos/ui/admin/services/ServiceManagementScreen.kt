package com.tribetails.auntieos.ui.admin.services

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun ServiceManagementScreen(
    onBack: () -> Unit,
    viewModel: ServiceManagementViewModel
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    var showAddServiceDialog by remember { mutableStateOf(false) }
    var showAddSurchargeDialog by remember { mutableStateOf(false) }
    var showAddDiscountDialog by remember { mutableStateOf(false) }
    var showAddPromoCodeDialog by remember { mutableStateOf(false) }
    var editingService by remember { mutableStateOf<BaseService?>(null) }

    Box(modifier = Modifier.fillMaxSize()) {
        AuntieScreenScaffold(
            title = "Service Management",
            onBack = onBack,
            imePaddingEnabled = true,
        ) {
            AuntieTabRow(
                selectedIndex = state.selectedTab.ordinal,
                tabs = ServiceTab.entries.map { it.displayName },
                onSelect = { viewModel.selectTab(ServiceTab.entries[it]) }
            )

            state.errorMessage?.let { error ->
                AuntieCard(
                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                    containerColor = AuntieTheme.colors.error.copy(alpha = 0.1f)
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            Lucide.CircleAlert,
                            contentDescription = null,
                            tint = AuntieTheme.colors.error,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = error,
                            color = AuntieTheme.colors.error,
                            modifier = Modifier.weight(1f)
                        )
                        AuntieIconBtn(onClick = { viewModel.clearError() }) {
                            Icon(Lucide.X, contentDescription = "Dismiss", tint = AuntieTheme.colors.error)
                        }
                    }
                }
            }

            if (state.isLoading) {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                    contentAlignment = Alignment.Center
                ) {
                    AuntieSpinner(color = AuntieTheme.colors.kinfolkOrange)
                }
            }

            when (state.selectedTab) {
                ServiceTab.BASE_SERVICES -> BaseServicesTab(
                    services = state.baseServices,
                    onEditService = { svc -> editingService = svc },
                    onDeleteService = { viewModel.deleteBaseService(it) }
                )
                ServiceTab.SUPPLEMENTAL -> SupplementalServicesTab(
                    services = state.supplementalServices,
                    baseServices = state.baseServices
                )
                ServiceTab.PRICING -> PricingTab(
                    surcharges = state.surcharges,
                    discounts = state.discounts,
                    promoCodes = state.promoCodes,
                    onAddSurcharge = { showAddSurchargeDialog = true },
                    onAddDiscount = { showAddDiscountDialog = true },
                    onAddPromoCode = { showAddPromoCodeDialog = true }
                )
                ServiceTab.SETTINGS -> SettingsTab(
                    businessHours = state.businessHours,
                    businessSettings = state.businessSettings,
                    onUpdateBusinessHours = { viewModel.updateBusinessHours(it) },
                    onUpdateBusinessSettings = { viewModel.updateBusinessSettings(it) }
                )
            }
        }

        when (state.selectedTab) {
            ServiceTab.BASE_SERVICES -> {
                AuntieFab(
                    onClick = { showAddServiceDialog = true },
                    modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp)
                ) {
                    Icon(Lucide.Plus, contentDescription = "Add Service")
                }
            }
            ServiceTab.SUPPLEMENTAL -> {
                AuntieFab(
                    onClick = { showAddServiceDialog = true },
                    modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp)
                ) {
                    Icon(Lucide.Plus, contentDescription = "Add Add-on")
                }
            }
            ServiceTab.PRICING -> {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(16.dp)
                        .height(56.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(AuntieTheme.colors.kinfolkOrange)
                        .clickable { showAddSurchargeDialog = true }
                        .padding(horizontal = 16.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Lucide.Plus, contentDescription = null, tint = AuntieTheme.colors.background, modifier = Modifier.size(24.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Add Pricing Rule", color = AuntieTheme.colors.background, style = AuntieTheme.typography.labelLarge)
                    }
                }
            }
            ServiceTab.SETTINGS -> { /* No FAB */ }
        }
    }

    if (showAddServiceDialog) {
        when (state.selectedTab) {
            ServiceTab.BASE_SERVICES -> {
                AddBaseServiceDialog(
                    onDismiss = { showAddServiceDialog = false },
                    onSave = { service ->
                        viewModel.createBaseService(service)
                        showAddServiceDialog = false
                    }
                )
            }
            ServiceTab.SUPPLEMENTAL -> {
                AddSupplementalServiceDialog(
                    baseServices = state.baseServices.filter { it.isActive },
                    onDismiss = { showAddServiceDialog = false },
                    onSave = { service ->
                        viewModel.createSupplementalService(service)
                        showAddServiceDialog = false
                    }
                )
            }
            else -> { }
        }
    }

    if (showAddSurchargeDialog) {
        AddSurchargeDialog(
            baseServices = state.baseServices.filter { it.isActive },
            onDismiss = { showAddSurchargeDialog = false },
            onSave = { surcharge ->
                viewModel.createSurcharge(surcharge)
                showAddSurchargeDialog = false
            }
        )
    }

    if (showAddDiscountDialog) {
        AddDiscountDialog(
            baseServices = state.baseServices.filter { it.isActive },
            onDismiss = { showAddDiscountDialog = false },
            onSave = { discount ->
                viewModel.createDiscount(discount)
                showAddDiscountDialog = false
            }
        )
    }

    if (showAddPromoCodeDialog) {
        AddPromoCodeDialog(
            baseServices = state.baseServices.filter { it.isActive },
            onDismiss = { showAddPromoCodeDialog = false },
            onSave = { promoCode ->
                viewModel.createPromoCode(promoCode)
                showAddPromoCodeDialog = false
            }
        )
    }

    editingService?.let { svc ->
        EditBaseServiceDialog(
            initial   = svc,
            onDismiss = { editingService = null },
            onSave    = { edited ->
                viewModel.updateBaseService(edited)
                editingService = null
            },
        )
    }
}

@Composable
fun BaseServicesTab(
    services: List<BaseService>,
    onEditService: (BaseService) -> Unit,
    onDeleteService: (String) -> Unit
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        items(services) { service ->
            ServiceCard(
                service = service,
                onEdit = { onEditService(service) },
                onDelete = { onDeleteService(service.id) }
            )
        }
    }
}

@Composable
fun ServiceCard(
    service: BaseService,
    onEdit: () -> Unit,
    onDelete: () -> Unit
) {
    AuntieCard(
        modifier = Modifier.fillMaxWidth(),
        containerColor = if (service.isActive) AuntieTheme.colors.surface else AuntieTheme.colors.surface.copy(alpha = 0.6f),
        onClick = onEdit
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = service.title,
                            style = AuntieTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = AuntieTheme.colors.textPrimary
                        )
                        Spacer(Modifier.width(8.dp))
                        if (!service.isActive) {
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(Color.Gray.copy(alpha = 0.3f))
                                    .padding(horizontal = 6.dp, vertical = 2.dp)
                            ) {
                                Text(
                                    "Inactive",
                                    style = AuntieTheme.typography.labelSmall,
                                    color = Color.Gray
                                )
                            }
                        }
                    }

                    if (service.description.isNotBlank()) {
                        Text(
                            text = service.description,
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 4.dp)
                        )
                    }

                    Spacer(Modifier.height(8.dp))

                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        ServiceDetailChip(icon = Lucide.Clock, text = service.displayDuration)
                        ServiceDetailChip(icon = Lucide.DollarSign, text = "$${String.format("%.2f", service.basePrice)}")
                        if (service.category.isNotBlank()) {
                            ServiceDetailChip(icon = Lucide.Tag, text = service.category)
                        }
                    }
                }

                AuntieIconBtn(onClick = onDelete) {
                    Icon(Lucide.Trash2, contentDescription = "Delete Service", tint = AuntieTheme.colors.error.copy(alpha = 0.7f))
                }
            }
        }
    }
}

@Composable
fun ServiceDetailChip(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    text: String
) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.1f))
            .padding(horizontal = 8.dp, vertical = 4.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                icon,
                contentDescription = null,
                tint = AuntieTheme.colors.kinfolkOrange,
                modifier = Modifier.size(16.dp)
            )
            Spacer(Modifier.width(4.dp))
            Text(
                text = text,
                style = AuntieTheme.typography.labelMedium,
                color = AuntieTheme.colors.textPrimary
            )
        }
    }
}

@Composable
fun SupplementalServicesTab(
    services: List<SupplementalService>,
    baseServices: List<BaseService>
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        items(services) { service ->
            SupplementalServiceCard(service = service, baseServices = baseServices)
        }
    }
}

@Composable
fun SupplementalServiceCard(
    service: SupplementalService,
    baseServices: List<BaseService>
) {
    AuntieCard(
        modifier = Modifier.fillMaxWidth(),
        containerColor = if (service.isActive) AuntieTheme.colors.surface else AuntieTheme.colors.surface.copy(alpha = 0.6f)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = service.title,
                            style = AuntieTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = AuntieTheme.colors.textPrimary
                        )
                        Spacer(Modifier.width(8.dp))
                        if (!service.isActive) {
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(Color.Gray.copy(alpha = 0.3f))
                                    .padding(horizontal = 6.dp, vertical = 2.dp)
                            ) {
                                Text("Inactive", style = AuntieTheme.typography.labelSmall, color = Color.Gray)
                            }
                        }
                    }

                    if (service.description.isNotBlank()) {
                        Text(
                            text = service.description,
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 4.dp)
                        )
                    }

                    Spacer(Modifier.height(8.dp))

                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        ServiceDetailChip(icon = Lucide.DollarSign, text = "$${String.format("%.2f", service.price)}")
                        if (service.isStandaloneService) {
                            ServiceDetailChip(icon = Lucide.Star, text = "Standalone")
                        }
                    }

                    if (service.canAttachToServices.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = "Available with: ${service.canAttachToServices.size} services",
                            style = AuntieTheme.typography.labelMedium,
                            color = AuntieTheme.colors.textPrimary.copy(alpha = 0.6f)
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun PricingTab(
    surcharges: List<Surcharge>,
    discounts: List<Discount>,
    promoCodes: List<PromoCode>,
    onAddSurcharge: () -> Unit,
    onAddDiscount: () -> Unit,
    onAddPromoCode: () -> Unit
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            AuntieCard(
                modifier = Modifier.fillMaxWidth(),
                containerColor = AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.1f)
            ) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = "Pricing Tools",
                        style = AuntieTheme.typography.labelMedium,
                        color = AuntieTheme.colors.kinfolkOrange,
                        fontWeight = FontWeight.SemiBold
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        GhostButton(label = "Surcharge", onClick = onAddSurcharge, modifier = Modifier.weight(1f))
                        GhostButton(label = "Discount", onClick = onAddDiscount, modifier = Modifier.weight(1f))
                        GhostButton(label = "Promo", onClick = onAddPromoCode, modifier = Modifier.weight(1f))
                    }
                }
            }
        }

        item { PricingSectionHeader(title = "Surcharges", subtitle = "${surcharges.size} active", onAdd = onAddSurcharge) }
        items(surcharges.take(3)) { surcharge ->
            PricingRuleCard(title = surcharge.title, description = surcharge.description, amount = surcharge.amount, type = surcharge.type.name, isActive = surcharge.isActive)
        }

        item { PricingSectionHeader(title = "Discounts", subtitle = "${discounts.size} active", onAdd = onAddDiscount) }
        items(discounts.take(3)) { discount ->
            PricingRuleCard(title = discount.title, description = discount.description, amount = discount.amount, type = discount.type.name, isActive = discount.isActive)
        }

        item { PricingSectionHeader(title = "Promo Codes", subtitle = "${promoCodes.size} codes", onAdd = onAddPromoCode) }
        items(promoCodes.take(3)) { promoCode ->
            PromoCodeCard(promoCode = promoCode)
        }
    }
}

@Composable
fun PricingSectionHeader(
    title: String,
    subtitle: String,
    onAdd: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column {
            Text(text = title, style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
            Text(text = subtitle, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.6f))
        }

        AuntieTextBtn(onClick = onAdd) {
            Icon(Lucide.Plus, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(4.dp))
            Text("Add")
        }
    }
}

@Composable
fun PricingRuleCard(
    title: String,
    description: String,
    amount: Double,
    type: String,
    isActive: Boolean
) {
    AuntieCard(
        modifier = Modifier.fillMaxWidth(),
        containerColor = if (isActive) AuntieTheme.colors.surface else AuntieTheme.colors.surface.copy(alpha = 0.6f)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = title, style = AuntieTheme.typography.titleSmall, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary)
                if (description.isNotBlank()) {
                    Text(
                        text = description,
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 2.dp)
                    )
                }
            }

            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = if (type.contains("PERCENTAGE")) "${amount.toInt()}%" else "$${String.format("%.2f", amount)}",
                    style = AuntieTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = AuntieTheme.colors.kinfolkOrange
                )
                Text(text = type.replace("_", " "), style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.6f))
            }
        }
    }
}

@Composable
fun PromoCodeCard(promoCode: PromoCode) {
    AuntieCard(
        modifier = Modifier.fillMaxWidth(),
        containerColor = if (promoCode.isActive) AuntieTheme.colors.surface else AuntieTheme.colors.surface.copy(alpha = 0.6f)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .background(AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.2f))
                            .padding(horizontal = 8.dp, vertical = 4.dp)
                    ) {
                        Text(
                            text = promoCode.code,
                            style = AuntieTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            color = AuntieTheme.colors.kinfolkOrange
                        )
                    }

                    if (promoCode.usageLimit > 0) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = "${promoCode.usedCount}/${promoCode.usageLimit} used",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.textPrimary.copy(alpha = 0.6f)
                        )
                    }
                }

                if (promoCode.title.isNotBlank()) {
                    Text(
                        text = promoCode.title,
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f),
                        modifier = Modifier.padding(top = 4.dp)
                    )
                }
            }

            Text(
                text = if (promoCode.discountType == DiscountType.PERCENTAGE) {
                    "${promoCode.discountAmount.toInt()}% off"
                } else {
                    "$${String.format("%.2f", promoCode.discountAmount)} off"
                },
                style = AuntieTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = AuntieTheme.colors.kinfolkOrange
            )
        }
    }
}

@Composable
fun SettingsTab(
    businessHours: List<BusinessHours>,
    businessSettings: BusinessSettings,
    onUpdateBusinessHours: (List<BusinessHours>) -> Unit,
    onUpdateBusinessSettings: (BusinessSettings) -> Unit
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Text(
                text = "Business Settings",
                style = AuntieTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                color = AuntieTheme.colors.textPrimary
            )
        }

        item {
            AdminSettingsCard(
                settings = businessSettings,
                onUpdate = onUpdateBusinessSettings
            )
        }

        item {
            Text(
                text = "Business Hours",
                style = AuntieTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = AuntieTheme.colors.textPrimary,
                modifier = Modifier.padding(top = 16.dp)
            )
        }

        items(businessHours.sortedBy { it.dayOfWeek }) { hours ->
            BusinessHoursCard(
                hours  = hours,
                onSave = { edited ->
                    // Merge the edited day back into the full week list,
                    // matching by id (or dayOfWeek for unsaved rows), then
                    // hand off to the viewModel which writes the full set
                    // through ServiceRepository.updateBusinessHours.
                    val merged = businessHours.map { existing ->
                        if (existing.id == edited.id && existing.id.isNotBlank()) edited
                        else if (existing.id.isBlank() && existing.dayOfWeek == edited.dayOfWeek) edited
                        else existing
                    }
                    onUpdateBusinessHours(merged)
                },
            )
        }
    }
}
