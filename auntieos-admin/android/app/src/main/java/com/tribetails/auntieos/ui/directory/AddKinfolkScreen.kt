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
import androidx.compose.ui.draw.alpha
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
    // #829 Fix round 1: once the household exists (a retry after a failed
    // contact save), every household field locks - only the Emergency
    // Contact editor stays live, the one thing a retry exists to fix. Web
    // locks the same fields (`AddKinfolkDialog.tsx`, `disabled={saving ||
    // createdId !== null}`); the view model's own updaters already refuse
    // these edits (see `updateAddHouseholdField`), so this is belt and
    // braces, not the only guard.
    val householdFieldsEnabled = !state.isSaving && state.createdKinfolkId == null

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
                                enabled = householdFieldsEnabled,
                                modifier = Modifier.weight(1f),
                            )
                            AuntieField(
                                value = state.lastName,
                                onValueChange = viewModel::updateLastName,
                                label = "Last Name",
                                enabled = householdFieldsEnabled,
                                modifier = Modifier.weight(1f),
                            )
                        }

                        AuntieField(
                            value = state.phoneNumber,
                            onValueChange = viewModel::updatePhoneNumber,
                            label = "Primary Phone *",
                            enabled = householdFieldsEnabled,
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                        )

                        AuntieField(
                            value = state.email,
                            onValueChange = viewModel::updateEmail,
                            label = "Email",
                            enabled = householdFieldsEnabled,
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
                            enabled = householdFieldsEnabled,
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                        )

                        // item 2: Preferred contact method editor removed (Auntie complaint).

                        // AuntieChip has no `enabled` param, and the view
                        // model's own guard already refuses this edit while
                        // locked (`updateAddStatus` routes through
                        // `updateAddHouseholdField`), so the dim below is
                        // belt-and-braces UI feedback, not the only guard.
                        Box(modifier = Modifier.alpha(if (householdFieldsEnabled) 1f else 0.5f)) {
                            StatusChips(
                                selected = state.status,
                                onSelect = viewModel::updateAddStatus,
                            )
                        }

                        // Mapbox lookup runs through the mapboxSearch /
                        // mapboxRetrieve callables; the view model owns the
                        // debounce and the session token. No key in this app.
                        val addressSuggestions by viewModel.addressSuggestions.collectAsState()
                        val addressError by viewModel.addressError.collectAsState()
                        // AddressAutocompleteField has no `enabled` param
                        // either; same belt-and-braces dim. `updateServiceAddress`
                        // and `pickAddressSuggestionForAdd` (the two calls that
                        // can actually change `serviceAddress`) both refuse the
                        // write while locked in the view model.
                        Box(modifier = Modifier.alpha(if (householdFieldsEnabled) 1f else 0.5f)) {
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
                            enabled = householdFieldsEnabled,
                            modifier = Modifier.fillMaxWidth(),
                        )

                        AuntieField(
                            value = state.entryNotes,
                            onValueChange = viewModel::updateEntryNotes,
                            label = "Entry Notes",
                            enabled = householdFieldsEnabled,
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
                                enabled = householdFieldsEnabled,
                                modifier = Modifier.weight(1f),
                            )
                            AuntieField(
                                value = state.wifiPassword,
                                onValueChange = viewModel::updateWifiPassword,
                                label = "WiFi Password",
                                enabled = householdFieldsEnabled,
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
                // #829 review item 14: titled "Emergency Contacts", the same
                // card Edit Kinfolk shows.
                EmergencyContactsSection(
                    drafts = state.emergencyContacts,
                    onChange = viewModel::updateAddEmergencyContact,
                    onAdd = viewModel::addAddEmergencyContact,
                    onRemove = viewModel::removeAddEmergencyContact,
                    onMoveFirst = viewModel::moveAddEmergencyContactFirst,
                    enabled = !state.isSaving,
                    showNoneOnFile = state.createdKinfolkId != null,
                )
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
                            enabled = householdFieldsEnabled,
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
