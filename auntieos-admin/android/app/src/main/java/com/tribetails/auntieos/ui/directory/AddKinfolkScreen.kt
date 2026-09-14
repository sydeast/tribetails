package com.tribetails.auntieos.ui.directory

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.components.AddressAutocompleteField
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.util.emailOkOrBlank
import com.tribetails.auntieos.util.phoneOkOrBlank
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun AddKinfolkScreen(
    viewModel: DirectoryViewModel,
    onBack: () -> Unit,
    onSaved: () -> Unit
) {
    val state by viewModel.addKinfolkState.collectAsState()

    LaunchedEffect(state.isSuccess) {
        if (state.isSuccess) {
            onSaved()
        }
    }

    AuntieScreenScaffold(
        title = "Add Kinfolk",
        onBack = onBack,
        imePaddingEnabled = true,
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            contentPadding = PaddingValues(vertical = 16.dp)
        ) {
            // Basic Information
            item {
                AuntieCard(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            "BASIC INFORMATION",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.kinfolkOrange
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            AuntieField(
                                value = state.firstName,
                                onValueChange = viewModel::updateFirstName,
                                label = "First Name",
                                modifier = Modifier.weight(1f),
                            )
                            AuntieField(
                                value = state.lastName,
                                onValueChange = viewModel::updateLastName,
                                label = "Last Name",
                                modifier = Modifier.weight(1f),
                            )
                        }

                        AuntieField(
                            value = state.phoneNumber,
                            onValueChange = viewModel::updatePhoneNumber,
                            label = "Primary Phone *",
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                        )

                        AuntieField(
                            value = state.email,
                            onValueChange = viewModel::updateEmail,
                            label = "Email",
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                        )
                    }
                }
            }

            // Contact & Preferences
            item {
                AuntieCard(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            "CONTACT & PREFERENCES",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.kinfolkOrange
                        )

                        AuntieField(
                            value = state.secondaryPhone,
                            onValueChange = viewModel::updateSecondaryPhone,
                            label = "Secondary Phone",
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                        )

                        // item 2: Preferred contact method editor removed (Auntie complaint).

                        StatusChips(
                            selected = state.status,
                            onSelect = viewModel::updateAddStatus,
                        )

                        // Mapbox lookup runs through the mapboxSearch /
                        // mapboxRetrieve callables; the view model owns the
                        // debounce and the session token. No key in this app.
                        val addressSuggestions by viewModel.addressSuggestions.collectAsState()
                        val addressError by viewModel.addressError.collectAsState()
                        AddressAutocompleteField(
                            value = state.serviceAddress,
                            onValueChange = viewModel::updateServiceAddress,
                            suggestions = addressSuggestions,
                            onQueryChange = viewModel::queryAddressSuggestions,
                            onPick = viewModel::pickAddressSuggestionForAdd,
                            errorMessage = addressError,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }

            // Home & Access
            item {
                AuntieCard(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            "HOME & ACCESS",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.kinfolkOrange
                        )

                        AuntieField(
                            value = state.gateCode,
                            onValueChange = viewModel::updateGateCode,
                            label = "Gate Code",
                            modifier = Modifier.fillMaxWidth(),
                        )

                        AuntieField(
                            value = state.entryNotes,
                            onValueChange = viewModel::updateEntryNotes,
                            label = "Entry Notes",
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = false,
                            minLines = 2,
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            AuntieField(
                                value = state.wifiName,
                                onValueChange = viewModel::updateWifiName,
                                label = "WiFi Name",
                                modifier = Modifier.weight(1f),
                            )
                            AuntieField(
                                value = state.wifiPassword,
                                onValueChange = viewModel::updateWifiPassword,
                                label = "WiFi Password",
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }

            // Emergency Contact. Required to create the household (#829): a
            // household with none is a defect state the Add flow must never
            // produce.
            item {
                AuntieCard(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            "EMERGENCY CONTACT",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.kinfolkOrange
                        )

                        EmergencyContactsEditor(
                            drafts = state.emergencyContacts,
                            onChange = viewModel::updateAddEmergencyContact,
                            onAdd = viewModel::addAddEmergencyContact,
                            onRemove = viewModel::removeAddEmergencyContact,
                            onMoveFirst = viewModel::moveAddEmergencyContactFirst,
                            enabled = !state.isSaving,
                        )
                    }
                }
            }

            // Internal Notes
            item {
                AuntieCard(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            "INTERNAL NOTES",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.kinfolkOrange
                        )

                        AuntieField(
                            value = state.internalNotes,
                            onValueChange = viewModel::updateInternalNotes,
                            label = "Internal Notes",
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = false,
                            minLines = 3,
                        )
                    }
                }
            }

            // Error Message
            if (state.error != null) {
                item {
                    AuntieCard(
                        modifier = Modifier.fillMaxWidth(),
                        containerColor = AuntieTheme.colors.errorContainer,
                        border = null,
                    ) {
                        Text(
                            text = state.error!!,
                            modifier = Modifier.padding(16.dp),
                            color = AuntieTheme.colors.error
                        )
                    }
                }
            }

            // Single Save button (matches web canonical - status = prospect when
            // incomplete, active when full; no separate draft path).
            item {
                // item 3: service address required. Emergency Contacts are
                // validated by the view model (validateEmergencyContactDrafts).
                val canSave = !state.isSaving && state.firstName.isNotBlank() &&
                    phoneOkOrBlank(state.phoneNumber) && phoneOkOrBlank(state.secondaryPhone) &&
                    emailOkOrBlank(state.email) &&
                    state.serviceAddress.isNotBlank()
                PrimaryButton(
                    label    = if (state.createdKinfolkId != null) "Save Emergency Contact" else "Save",
                    onClick  = viewModel::saveKinfolk,
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                    enabled  = canSave,
                    loading  = state.isSaving,
                )
            }
        }
    }
}

@Composable
private fun StatusChips(selected: String, onSelect: (String) -> Unit) {
    val options = listOf("prospect", "active")
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text  = "STATUS",
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.kinfolkOrange,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { option ->
                AuntieChip(
                    selected = option == selected,
                    onClick  = { onSelect(option) },
                    label    = option.replaceFirstChar { it.uppercaseChar() },
                )
            }
        }
    }
}
