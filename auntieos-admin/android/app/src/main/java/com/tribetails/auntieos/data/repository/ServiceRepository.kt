package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.tasks.await
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

class ServiceRepository() {

    private val firestore = FirebaseFirestore.getInstance()

    // === Base Services ===

    suspend fun createBaseService(service: BaseService): Result<String> = runCatching {
        AuntieLog.i("Creating base service: ${service.title}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val serviceWithTimestamp = service.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = if (service.id.isBlank()) {
            firestore.collection("base_services").document()
        } else {
            firestore.collection("base_services").document(service.id)
        }

        docRef.set(serviceWithTimestamp).await()
        AuntieLog.d("Base service created/updated with ID: ${docRef.id}")
        docRef.id
    }.onFailure { AuntieLog.e("Error creating base service", it) }

    suspend fun getBaseServices(includeInactive: Boolean = false): Result<List<BaseService>> = runCatching {
        AuntieLog.d("Fetching base services (includeInactive: $includeInactive)")
        var query: Query = firestore.collection("base_services")

        if (!includeInactive) {
            query = query.whereEqualTo("isActive", true)
        }

        val snapshot = query.get().await()
        snapshot.toObjects(BaseService::class.java).also {
            AuntieLog.d("Retrieved ${it.size} base services")
        }
    }.onFailure { AuntieLog.e("Error fetching base services", it) }

    suspend fun getBaseServiceById(serviceId: String): Result<BaseService?> = runCatching {
        AuntieLog.d("Fetching base service by ID: $serviceId")
        val document = firestore.collection("base_services").document(serviceId).get().await()
        document.toObject(BaseService::class.java).also {
            if (it == null) AuntieLog.w("Base service $serviceId not found")
        }
    }.onFailure { AuntieLog.e("Error fetching base service $serviceId", it) }

    suspend fun updateBaseService(service: BaseService): Result<Unit> = runCatching {
        AuntieLog.i("Updating base service: ${service.id}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val serviceWithTimestamp = service.copy(updatedAt = now)

        firestore.collection("base_services").document(service.id)
            .set(serviceWithTimestamp).await()
        Unit
    }.onFailure { AuntieLog.e("Error updating base service ${service.id}", it) }

    suspend fun deleteBaseService(serviceId: String): Result<Unit> = runCatching {
        AuntieLog.w("Soft deleting base service: $serviceId")
        val updates = mapOf(
            "isActive" to false,
            "updatedAt" to LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        )

        firestore.collection("base_services").document(serviceId)
            .update(updates).await()
        Unit
    }.onFailure { AuntieLog.e("Error deleting base service $serviceId", it) }

    // === Supplemental Services ===

    suspend fun createSupplementalService(service: SupplementalService): Result<String> = runCatching {
        AuntieLog.i("Creating supplemental service: ${service.title}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val serviceWithTimestamp = service.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = if (service.id.isBlank()) {
            firestore.collection("supplemental_services").document()
        } else {
            firestore.collection("supplemental_services").document(service.id)
        }

        docRef.set(serviceWithTimestamp).await()
        AuntieLog.d("Supplemental service created/updated with ID: ${docRef.id}")
        docRef.id
    }.onFailure { AuntieLog.e("Error creating supplemental service", it) }

    suspend fun getSupplementalServices(includeInactive: Boolean = false): Result<List<SupplementalService>> = runCatching {
        AuntieLog.d("Fetching supplemental services (includeInactive: $includeInactive)")
        var query: Query = firestore.collection("supplemental_services")

        if (!includeInactive) {
            query = query.whereEqualTo("isActive", true)
        }

        val snapshot = query.get().await()
        snapshot.toObjects(SupplementalService::class.java).also {
            AuntieLog.d("Retrieved ${it.size} supplemental services")
        }
    }.onFailure { AuntieLog.e("Error fetching supplemental services", it) }

    suspend fun getSupplementalServicesForBaseService(baseServiceId: String): Result<List<SupplementalService>> = runCatching {
        AuntieLog.d("Fetching supplemental services for base service $baseServiceId")
        val snapshot = firestore.collection("supplemental_services")
            .whereEqualTo("isActive", true)
            .whereArrayContains("canAttachToServices", baseServiceId)
            .get().await()

        snapshot.toObjects(SupplementalService::class.java).also {
            AuntieLog.d("Retrieved ${it.size} supplemental services for base service $baseServiceId")
        }
    }.onFailure { AuntieLog.e("Error fetching supplemental services for base service $baseServiceId", it) }

    // === Surcharges ===

    suspend fun createSurcharge(surcharge: Surcharge): Result<String> = runCatching {
        AuntieLog.i("Creating surcharge: ${surcharge.title}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val surchargeWithTimestamp = surcharge.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = if (surcharge.id.isBlank()) {
            firestore.collection("surcharges").document()
        } else {
            firestore.collection("surcharges").document(surcharge.id)
        }

        docRef.set(surchargeWithTimestamp).await()
        docRef.id
    }.onFailure { AuntieLog.e("Error creating surcharge", it) }

    suspend fun getSurcharges(includeInactive: Boolean = false): Result<List<Surcharge>> = runCatching {
        AuntieLog.d("Fetching surcharges")
        var query: Query = firestore.collection("surcharges")
        if (!includeInactive) query = query.whereEqualTo("isActive", true)

        val snapshot = query.get().await()
        snapshot.toObjects(Surcharge::class.java)
    }.onFailure { AuntieLog.e("Error fetching surcharges", it) }

    /** Edit an existing surcharge (rules allow `write: if isAuntie()`). Full set of
     *  the pre-filled record preserves createdAt; only updatedAt is refreshed. */
    suspend fun updateSurcharge(surcharge: Surcharge): Result<Unit> = runCatching {
        AuntieLog.i("Updating surcharge: ${surcharge.id}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        firestore.collection("surcharges").document(surcharge.id)
            .set(surcharge.copy(updatedAt = now)).await()
        Unit
    }.onFailure { AuntieLog.e("Error updating surcharge ${surcharge.id}", it) }

    // === Discounts ===

    suspend fun createDiscount(discount: Discount): Result<String> = runCatching {
        AuntieLog.i("Creating discount: ${discount.title}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val discountWithTimestamp = discount.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = if (discount.id.isBlank()) {
            firestore.collection("discounts").document()
        } else {
            firestore.collection("discounts").document(discount.id)
        }

        docRef.set(discountWithTimestamp).await()
        docRef.id
    }.onFailure { AuntieLog.e("Error creating discount", it) }

    suspend fun getDiscounts(includeInactive: Boolean = false): Result<List<Discount>> = runCatching {
        AuntieLog.d("Fetching discounts")
        var query: Query = firestore.collection("discounts")
        if (!includeInactive) query = query.whereEqualTo("isActive", true)

        val snapshot = query.get().await()
        snapshot.toObjects(Discount::class.java)
    }.onFailure { AuntieLog.e("Error fetching discounts", it) }

    /** Edit an existing discount (rules allow `write: if isAuntie()`). */
    suspend fun updateDiscount(discount: Discount): Result<Unit> = runCatching {
        AuntieLog.i("Updating discount: ${discount.id}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        firestore.collection("discounts").document(discount.id)
            .set(discount.copy(updatedAt = now)).await()
        Unit
    }.onFailure { AuntieLog.e("Error updating discount ${discount.id}", it) }

    // === Promo Codes ===

    suspend fun createPromoCode(promoCode: PromoCode): Result<String> = runCatching {
        AuntieLog.i("Creating promo code: ${promoCode.code}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val promoCodeWithTimestamp = promoCode.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = if (promoCode.id.isBlank()) {
            firestore.collection("promo_codes").document()
        } else {
            firestore.collection("promo_codes").document(promoCode.id)
        }

        docRef.set(promoCodeWithTimestamp).await()
        docRef.id
    }.onFailure { AuntieLog.e("Error creating promo code", it) }

    /** Edit an existing promo code (rules allow `write: if isAuntie()`). */
    suspend fun updatePromoCode(promoCode: PromoCode): Result<Unit> = runCatching {
        AuntieLog.i("Updating promo code: ${promoCode.id}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        firestore.collection("promo_codes").document(promoCode.id)
            .set(promoCode.copy(updatedAt = now)).await()
        Unit
    }.onFailure { AuntieLog.e("Error updating promo code ${promoCode.id}", it) }

    suspend fun getPromoCodeByCode(code: String): Result<PromoCode?> = runCatching {
        AuntieLog.d("Fetching promo code: $code")
        val snapshot = firestore.collection("promo_codes")
            .whereEqualTo("code", code)
            .whereEqualTo("isActive", true)
            .limit(1)
            .get().await()

        snapshot.documents.firstOrNull()?.toObject(PromoCode::class.java)
    }.onFailure { AuntieLog.e("Error fetching promo code $code", it) }

    suspend fun getPromoCodes(includeInactive: Boolean = false): Result<List<PromoCode>> = runCatching {
        AuntieLog.d("Fetching all promo codes")
        var query: Query = firestore.collection("promo_codes")
        if (!includeInactive) query = query.whereEqualTo("isActive", true)

        val snapshot = query.get().await()
        snapshot.toObjects(PromoCode::class.java)
    }.onFailure { AuntieLog.e("Error fetching promo codes", it) }

    // === Business Hours & Settings ===

    suspend fun getBusinessHours(): Result<List<BusinessHours>> = runCatching {
        AuntieLog.d("Fetching business hours")
        val snapshot = firestore.collection("business_hours")
            .orderBy("dayOfWeek")
            .get().await()

        val businessHours = snapshot.toObjects(BusinessHours::class.java)

        if (businessHours.isEmpty()) {
            AuntieLog.i("No business hours found, creating defaults")
            val defaultHours = (1..7).map { dayOfWeek ->
                BusinessHours(
                    dayOfWeek = dayOfWeek,
                    isOpen = dayOfWeek <= 5,
                    openTime = "09:00",
                    closeTime = "17:00"
                )
            }
            defaultHours.forEach { firestore.collection("business_hours").add(it) }
            defaultHours
        } else {
            businessHours
        }
    }.onFailure { AuntieLog.e("Error fetching business hours", it) }

    suspend fun updateBusinessHours(businessHours: List<BusinessHours>): Result<Unit> = runCatching {
        AuntieLog.i("Updating business hours")
        businessHours.forEach { hours ->
            if (hours.id.isBlank()) {
                firestore.collection("business_hours").add(hours).await()
            } else {
                firestore.collection("business_hours").document(hours.id)
                    .set(hours).await()
            }
        }
        Unit
    }.onFailure { AuntieLog.e("Error updating business hours", it) }

    // getAdminSettings / updateAdminSettings removed 2026-06-05 (settings
    // unification). The admin_settings doc collapsed into the unified
    // business_settings/business_settings doc; read/write via
    // AuntieRepository.getBusinessSettings / updateBusinessSettingsFields.
}
