package com.tribetails.auntieos.ui.admin.services

import com.tribetails.auntieos.ui.admin.settingsSaveFailureText
import com.tribetails.auntieos.ui.admin.WeeklyHoursRow
import com.tribetails.auntieos.ui.admin.weeklyHoursPatch
import com.tribetails.auntieos.ui.admin.weeklyHoursRows
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import com.tribetails.auntieos.util.rethrowIfCancellation

data class ServiceManagementState(
    val baseServices: List<BaseService> = emptyList(),
    val supplementalServices: List<SupplementalService> = emptyList(),
    val surcharges: List<Surcharge> = emptyList(),
    val discounts: List<Discount> = emptyList(),
    val promoCodes: List<PromoCode> = emptyList(),
    // Unified settings (2026-06-05): the former AdminSettings is now part of
    // BusinessSettings on the single business_settings doc.
    val businessSettings: BusinessSettings = BusinessSettings(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val selectedTab: ServiceTab = ServiceTab.BASE_SERVICES
) {
    /**
     * #1764: the week, Monday first, as `business_settings.businessHours` holds
     * it: the same map the Settings panel, the web and the phone line read.
     * Derived, so it is always what was last loaded or saved.
     */
    val businessHours: List<WeeklyHoursRow> get() = weeklyHoursRows(businessSettings.businessHours)
}

enum class ServiceTab(val displayName: String) {
    BASE_SERVICES("Base Services"),
    SUPPLEMENTAL("Add-ons"),
    PRICING("Pricing"),
    SETTINGS("Settings")
}

class ServiceManagementViewModel(
    private val serviceRepository: ServiceRepository,
    private val auntieRepository: AuntieRepository = com.tribetails.auntieos.AuntieOSApp.instance.repository
) : ViewModel() {

    private val _state = MutableStateFlow(ServiceManagementState())
    val state: StateFlow<ServiceManagementState> = _state.asStateFlow()

    /**
     * The settings document as Firestore handed it over, and the only thing
     * [updateBusinessSettings] may diff against. Null until a load SUCCEEDS: the
     * state below falls back to `BusinessSettings()` so the panels can render, and
     * saving that fallback would put ~46 Kotlin defaults over the real document.
     * Advances only after a write the server accepted.
     */
    private var settingsBaseline: BusinessSettings? = null

    init {
        loadAllData()
    }

    fun loadAllData() {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true, errorMessage = null)

            try {
                // Load all service-related data in parallel
                val baseServicesResult = serviceRepository.getBaseServices(includeInactive = true)
                val supplementalServicesResult = serviceRepository.getSupplementalServices(includeInactive = true)
                val surchargesResult = serviceRepository.getSurcharges(includeInactive = true)
                val discountsResult = serviceRepository.getDiscounts(includeInactive = true)
                val promoCodesResult = serviceRepository.getPromoCodes(includeInactive = true)
                val businessSettingsResult = auntieRepository.getBusinessSettings()
                businessSettingsResult.onSuccess { settingsBaseline = it }

                _state.value = _state.value.copy(
                    baseServices = baseServicesResult.getOrNull() ?: emptyList(),
                    supplementalServices = supplementalServicesResult.getOrNull() ?: emptyList(),
                    surcharges = surchargesResult.getOrNull() ?: emptyList(),
                    discounts = discountsResult.getOrNull() ?: emptyList(),
                    promoCodes = promoCodesResult.getOrNull() ?: emptyList(),
                    businessSettings = businessSettingsResult.getOrNull() ?: BusinessSettings(),
                    isLoading = false
                )
            } catch (e: Exception) {
                e.rethrowIfCancellation()
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to load data: ${e.message}"
                )
            }
        }
    }

    fun selectTab(tab: ServiceTab) {
        _state.value = _state.value.copy(selectedTab = tab)
    }

    // === Base Services ===

    fun createBaseService(service: BaseService) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.createBaseService(service)

            if (result.isSuccess) {
                loadBaseServices() // Refresh the list
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to create service: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    /**
     * Saves a base-service edit as a DIFF against the copy Firestore handed us.
     *
     * The baseline is the row in [ServiceManagementState.baseServices] with the
     * same id - the loaded copy the edit dialog was seeded from, never a
     * re-read: re-reading to diff would hand back exactly the concurrent edit
     * this is protecting. A baseline that has gone missing (the list reloaded
     * out from under an open dialog) fails loud rather than falling back to a
     * default model and writing ten Kotlin defaults over a real service.
     *
     * Nothing changed means nothing is written, not even the stamp, and no audit
     * entry claiming an edit that did not happen. The baseline advances via
     * [loadBaseServices] only after a save the server accepted.
     */
    fun updateBaseService(service: BaseService) {
        viewModelScope.launch {
            val loaded = _state.value.baseServices.firstOrNull { it.id == service.id }
            if (loaded == null) {
                _state.value = _state.value.copy(
                    isLoading = false,
                    // The title, not the document id: the operator is looking at
                    // a service list, and "svc-1" names nothing they can see.
                    errorMessage = "\"${service.title}\" is no longer loaded. Reopen it and try again.",
                )
                return@launch
            }

            val changes = baseServiceFieldChanges(loaded, service)
            if (changes.isEmpty()) {
                _state.value = _state.value.copy(isLoading = false, errorMessage = null)
                return@launch
            }

            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.updateBaseServiceFields(service.id, changes)

            if (result.isSuccess) {
                loadBaseServices() // Refresh the list
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    // The repository this ViewModel is already handed, not
                    // AuntieOSApp.instance.repository. Reaching past it for the
                    // global is why no test could reach this success branch at
                    // all: the lateinit throws off-device.
                    repository       = auntieRepository,
                    actionType       = "BASE_SERVICE_UPDATED",
                    description      = "Updated base service \"${service.title}\"",
                    targetId         = service.id,
                    targetCollection = "base_services",
                )
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to update service: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    fun deleteBaseService(serviceId: String) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.deleteBaseService(serviceId)

            if (result.isSuccess) {
                loadBaseServices() // Refresh the list
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to delete service: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    private fun loadBaseServices() {
        viewModelScope.launch {
            val result = serviceRepository.getBaseServices(includeInactive = true)
            if (result.isSuccess) {
                _state.value = _state.value.copy(
                    baseServices = result.getOrNull() ?: emptyList(),
                    isLoading = false
                )
            }
        }
    }

    // === Supplemental Services ===

    fun createSupplementalService(service: SupplementalService) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.createSupplementalService(service)

            if (result.isSuccess) {
                loadSupplementalServices()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to create supplemental service: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    private fun loadSupplementalServices() {
        viewModelScope.launch {
            val result = serviceRepository.getSupplementalServices(includeInactive = true)
            if (result.isSuccess) {
                _state.value = _state.value.copy(
                    supplementalServices = result.getOrNull() ?: emptyList(),
                    isLoading = false
                )
            }
        }
    }

    // === Surcharges ===

    fun createSurcharge(surcharge: Surcharge) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.createSurcharge(surcharge)

            if (result.isSuccess) {
                loadSurcharges()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to create surcharge: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    fun updateSurcharge(surcharge: Surcharge) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.updateSurcharge(surcharge)

            if (result.isSuccess) {
                loadSurcharges()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to update surcharge: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    private fun loadSurcharges() {
        viewModelScope.launch {
            val result = serviceRepository.getSurcharges(includeInactive = true)
            if (result.isSuccess) {
                _state.value = _state.value.copy(
                    surcharges = result.getOrNull() ?: emptyList(),
                    isLoading = false
                )
            }
        }
    }

    // === Discounts ===

    fun createDiscount(discount: Discount) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.createDiscount(discount)

            if (result.isSuccess) {
                loadDiscounts()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to create discount: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    fun updateDiscount(discount: Discount) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.updateDiscount(discount)

            if (result.isSuccess) {
                loadDiscounts()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to update discount: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    private fun loadDiscounts() {
        viewModelScope.launch {
            val result = serviceRepository.getDiscounts(includeInactive = true)
            if (result.isSuccess) {
                _state.value = _state.value.copy(
                    discounts = result.getOrNull() ?: emptyList(),
                    isLoading = false
                )
            }
        }
    }

    // === Promo Codes ===

    fun createPromoCode(promoCode: PromoCode) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.createPromoCode(promoCode)

            if (result.isSuccess) {
                loadPromoCodes()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to create promo code: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    fun updatePromoCode(promoCode: PromoCode) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.updatePromoCode(promoCode)

            if (result.isSuccess) {
                loadPromoCodes()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to update promo code: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    private fun loadPromoCodes() {
        viewModelScope.launch {
            val result = serviceRepository.getPromoCodes(includeInactive = true)
            if (result.isSuccess) {
                _state.value = _state.value.copy(
                    promoCodes = result.getOrNull() ?: emptyList(),
                    isLoading = false
                )
            }
        }
    }

    // === Settings ===

    /**
     * #1764: save one day from the Edit hours dialog to
     * `business_settings.businessHours`, through [updateBusinessSettings] and
     * so through the `saveBusinessSettings` callable, which merges the map day
     * by day. Only this day is sent, and only when it changed.
     *
     * Refused with the day's sentence when the row does not save; the dialog
     * keeps Save off then, so this is the guard behind it.
     */
    fun updateBusinessHours(row: WeeklyHoursRow) {
        val problem = row.problem
        if (problem != null) {
            _state.value = _state.value.copy(errorMessage = "${row.dayName}: $problem")
            return
        }
        val baseline = settingsBaseline
        if (baseline == null) {
            _state.value = _state.value.copy(
                isLoading = false,
                errorMessage = "Reopen Services before saving: the settings doc was never loaded.",
            )
            return
        }
        val patch = weeklyHoursPatch(baseline.businessHours, listOf(row))
        if (patch.isEmpty()) return
        val current = _state.value.businessSettings
        updateBusinessSettings(current.copy(businessHours = current.businessHours + patch))
    }

    /**
     * Persist ONLY the settings fields this screen changed.
     *
     * `business_settings` is one document shared with the Settings screen, the
     * Scheduling screen and the React admin, which patches it per section
     * (`auntieos-admin/src/api/settingsWrite.ts`). This used to write the whole
     * model under `SetOptions.merge()`, which protects fields outside the written
     * map and does nothing about stale ones inside it, so every field the phone
     * had read reverted whatever changed since. See `BusinessSettingsDiff.kt`.
     *
     * An empty diff writes nothing, not even the stamp: moving `updatedAt` for a
     * save that changed nothing makes it lie about when the doc last changed.
     */
    fun updateBusinessSettings(settings: BusinessSettings) {
        val baseline = settingsBaseline
        if (baseline == null) {
            _state.value = _state.value.copy(
                isLoading = false,
                errorMessage = "Reopen Services before saving: the settings doc was never loaded.",
            )
            return
        }
        val changes = businessSettingsFieldChanges(baseline, settings)
        if (changes.isEmpty()) {
            _state.value = _state.value.copy(businessSettings = settings, isLoading = false)
            return
        }
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = auntieRepository.updateBusinessSettingsFields(changes)

            if (result.isSuccess) {
                // The baseline moves to what the server now holds; without it a
                // second save re-sends the first save's fields.
                settingsBaseline = settings
                _state.value = _state.value.copy(
                    businessSettings = settings,
                    isLoading = false
                )
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = result.exceptionOrNull()?.let { settingsSaveFailureText("Failed to update settings", it) }
                        ?: "Failed to update settings"
                )
            }
        }
    }

    fun clearError() {
        _state.value = _state.value.copy(errorMessage = null)
    }
}
