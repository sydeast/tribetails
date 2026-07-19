package com.tribetails.auntieos.ui.admin.services

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

data class ServiceManagementState(
    val baseServices: List<BaseService> = emptyList(),
    val supplementalServices: List<SupplementalService> = emptyList(),
    val surcharges: List<Surcharge> = emptyList(),
    val discounts: List<Discount> = emptyList(),
    val promoCodes: List<PromoCode> = emptyList(),
    val businessHours: List<BusinessHours> = emptyList(),
    // Unified settings (2026-06-05): the former AdminSettings is now part of
    // BusinessSettings on the single business_settings doc.
    val businessSettings: BusinessSettings = BusinessSettings(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val selectedTab: ServiceTab = ServiceTab.BASE_SERVICES
)

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
                val businessHoursResult = serviceRepository.getBusinessHours()
                val businessSettingsResult = auntieRepository.getBusinessSettings()

                _state.value = _state.value.copy(
                    baseServices = baseServicesResult.getOrNull() ?: emptyList(),
                    supplementalServices = supplementalServicesResult.getOrNull() ?: emptyList(),
                    surcharges = surchargesResult.getOrNull() ?: emptyList(),
                    discounts = discountsResult.getOrNull() ?: emptyList(),
                    promoCodes = promoCodesResult.getOrNull() ?: emptyList(),
                    businessHours = businessHoursResult.getOrNull() ?: emptyList(),
                    businessSettings = businessSettingsResult.getOrNull() ?: BusinessSettings(),
                    isLoading = false
                )
            } catch (e: Exception) {
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

    fun updateBaseService(service: BaseService) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.updateBaseService(service)

            if (result.isSuccess) {
                loadBaseServices() // Refresh the list
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = com.tribetails.auntieos.AuntieOSApp.instance.repository,
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

    fun updateBusinessHours(businessHours: List<BusinessHours>) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = serviceRepository.updateBusinessHours(businessHours)

            if (result.isSuccess) {
                _state.value = _state.value.copy(
                    businessHours = businessHours,
                    isLoading = false
                )
                // Audit each row update with day index so the activity log
                // can be filtered to "which day changed when". Fire-and-forget;
                // audit failure doesn't block the UI per AuditLog contract.
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = com.tribetails.auntieos.AuntieOSApp.instance.repository,
                    actionType       = "BUSINESS_HOURS_UPDATED",
                    description      = "Updated business hours (${businessHours.size} day rows)",
                    targetCollection = "business_hours",
                )
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to update business hours: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    fun updateBusinessSettings(settings: BusinessSettings) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = auntieRepository.saveBusinessSettings(settings)

            if (result.isSuccess) {
                _state.value = _state.value.copy(
                    businessSettings = settings,
                    isLoading = false
                )
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to update settings: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    fun clearError() {
        _state.value = _state.value.copy(errorMessage = null)
    }
}
