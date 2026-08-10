package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.tasks.await
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

class ServiceRepository(
    /**
     * Test seam only, the same shape [KinCareRepository] already takes.
     * Production call sites pass nothing, so `firestore` below still resolves
     * `FirebaseFirestore.getInstance()` on first use. The `by lazy` is
     * load-bearing: it was an eager `val` before, which meant a test could not
     * construct this class at all without Firebase's static init.
     */
    private val firestoreProvider: () -> FirebaseFirestore = { FirebaseFirestore.getInstance() },
) {

    private val firestore by lazy { firestoreProvider() }

    // === Base Services ===

    /**
     * CREATES a new service in the shared catalog. Whole-document write, which
     * is correct exactly here: there is no document yet, so there is nothing to
     * clobber and none of the portal's server-read fields
     * ([BASE_SERVICE_PORTAL_OWNED]) exists to delete.
     *
     * EDITING an existing service goes through [updateBaseServiceFields]. This
     * used to take that path too - a non-blank id selected
     * `document(service.id)` and then bare-`set()` the whole model over it, an
     * update wearing a create's name. Same precedent as
     * `AuntieRepository.saveHouseholdData`: the non-blank id now fails loud
     * rather than quietly re-opening the path `BaseServiceDiff.kt` closed.
     */
    suspend fun createBaseService(service: BaseService): Result<String> = runCatching {
        require(service.id.isBlank()) {
            "createBaseService creates; edit ${service.id} through updateBaseServiceFields"
        }
        AuntieLog.i("Creating base service: ${service.title}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val serviceWithTimestamp = service.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = firestore.collection("base_services").document()

        docRef.set(serviceWithTimestamp).await()
        AuntieLog.d("Base service created with ID: ${docRef.id}")
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

    /**
     * Writes ONLY the base-service fields that actually changed, plus the stamp.
     *
     * This replaced a whole-model `updateBaseService(service)` whose BARE
     * `.set(serviceWithTimestamp)` - no merge option at all - REPLACED the
     * document, deleting the seven portal fields the MyTribe functions read and
     * [BaseService] does not declare. `BaseServiceDiff.kt` names those fields,
     * their readers, and what each deletion costs a person.
     *
     * MERGE IS THE LOAD-BEARING PART HERE, not the diff. Merge is the only
     * thing that can preserve a field this client cannot name, and the portal's
     * `priceCents` / `active` are exactly that. The diff is what stops the
     * secondary loss: two phones (or one stale screen) are concurrent writers of
     * the fields this model DOES own, so renaming a service used to put the
     * `isActive` that screen read minutes ago back over a soft delete made
     * since.
     *
     * `updatedAt` is STAMPED here, never round-tripped from the value that was
     * read, so it cannot freeze and lie about when the service last changed (the
     * rule [AuntieRepository.updateHouseholdFields] follows). ISO-8601 String
     * rather than `serverTimestamp()`, matching every other date on this model.
     *
     * An empty [changes] is a caller bug, not a no-op to absorb: such a write
     * could only move the stamp, claiming a change that never happened. The
     * ViewModel skips the call outright when the diff is empty.
     */
    suspend fun updateBaseServiceFields(
        documentId: String,
        changes: Map<String, Any?>,
    ): Result<Unit> = runCatching {
        require(documentId.isNotBlank()) { "updateBaseServiceFields needs a base_services document id" }
        require(changes.isNotEmpty()) { "updateBaseServiceFields called with no changed fields" }
        AuntieLog.i("Updating base service $documentId: ${changes.keys.joinToString()}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val payload: Map<String, Any?> = changes + mapOf("updatedAt" to now)

        firestore.collection("base_services").document(documentId)
            .set(payload, com.google.firebase.firestore.SetOptions.merge()).await()
        Unit
    }.onFailure { AuntieLog.e("Error updating base service $documentId", it) }

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

    /**
     * CREATES a supplemental service. Whole-document write, which is correct
     * exactly here: there is no document yet, so there is nothing to clobber.
     *
     * A non-blank id used to select `document(service.id)` and bare-`set()` the
     * whole model over it - an update wearing a create's name, through the write
     * mode that REPLACES a document. Same precedent as
     * [createBaseService] and `AuntieRepository.saveHouseholdData`: it fails
     * loud rather than silently replacing a stored document.
     *
     * There is no `updateSupplementalService` to redirect to, and that is the
     * point: android has no supplemental-service EDIT screen at all
     * (`AddSupplementalServiceDialog` takes no `initial`), so an id arriving
     * here can only be a mistake, and the honest answer is to say so rather than
     * to quietly become the update path nobody designed.
     */
    suspend fun createSupplementalService(service: SupplementalService): Result<String> = runCatching {
        require(service.id.isBlank()) {
            "createSupplementalService creates; android has no supplemental-service edit path, " +
                "so it must not replace supplemental_services/${service.id}"
        }
        AuntieLog.i("Creating supplemental service: ${service.title}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val serviceWithTimestamp = service.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = firestore.collection("supplemental_services").document()

        docRef.set(serviceWithTimestamp).await()
        AuntieLog.d("Supplemental service created with ID: ${docRef.id}")
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

    /**
     * CREATES a surcharge; editing one goes through [updateSurcharge], which is
     * the path `AddSurchargeDialog` already takes on its Edit route. A non-blank
     * id used to fall into a whole-document bare `.set()` here instead - see
     * [createSupplementalService] for the shape and the precedent.
     */
    suspend fun createSurcharge(surcharge: Surcharge): Result<String> = runCatching {
        require(surcharge.id.isBlank()) {
            "createSurcharge creates; edit ${surcharge.id} through updateSurcharge"
        }
        AuntieLog.i("Creating surcharge: ${surcharge.title}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val surchargeWithTimestamp = surcharge.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = firestore.collection("surcharges").document()

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

    /** CREATES a discount; editing one goes through [updateDiscount]. See [createSurcharge]. */
    suspend fun createDiscount(discount: Discount): Result<String> = runCatching {
        require(discount.id.isBlank()) {
            "createDiscount creates; edit ${discount.id} through updateDiscount"
        }
        AuntieLog.i("Creating discount: ${discount.title}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val discountWithTimestamp = discount.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = firestore.collection("discounts").document()

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

    /**
     * CREATES a promo code; editing one goes through [updatePromoCode]. See
     * [createSurcharge].
     *
     * The one with a redemption counter on it: `PromoCode.usedCount` is a
     * running total, so a whole-document replace here would not merely revert
     * fields, it would reset how many times the code has been redeemed to
     * whatever the client happened to be holding.
     */
    suspend fun createPromoCode(promoCode: PromoCode): Result<String> = runCatching {
        require(promoCode.id.isBlank()) {
            "createPromoCode creates; edit ${promoCode.id} through updatePromoCode"
        }
        AuntieLog.i("Creating promo code: ${promoCode.code}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val promoCodeWithTimestamp = promoCode.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = firestore.collection("promo_codes").document()

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
