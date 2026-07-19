package com.tribetails.auntieos.ui.admin.services

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.LocalDate

/**
 * Edit-mode wrapper for the Base Service dialog. Pre-fills every field from
 * an existing BaseService so the operator never has to retype anything they
 * aren't actually changing. Preserves `id` and any timestamp metadata via
 * .copy() - only the editable fields are overridden on save.
 */
@Composable
fun EditBaseServiceDialog(
    initial: BaseService,
    onDismiss: () -> Unit,
    onSave: (BaseService) -> Unit,
) {
    AddBaseServiceDialog(
        onDismiss   = onDismiss,
        initial     = initial,
        titleText   = "Edit Base Service",
        saveLabel   = "Save Changes",
        onSave      = { edited ->
            // Merge edits back onto the existing record so id + any unseen
            // fields (timestamps, etc.) survive the round-trip.
            onSave(
                initial.copy(
                    title                    = edited.title,
                    description              = edited.description,
                    durationMinutes          = edited.durationMinutes,
                    basePrice                = edited.basePrice,
                    category                 = edited.category,
                    isActive                 = edited.isActive,
                    requiresSpecialEquipment = edited.requiresSpecialEquipment,
                    equipmentNotes           = edited.equipmentNotes,
                ),
            )
        },
    )
}

@Composable
fun AddBaseServiceDialog(
    onDismiss: () -> Unit,
    onSave: (BaseService) -> Unit,
    initial: BaseService? = null,
    titleText: String = "Add Base Service",
    saveLabel: String = "Save Service",
) {
    var title by remember { mutableStateOf(initial?.title ?: "") }
    var description by remember { mutableStateOf(initial?.description ?: "") }
    var durationHours by remember { mutableStateOf(((initial?.durationMinutes ?: 60) / 60).toString()) }
    var durationMinutes by remember { mutableStateOf(((initial?.durationMinutes ?: 60) % 60).toString()) }
    var basePrice by remember { mutableStateOf(initial?.basePrice?.takeIf { it > 0 }?.toString() ?: "") }
    var category by remember { mutableStateOf(initial?.category ?: "") }
    var requiresEquipment by remember { mutableStateOf(initial?.requiresSpecialEquipment ?: false) }
    var equipmentNotes by remember { mutableStateOf(initial?.equipmentNotes ?: "") }
    var isActive by remember { mutableStateOf(initial?.isActive ?: true) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        AuntieCard(
            modifier = Modifier.fillMaxWidth(0.95f).fillMaxHeight(0.9f),
            containerColor = AuntieTheme.colors.background
        ) {
            Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(titleText, style = AuntieTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                    AuntieIconBtn(onClick = onDismiss) {
                        Icon(Lucide.X, contentDescription = "Close")
                    }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                LazyColumn(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    item {
                        AuntieField(value = title, onValueChange = { title = it }, label = "Service Title *", modifier = Modifier.fillMaxWidth())
                    }

                    item {
                        AuntieField(value = description, onValueChange = { description = it }, label = "Description", modifier = Modifier.fillMaxWidth(), singleLine = false, minLines = 3, maxLines = 5)
                    }

                    item {
                        Text("Duration", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary)
                        Spacer(Modifier.height(8.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            AuntieField(
                                value = durationHours,
                                onValueChange = { durationHours = it },
                                label = "Hours",
                                modifier = Modifier.weight(1f),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
                            )
                            Text(":", color = AuntieTheme.colors.textPrimary)
                            AuntieField(
                                value = durationMinutes,
                                onValueChange = { durationMinutes = it },
                                label = "Minutes",
                                modifier = Modifier.weight(1f),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
                            )
                        }
                    }

                    item {
                        AuntieField(
                            value = basePrice,
                            onValueChange = { basePrice = it },
                            label = "Base Price ($) *",
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            leading = { Icon(Lucide.DollarSign, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange) }
                        )
                    }

                    item {
                        AuntieField(value = category, onValueChange = { category = it }, label = "Category", modifier = Modifier.fillMaxWidth())
                    }

                    item {
                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                AuntieCheckbox(
                                    checked = requiresEquipment,
                                    onCheckedChange = { requiresEquipment = it },
                                )
                                Text("Requires Special Equipment", modifier = Modifier.clickable { requiresEquipment = !requiresEquipment }, color = AuntieTheme.colors.textPrimary)
                            }
                            if (requiresEquipment) {
                                Spacer(Modifier.height(8.dp))
                                AuntieField(value = equipmentNotes, onValueChange = { equipmentNotes = it }, label = "Equipment Notes", modifier = Modifier.fillMaxWidth())
                            }
                        }
                    }

                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AuntieCheckbox(
                                checked = isActive,
                                onCheckedChange = { isActive = it },
                            )
                            Text("Active Service", modifier = Modifier.clickable { isActive = !isActive }, color = AuntieTheme.colors.textPrimary)
                        }
                    }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
                    PrimaryButton(
                        label = saveLabel,
                        onClick = {
                            val hours = durationHours.toIntOrNull() ?: 0
                            val minutes = durationMinutes.toIntOrNull() ?: 0
                            val service = BaseService(
                                title = title.trim(),
                                description = description.trim(),
                                durationMinutes = (hours * 60) + minutes,
                                basePrice = basePrice.toDoubleOrNull() ?: 0.0,
                                category = category.trim(),
                                isActive = isActive,
                                requiresSpecialEquipment = requiresEquipment,
                                equipmentNotes = equipmentNotes.trim()
                            )
                            onSave(service)
                        },
                        modifier = Modifier.weight(1f),
                        enabled = title.isNotBlank() && basePrice.toDoubleOrNull() != null
                    )
                }
            }
        }
    }
}

@Composable
fun AddSupplementalServiceDialog(
    baseServices: List<BaseService>,
    onDismiss: () -> Unit,
    onSave: (SupplementalService) -> Unit
) {
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("") }
    var isStandalone by remember { mutableStateOf(false) }
    var isActive by remember { mutableStateOf(true) }
    var selectedServices by remember { mutableStateOf(setOf<String>()) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        AuntieCard(
            modifier = Modifier.fillMaxWidth(0.95f).fillMaxHeight(0.9f),
            containerColor = AuntieTheme.colors.background
        ) {
            Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("Add Supplemental Service", style = AuntieTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                    AuntieIconBtn(onClick = onDismiss) { Icon(Lucide.X, contentDescription = "Close") }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                LazyColumn(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    item { AuntieField(value = title, onValueChange = { title = it }, label = "Service Title *", modifier = Modifier.fillMaxWidth()) }
                    item { AuntieField(value = description, onValueChange = { description = it }, label = "Description", modifier = Modifier.fillMaxWidth(), singleLine = false, minLines = 3) }
                    item {
                        AuntieField(
                            value = price, onValueChange = { price = it }, label = "Price ($) *", modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            leading = { Icon(Lucide.DollarSign, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange) }
                        )
                    }
                    item { AuntieField(value = category, onValueChange = { category = it }, label = "Category", modifier = Modifier.fillMaxWidth()) }

                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AuntieCheckbox(checked = isStandalone, onCheckedChange = { isStandalone = it })
                            Text("Can be booked as standalone service", modifier = Modifier.clickable { isStandalone = !isStandalone }, color = AuntieTheme.colors.textPrimary)
                        }
                    }
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AuntieCheckbox(checked = isActive, onCheckedChange = { isActive = it })
                            Text("Active Service", modifier = Modifier.clickable { isActive = !isActive }, color = AuntieTheme.colors.textPrimary)
                        }
                    }
                    item { Text("Available with these services:", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary) }

                    items(baseServices) { service ->
                        Row(
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                                .selectable(selected = selectedServices.contains(service.id), onClick = {
                                    selectedServices = if (selectedServices.contains(service.id)) selectedServices - service.id else selectedServices + service.id
                                }).padding(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            AuntieCheckbox(
                                checked = selectedServices.contains(service.id),
                                onCheckedChange = { checked -> selectedServices = if (checked) selectedServices + service.id else selectedServices - service.id },
                            )
                            Spacer(Modifier.width(8.dp))
                            Column {
                                Text(service.title, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
                                Text("$${String.format("%.2f", service.basePrice)} • ${service.displayDuration}", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f))
                            }
                        }
                    }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
                    PrimaryButton(
                        label = "Save Service",
                        onClick = {
                            onSave(SupplementalService(
                                title = title.trim(), description = description.trim(),
                                price = price.toDoubleOrNull() ?: 0.0, category = category.trim(),
                                isStandaloneService = isStandalone, isActive = isActive,
                                canAttachToServices = selectedServices.toList()
                            ))
                        },
                        modifier = Modifier.weight(1f),
                        enabled = title.isNotBlank() && price.toDoubleOrNull() != null
                    )
                }
            }
        }
    }
}

@Composable
fun AddSurchargeDialog(
    baseServices: List<BaseService>,
    onDismiss: () -> Unit,
    onSave: (Surcharge) -> Unit,
    initial: Surcharge? = null,
    titleText: String = "Add Surcharge",
    saveLabel: String = "Save Surcharge",
) {
    var title by remember { mutableStateOf(initial?.title ?: "") }
    var description by remember { mutableStateOf(initial?.description ?: "") }
    var amount by remember { mutableStateOf(initial?.amount?.takeIf { it > 0 }?.toString() ?: "") }
    var type by remember { mutableStateOf(initial?.type ?: SurchargeType.FIXED_AMOUNT) }
    var applyOnWeekends by remember { mutableStateOf(initial?.applicableConditions?.applyOnWeekends ?: false) }
    var applyOnHolidays by remember { mutableStateOf(initial?.applicableConditions?.applyOnHolidays ?: false) }
    var applyAfterHours by remember { mutableStateOf(initial?.applicableConditions?.applyAfterHours ?: false) }
    var isActive by remember { mutableStateOf(initial?.isActive ?: true) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        AuntieCard(
            modifier = Modifier.fillMaxWidth(0.95f).fillMaxHeight(0.8f),
            containerColor = AuntieTheme.colors.background
        ) {
            Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(titleText, style = AuntieTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                    AuntieIconBtn(onClick = onDismiss) { Icon(Lucide.X, contentDescription = "Close") }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                LazyColumn(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    item { AuntieField(value = title, onValueChange = { title = it }, label = "Surcharge Title *", modifier = Modifier.fillMaxWidth()) }
                    item { AuntieField(value = description, onValueChange = { description = it }, label = "Description", modifier = Modifier.fillMaxWidth(), singleLine = false, minLines = 2) }

                    item {
                        Text("Surcharge Type", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary)
                        Spacer(Modifier.height(8.dp))
                        Column {
                            SurchargeType.values().forEach { surchargeType ->
                                Row(
                                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                                        .selectable(selected = type == surchargeType, onClick = { type = surchargeType }).padding(8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    AuntieRadio(selected = type == surchargeType, onClick = { type = surchargeType })
                                    Spacer(Modifier.width(8.dp))
                                    Text(surchargeType.name.replace("_", " "), color = AuntieTheme.colors.textPrimary)
                                }
                            }
                        }
                    }

                    item {
                        AuntieField(
                            value = amount,
                            onValueChange = { amount = it },
                            label = if (type == SurchargeType.FIXED_AMOUNT) "Amount ($) *" else "Percentage (%) *",
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            leading = { Icon(if (type == SurchargeType.FIXED_AMOUNT) Lucide.DollarSign else Lucide.Percent, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange) }
                        )
                    }

                    item {
                        Text("Apply When:", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary)
                        Spacer(Modifier.height(8.dp))
                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                AuntieCheckbox(checked = applyOnWeekends, onCheckedChange = { applyOnWeekends = it })
                                Text("Weekend bookings", modifier = Modifier.clickable { applyOnWeekends = !applyOnWeekends }, color = AuntieTheme.colors.textPrimary)
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                AuntieCheckbox(checked = applyOnHolidays, onCheckedChange = { applyOnHolidays = it })
                                Text("Holiday bookings", modifier = Modifier.clickable { applyOnHolidays = !applyOnHolidays }, color = AuntieTheme.colors.textPrimary)
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                AuntieCheckbox(checked = applyAfterHours, onCheckedChange = { applyAfterHours = it })
                                Text("After-hours bookings", modifier = Modifier.clickable { applyAfterHours = !applyAfterHours }, color = AuntieTheme.colors.textPrimary)
                            }
                        }
                    }

                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AuntieCheckbox(checked = isActive, onCheckedChange = { isActive = it })
                            Text("Active Surcharge", modifier = Modifier.clickable { isActive = !isActive }, color = AuntieTheme.colors.textPrimary)
                        }
                    }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
                    PrimaryButton(
                        label = saveLabel,
                        onClick = {
                            onSave((initial ?: Surcharge()).copy(
                                title = title.trim(), description = description.trim(), type = type,
                                amount = amount.toDoubleOrNull() ?: 0.0, isActive = isActive,
                                applicableConditions = (initial?.applicableConditions ?: SurchargeConditions()).copy(
                                    applyOnWeekends = applyOnWeekends, applyOnHolidays = applyOnHolidays, applyAfterHours = applyAfterHours
                                )
                            ))
                        },
                        modifier = Modifier.weight(1f),
                        enabled = title.isNotBlank() && amount.toDoubleOrNull() != null
                    )
                }
            }
        }
    }
}

@Composable
fun AddDiscountDialog(
    baseServices: List<BaseService>,
    onDismiss: () -> Unit,
    onSave: (Discount) -> Unit,
    initial: Discount? = null,
    titleText: String = "Add Discount",
    saveLabel: String = "Save Discount",
) {
    var title by remember { mutableStateOf(initial?.title ?: "") }
    var description by remember { mutableStateOf(initial?.description ?: "") }
    var amount by remember { mutableStateOf(initial?.amount?.takeIf { it > 0 }?.toString() ?: "") }
    var type by remember { mutableStateOf(initial?.type ?: DiscountType.PERCENTAGE) }
    var minimumPurchase by remember { mutableStateOf(initial?.conditions?.minimumPurchase?.toString() ?: "0") }
    var maxUsagePerCustomer by remember { mutableStateOf(initial?.conditions?.maxUsagePerCustomer?.toString() ?: "-1") }
    var requiresNewCustomer by remember { mutableStateOf(initial?.conditions?.requiresNewCustomer ?: false) }
    var isActive by remember { mutableStateOf(initial?.isActive ?: true) }
    var validFrom by remember { mutableStateOf(initial?.conditions?.validFrom?.takeIf { it.isNotBlank() } ?: LocalDate.now().toString()) }
    var validUntil by remember { mutableStateOf(initial?.conditions?.validUntil?.takeIf { it.isNotBlank() } ?: LocalDate.now().plusMonths(3).toString()) }
    var selectedServices by remember { mutableStateOf(initial?.conditions?.applicableServiceIds?.toSet() ?: setOf<String>()) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        AuntieCard(
            modifier = Modifier.fillMaxWidth(0.95f).fillMaxHeight(0.9f),
            containerColor = AuntieTheme.colors.background
        ) {
            Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(titleText, style = AuntieTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                    AuntieIconBtn(onClick = onDismiss) { Icon(Lucide.X, contentDescription = "Close") }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                LazyColumn(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    item { AuntieField(value = title, onValueChange = { title = it }, label = "Discount Title *", modifier = Modifier.fillMaxWidth()) }
                    item { AuntieField(value = description, onValueChange = { description = it }, label = "Description", modifier = Modifier.fillMaxWidth(), singleLine = false, minLines = 2) }

                    item {
                        Text("Discount Type", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary)
                        Spacer(Modifier.height(8.dp))
                        Column {
                            DiscountType.values().forEach { discountType ->
                                Row(
                                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                                        .selectable(selected = type == discountType, onClick = { type = discountType }).padding(8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    AuntieRadio(selected = type == discountType, onClick = { type = discountType })
                                    Spacer(Modifier.width(8.dp))
                                    Text(discountType.name.replace("_", " "), color = AuntieTheme.colors.textPrimary)
                                }
                            }
                        }
                    }

                    item {
                        AuntieField(
                            value = amount, onValueChange = { amount = it },
                            label = if (type == DiscountType.PERCENTAGE) "Discount (%) *" else "Discount Amount ($) *",
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            leading = { Icon(if (type == DiscountType.FIXED_AMOUNT) Lucide.DollarSign else Lucide.Percent, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange) }
                        )
                    }

                    item { AuntieField(value = minimumPurchase, onValueChange = { minimumPurchase = it }, label = "Minimum Purchase ($)", modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)) }
                    item { AuntieField(value = validFrom, onValueChange = { validFrom = it }, label = "Valid From (YYYY-MM-DD)", modifier = Modifier.fillMaxWidth()) }
                    item { AuntieField(value = validUntil, onValueChange = { validUntil = it }, label = "Valid Until (YYYY-MM-DD)", modifier = Modifier.fillMaxWidth()) }
                    item { AuntieField(value = maxUsagePerCustomer, onValueChange = { maxUsagePerCustomer = it }, label = "Max Uses Per Customer (-1 unlimited)", modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)) }

                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AuntieCheckbox(checked = requiresNewCustomer, onCheckedChange = { requiresNewCustomer = it })
                            Text("New customers only", modifier = Modifier.clickable { requiresNewCustomer = !requiresNewCustomer }, color = AuntieTheme.colors.textPrimary)
                        }
                    }
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AuntieCheckbox(checked = isActive, onCheckedChange = { isActive = it })
                            Text("Active Discount", modifier = Modifier.clickable { isActive = !isActive }, color = AuntieTheme.colors.textPrimary)
                        }
                    }

                    item { Text("Applies to Services (blank = all)", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary) }

                    items(baseServices) { service ->
                        Row(
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                                .selectable(selected = selectedServices.contains(service.id), onClick = {
                                    selectedServices = if (selectedServices.contains(service.id)) selectedServices - service.id else selectedServices + service.id
                                }).padding(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            AuntieCheckbox(
                                checked = selectedServices.contains(service.id),
                                onCheckedChange = { checked -> selectedServices = if (checked) selectedServices + service.id else selectedServices - service.id },
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(service.title, color = AuntieTheme.colors.textPrimary)
                        }
                    }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
                    PrimaryButton(
                        label = saveLabel,
                        onClick = {
                            onSave((initial ?: Discount()).copy(
                                title = title.trim(), description = description.trim(), type = type,
                                amount = amount.toDoubleOrNull() ?: 0.0, isActive = isActive,
                                conditions = (initial?.conditions ?: DiscountConditions()).copy(
                                    minimumPurchase = minimumPurchase.toDoubleOrNull() ?: 0.0,
                                    applicableServiceIds = selectedServices.toList(),
                                    validFrom = validFrom.trim(), validUntil = validUntil.trim(),
                                    maxUsagePerCustomer = maxUsagePerCustomer.toIntOrNull() ?: -1,
                                    requiresNewCustomer = requiresNewCustomer
                                )
                            ))
                        },
                        modifier = Modifier.weight(1f),
                        enabled = title.isNotBlank() && amount.toDoubleOrNull() != null
                    )
                }
            }
        }
    }
}

@Composable
fun AddPromoCodeDialog(
    baseServices: List<BaseService>,
    onDismiss: () -> Unit,
    onSave: (PromoCode) -> Unit,
    initial: PromoCode? = null,
    titleText: String = "Add Promo Code",
    saveLabel: String = "Save Promo",
) {
    var code by remember { mutableStateOf(initial?.code ?: "") }
    var title by remember { mutableStateOf(initial?.title ?: "") }
    var description by remember { mutableStateOf(initial?.description ?: "") }
    var discountType by remember { mutableStateOf(initial?.discountType ?: DiscountType.PERCENTAGE) }
    var discountAmount by remember { mutableStateOf(initial?.discountAmount?.takeIf { it > 0 }?.toString() ?: "") }
    var usageLimit by remember { mutableStateOf(initial?.usageLimit?.toString() ?: "-1") }
    var minimumPurchase by remember { mutableStateOf(initial?.minimumPurchase?.toString() ?: "0") }
    var validFrom by remember { mutableStateOf(initial?.validFrom?.takeIf { it.isNotBlank() } ?: LocalDate.now().toString()) }
    var validUntil by remember { mutableStateOf(initial?.validUntil?.takeIf { it.isNotBlank() } ?: LocalDate.now().plusMonths(3).toString()) }
    var isActive by remember { mutableStateOf(initial?.isActive ?: true) }
    var selectedServices by remember { mutableStateOf(initial?.applicableServiceIds?.toSet() ?: setOf<String>()) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        AuntieCard(
            modifier = Modifier.fillMaxWidth(0.95f).fillMaxHeight(0.9f),
            containerColor = AuntieTheme.colors.background
        ) {
            Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(titleText, style = AuntieTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                    AuntieIconBtn(onClick = onDismiss) { Icon(Lucide.X, contentDescription = "Close") }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                LazyColumn(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    item { AuntieField(value = code, onValueChange = { code = it.uppercase().replace(" ", "") }, label = "Promo Code *", modifier = Modifier.fillMaxWidth()) }
                    item { AuntieField(value = title, onValueChange = { title = it }, label = "Title", modifier = Modifier.fillMaxWidth()) }
                    item { AuntieField(value = description, onValueChange = { description = it }, label = "Description", modifier = Modifier.fillMaxWidth(), singleLine = false, minLines = 2) }

                    item {
                        Text("Discount Type", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary)
                        Spacer(Modifier.height(8.dp))
                        Column {
                            listOf(DiscountType.PERCENTAGE, DiscountType.FIXED_AMOUNT).forEach { type ->
                                Row(
                                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                                        .selectable(selected = discountType == type, onClick = { discountType = type }).padding(8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    AuntieRadio(selected = discountType == type, onClick = { discountType = type })
                                    Spacer(Modifier.width(8.dp))
                                    Text(type.name.replace("_", " "), color = AuntieTheme.colors.textPrimary)
                                }
                            }
                        }
                    }

                    item {
                        AuntieField(
                            value = discountAmount, onValueChange = { discountAmount = it },
                            label = if (discountType == DiscountType.PERCENTAGE) "Discount (%) *" else "Discount Amount ($) *",
                            modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
                        )
                    }
                    item { AuntieField(value = usageLimit, onValueChange = { usageLimit = it }, label = "Usage Limit (-1 unlimited)", modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)) }
                    item { AuntieField(value = minimumPurchase, onValueChange = { minimumPurchase = it }, label = "Minimum Purchase ($)", modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)) }
                    item { AuntieField(value = validFrom, onValueChange = { validFrom = it }, label = "Valid From (YYYY-MM-DD)", modifier = Modifier.fillMaxWidth()) }
                    item { AuntieField(value = validUntil, onValueChange = { validUntil = it }, label = "Valid Until (YYYY-MM-DD)", modifier = Modifier.fillMaxWidth()) }

                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AuntieCheckbox(checked = isActive, onCheckedChange = { isActive = it })
                            Text("Active Promo Code", modifier = Modifier.clickable { isActive = !isActive }, color = AuntieTheme.colors.textPrimary)
                        }
                    }

                    item { Text("Applies to Services (blank = all)", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary) }

                    items(baseServices) { service ->
                        Row(
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                                .selectable(selected = selectedServices.contains(service.id), onClick = {
                                    selectedServices = if (selectedServices.contains(service.id)) selectedServices - service.id else selectedServices + service.id
                                }).padding(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            AuntieCheckbox(
                                checked = selectedServices.contains(service.id),
                                onCheckedChange = { checked -> selectedServices = if (checked) selectedServices + service.id else selectedServices - service.id },
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(service.title, color = AuntieTheme.colors.textPrimary)
                        }
                    }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
                    PrimaryButton(
                        label = saveLabel,
                        onClick = {
                            onSave((initial ?: PromoCode()).copy(
                                code = code.trim(), title = title.trim(), description = description.trim(),
                                discountType = discountType, discountAmount = discountAmount.toDoubleOrNull() ?: 0.0,
                                isActive = isActive, usageLimit = usageLimit.toIntOrNull() ?: -1,
                                validFrom = validFrom.trim(), validUntil = validUntil.trim(),
                                applicableServiceIds = selectedServices.toList(),
                                minimumPurchase = minimumPurchase.toDoubleOrNull() ?: 0.0
                            ))
                        },
                        modifier = Modifier.weight(1f),
                        enabled = code.isNotBlank() && discountAmount.toDoubleOrNull() != null
                    )
                }
            }
        }
    }
}

@Composable
fun AdminSettingsCard(
    settings: BusinessSettings,
    onUpdate: (BusinessSettings) -> Unit
) {
    var editMode by remember { mutableStateOf(false) }
    var businessName by remember { mutableStateOf(settings.businessName) }
    var allowTimeBlock by remember { mutableStateOf(settings.allowTimeBlockBooking) }
    var allowSpecificTime by remember { mutableStateOf(settings.allowSpecificTimeBooking) }

    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("Business Settings", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                AuntieTextBtn(onClick = {
                    if (editMode) {
                        onUpdate(settings.copy(
                            businessName = businessName,
                            allowTimeBlockBooking = allowTimeBlock,
                            allowSpecificTimeBooking = allowSpecificTime
                        ))
                    }
                    editMode = !editMode
                }) {
                    Text(if (editMode) "Save" else "Edit")
                }
            }

            if (editMode) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AuntieField(value = businessName, onValueChange = { businessName = it }, label = "Business Name", modifier = Modifier.fillMaxWidth())

                    Text("Booking Modes", style = AuntieTheme.typography.titleSmall, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary)

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AuntieCheckbox(checked = allowSpecificTime, onCheckedChange = { allowSpecificTime = it })
                        Text("Allow specific time booking (11:15 AM)", modifier = Modifier.clickable { allowSpecificTime = !allowSpecificTime }, color = AuntieTheme.colors.textPrimary)
                    }

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AuntieCheckbox(checked = allowTimeBlock, onCheckedChange = { allowTimeBlock = it })
                        Text("Allow time block booking (11 AM - 3 PM)", modifier = Modifier.clickable { allowTimeBlock = !allowTimeBlock }, color = AuntieTheme.colors.textPrimary)
                    }
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SettingItem("Business Name", businessName)
                    SettingItem("Specific Time Booking", if (allowSpecificTime) "Enabled" else "Disabled")
                    SettingItem("Time Block Booking", if (allowTimeBlock) "Enabled" else "Disabled")
                }
            }
        }
    }
}

@Composable
fun SettingItem(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(text = label, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f))
        Text(text = value, style = AuntieTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary)
    }
}

@Composable
fun BusinessHoursCard(
    hours: BusinessHours,
    onSave: ((BusinessHours) -> Unit)? = null,
) {
    val dayNames = listOf("", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
    var showEditDialog by remember(hours.id) { mutableStateOf(false) }

    AuntieCard(
        modifier = Modifier.fillMaxWidth(),
        containerColor = if (hours.isOpen) AuntieTheme.colors.surface else AuntieTheme.colors.surface.copy(alpha = 0.6f)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = dayNames.getOrNull(hours.dayOfWeek) ?: "Unknown",
                style = AuntieTheme.typography.titleSmall,
                fontWeight = FontWeight.Medium,
                color = AuntieTheme.colors.textPrimary,
                modifier = Modifier.width(80.dp)
            )

            if (hours.isOpen) {
                Text(text = "${hours.openTime} - ${hours.closeTime}", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
            } else {
                Text(text = "Closed", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.6f))
            }

            AuntieIconBtn(onClick = { if (onSave != null) showEditDialog = true }) {
                Icon(Lucide.Pencil, contentDescription = "Edit Hours", tint = AuntieTheme.colors.kinfolkOrange, modifier = Modifier.size(18.dp))
            }
        }
    }

    if (showEditDialog && onSave != null) {
        EditBusinessHoursDialog(
            initial = hours,
            dayName = dayNames.getOrNull(hours.dayOfWeek) ?: "Unknown",
            onDismiss = { showEditDialog = false },
            onSave    = { edited ->
                onSave(edited)
                showEditDialog = false
            },
        )
    }
}

/**
 * Edit-hours dialog for a single BusinessHours day row. Pure data in/out -
 * caller wires the save back to the ServiceManagementViewModel which already
 * has updateBusinessHours wired to the Firestore writer. Time format is a
 * free-form HH:mm string today (matching the seed defaults); a proper time
 * picker is a separate UX polish pass.
 */
@Composable
private fun EditBusinessHoursDialog(
    initial: BusinessHours,
    dayName: String,
    onDismiss: () -> Unit,
    onSave: (BusinessHours) -> Unit,
) {
    var isOpen by remember(initial.id) { mutableStateOf(initial.isOpen) }
    var openTime by remember(initial.id) { mutableStateOf(initial.openTime) }
    var closeTime by remember(initial.id) { mutableStateOf(initial.closeTime) }
    var breakStart by remember(initial.id) { mutableStateOf(initial.breakStart.orEmpty()) }
    var breakEnd by remember(initial.id) { mutableStateOf(initial.breakEnd.orEmpty()) }
    var notes by remember(initial.id) { mutableStateOf(initial.notes) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        AuntieCard(
            modifier = Modifier.fillMaxWidth(0.95f),
            containerColor = AuntieTheme.colors.background,
        ) {
            Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    Text(
                        text       = "Edit $dayName Hours",
                        style      = AuntieTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color      = AuntieTheme.colors.textPrimary,
                    )
                    AuntieIconBtn(onClick = onDismiss) {
                        Icon(Lucide.X, contentDescription = "Close")
                    }
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AuntieCheckbox(checked = isOpen, onCheckedChange = { isOpen = it })
                        Text(
                            "Open this day",
                            modifier = Modifier.clickable { isOpen = !isOpen },
                            color    = AuntieTheme.colors.textPrimary,
                        )
                    }

                    if (isOpen) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AuntieField(
                                value         = openTime,
                                onValueChange = { openTime = it },
                                label         = "Open (HH:mm)",
                                modifier      = Modifier.weight(1f),
                            )
                            AuntieField(
                                value         = closeTime,
                                onValueChange = { closeTime = it },
                                label         = "Close (HH:mm)",
                                modifier      = Modifier.weight(1f),
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AuntieField(
                                value         = breakStart,
                                onValueChange = { breakStart = it },
                                label         = "Break start (optional)",
                                modifier      = Modifier.weight(1f),
                            )
                            AuntieField(
                                value         = breakEnd,
                                onValueChange = { breakEnd = it },
                                label         = "Break end (optional)",
                                modifier      = Modifier.weight(1f),
                            )
                        }
                    }

                    AuntieField(
                        value         = notes,
                        onValueChange = { notes = it },
                        label         = "Notes",
                        singleLine    = false,
                        minLines      = 2,
                        maxLines      = 4,
                        modifier      = Modifier.fillMaxWidth(),
                    )
                }

                Box(modifier = Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))

                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
                    PrimaryButton(
                        label   = "Save",
                        onClick = {
                            onSave(
                                initial.copy().apply {
                                    this.isOpen      = isOpen
                                    this.openTime    = openTime.trim()
                                    this.closeTime   = closeTime.trim()
                                    this.breakStart  = breakStart.trim().takeIf { it.isNotBlank() }
                                    this.breakEnd    = breakEnd.trim().takeIf { it.isNotBlank() }
                                    this.notes       = notes.trim()
                                },
                            )
                        },
                        // Validation: if marked open, both times must be filled.
                        enabled  = !isOpen || (openTime.isNotBlank() && closeTime.isNotBlank()),
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}
