package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FunctionsClient
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

class PortalApi(private val fns: FunctionsClient) {

    // -- Access (operator-aware kinfolkIds list) --
    suspend fun getMyAccess(): MyAccessResult {
        val raw = fns.call("getMyAccess", null)
        return MyAccessResult(
            kinfolkIds = (raw["kinfolkIds"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
            isOperator = raw["isOperator"]?.jsonPrimitive?.booleanOrNull ?: false,
        )
    }

    /**
     * O-5: re-mints the `kinfolkId` custom claim after a TribePicker
     * selection, so direct-Firestore-rules-gated reads (live GPS
     * breadcrumbs) honor the pick — before this, only callable reads
     * (which pass kinfolkId explicitly) did. Caller should force an ID
     * token refresh right after (see [com.kinfolk.portal.auth.AuthRepository.refreshIdToken]).
     */
    suspend fun setActiveTribe(kinfolkId: String) {
        fns.call("setActiveTribe", buildJsonObject { put("kinfolkId", kinfolkId) })
    }

    // -- Home --
    suspend fun getMyHome(kinfolkId: String? = null): MyHomeResult {
        val raw = fns.call("getMyHome", kinfolkId?.let { buildJsonObject { put("kinfolkId", it) } })
        return MyHomeResult(
            kinfolkId = raw["kinfolkId"]?.jsonPrimitive?.contentOrNull ?: error("getMyHome: missing kinfolkId"),
            displayName = raw["displayName"]?.jsonPrimitive?.contentOrNull ?: error("getMyHome: missing displayName"),
            businessLogoUrl = raw["businessLogoUrl"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            businessName = raw["businessName"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            portal = decodePortalConfig(raw["portal"] as? JsonObject),
            bannerDismissedByUser = raw["bannerDismissedByUser"]?.jsonPrimitive?.booleanOrNull ?: false,
            payMethods = decodePayMethods(raw["payMethods"] as? JsonArray),
        )
    }

    /**
     * PR30. Lenient like [decodeInvoice]'s `lineItems`: an entry missing `id`
     * or carrying an unrecognized `kind` is dropped rather than throwing, so
     * a server ahead of this client (a new processor row in `METHOD_SPECS`)
     * degrades to "one fewer button" instead of a decode failure that would
     * take the whole Home/Invoice screen down with it.
     */
    private fun decodePayMethods(arr: JsonArray?): List<PayMethod> {
        return arr.orEmpty()
            .mapNotNull { it as? JsonObject }
            .mapNotNull { o ->
                val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val kind = when (o["kind"]?.jsonPrimitive?.contentOrNull) {
                    "checkout" -> PayMethodKind.Checkout
                    "link" -> PayMethodKind.Link
                    "instructions" -> PayMethodKind.Instructions
                    else -> return@mapNotNull null
                }
                PayMethod(
                    id = id,
                    label = o["label"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    kind = kind,
                    url = o["url"]?.jsonPrimitive?.contentOrNull,
                    instructions = o["instructions"]?.jsonPrimitive?.contentOrNull,
                )
            }
    }

    /**
     * Records a per-user dismissal of the portal banner [bannerId] (writes
     * `clients/{uid}.dismissedBanners` server-side). UX hides the banner locally
     * immediately; this persists the dismiss so it stays hidden across devices.
     */
    suspend fun dismissBanner(bannerId: String) {
        fns.call("dismissBanner", buildJsonObject { put("bannerId", bannerId) })
    }

    /**
     * Parses the `portal` object from the getMyHome response into [PortalConfig].
     * Shared wire contract — field names match the AuntieOS model + Function.
     * Every field defaults if missing, so a null/sparse object yields the
     * canonical defaults (back-compat with servers that don't yet send it).
     */
    private fun decodePortalConfig(obj: JsonObject?): PortalConfig {
        if (obj == null) return PortalConfig()
        val defaults = PortalConfig()

        val bannerObj = obj["banner"] as? JsonObject
        val banner = if (bannerObj == null) PortalBanner() else PortalBanner(
            enabled = bannerObj["enabled"]?.jsonPrimitive?.booleanOrNull ?: false,
            message = bannerObj["message"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            tone = bannerObj["tone"]?.jsonPrimitive?.contentOrNull ?: "info",
            dismissMode = bannerObj["dismissMode"]?.jsonPrimitive?.contentOrNull ?: "none",
            id = bannerObj["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        )

        val home = (obj["home"] as? JsonArray)
            ?.mapNotNull { it as? JsonObject }
            ?.map { sec ->
                PortalHomeSection(
                    id = sec["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    enabled = sec["enabled"]?.jsonPrimitive?.booleanOrNull ?: true,
                    limit = sec["limit"]?.jsonPrimitive?.intOrNull ?: 0,
                )
            }
            .orEmpty()

        val chatObj = obj["chat"] as? JsonObject
        val chat = if (chatObj == null) PortalChat() else PortalChat(
            enabled = chatObj["enabled"]?.jsonPrimitive?.booleanOrNull ?: true,
            awayMessage = chatObj["awayMessage"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            hoursEnabled = chatObj["hoursEnabled"]?.jsonPrimitive?.booleanOrNull ?: false,
            hours = (chatObj["hours"] as? JsonObject)?.entries
                ?.mapNotNull { (k, v) -> v.jsonPrimitive.contentOrNull?.let { k to it } }
                ?.toMap()
                .orEmpty(),
            maxMessageLength = chatObj["maxMessageLength"]?.jsonPrimitive?.intOrNull ?: 2000,
            rateLimitPerHour = chatObj["rateLimitPerHour"]?.jsonPrimitive?.intOrNull ?: 0,
        )

        return PortalConfig(
            logoUrl = obj["logoUrl"]?.jsonPrimitive?.contentOrNull ?: defaults.logoUrl,
            themeId = obj["themeId"]?.jsonPrimitive?.contentOrNull ?: defaults.themeId,
            banner = banner,
            home = home,
            chat = chat,
        )
    }

    /**
     * Resolves display names for a list of tribe ids. Operator picker uses
     * this to render human-readable tribe names instead of raw kinfolkIds.
     * Backed by parallel `getMyHome` calls — auth-checked server-side per id.
     * Falls back to "Tribe {id}" if a per-id lookup fails (rare; missing
     * families/{id} + dossiers/{id} both → server-side fallback already gives
     * a name; this catch is for network errors only).
     */
    suspend fun getTribeSummaries(ids: List<String>): List<TribeSummary> = coroutineScope {
        ids.map { id ->
            async {
                try {
                    val home = getMyHome(id)
                    TribeSummary(id = id, displayName = home.displayName)
                } catch (_: Throwable) {
                    TribeSummary(id = id, displayName = "Tribe $id")
                }
            }
        }.awaitAll()
    }

    // -- Bookings --
    suspend fun getMyBookings(kinfolkId: String? = null): BookingsResult {
        val raw = fns.call("getMyBookings", kinfolkId?.let { buildJsonObject { put("kinfolkId", it) } })
        return BookingsResult(
            liveVisit = (raw["liveVisit"] as? JsonObject)?.let(::decodeBooking),
            upcoming = (raw["upcoming"] as? JsonArray)?.map { decodeBooking(it.jsonObject) }.orEmpty(),
            recent = (raw["recent"] as? JsonArray)?.map { decodeBooking(it.jsonObject) }.orEmpty(),
            envelopes = (raw["envelopes"] as? JsonArray)?.map { decodeEnvelope(it.jsonObject) }.orEmpty(),
        )
    }

    suspend fun requestBooking(
        kinfolkId: String? = null,
        serviceType: String,
        title: String? = null,
        startTimeMs: Long,
        endTimeMs: Long? = null,
        kinIds: List<String> = emptyList(),
        notes: String? = null,
    ): String {
        val payload = buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("serviceType", serviceType)
            title?.let { put("title", it) }
            put("startTimeMs", startTimeMs)
            endTimeMs?.let { put("endTimeMs", it) }
            put("kinIds", buildJsonArray { kinIds.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
            notes?.let { put("notes", it) }
        }
        val raw = fns.call("requestBooking", payload)
        return raw["bookingId"]?.jsonPrimitive?.contentOrNull ?: error("requestBooking: missing id")
    }

    /**
     * Multi-visit booking request (wizard flow). The server groups the created
     * KinCares under one envelope and returns its `batchId`. Falls back to the
     * first `bookingIds` entry (or the legacy `bookingId`) for back-compat.
     */
    suspend fun requestBookingMultiVisit(
        kinfolkId: String? = null,
        kinIds: List<String> = emptyList(),
        pattern: BookingPattern = BookingPattern.Individual,
        weeklyDays: List<Int>? = null,
        visits: List<BookingVisit>,
        notes: String? = null,
    ): String {
        require(visits.isNotEmpty()) { "visits must be non-empty" }
        val payload = buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("kinIds", buildJsonArray { kinIds.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
            put("pattern", when (pattern) {
                BookingPattern.Individual -> "individual"
                BookingPattern.Weekly -> "weekly"
            })
            weeklyDays?.let { days ->
                put("weeklyDays", buildJsonArray { days.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
            }
            notes?.let { put("notes", it) }
            put("visits", buildJsonArray {
                visits.forEach { v ->
                    add(buildJsonObject {
                        put("startTimeMs", v.startTimeMs)
                        v.endTimeMs?.let { put("endTimeMs", it) }
                        put("serviceId", v.serviceId)
                        put("serviceName", v.serviceName)
                        v.priceCents?.let { put("priceCents", it) }
                    })
                }
            })
        }
        val raw = fns.call("requestBooking", payload)
        return raw["batchId"]?.jsonPrimitive?.contentOrNull
            ?: (raw["bookingIds"] as? JsonArray)?.firstOrNull()?.jsonPrimitive?.contentOrNull
            ?: raw["bookingId"]?.jsonPrimitive?.contentOrNull
            ?: error("requestBooking: missing batchId")
    }

    /** Reads admin-driven form schema by id (e.g. "tribeProfile", "accountSettings"). */
    suspend fun getFormSchema(schemaId: String): FormSchema {
        val raw = fns.call("getFormSchema", buildJsonObject { put("schemaId", schemaId) })
        val sections = (raw["sections"] as? JsonArray)?.map { secEl ->
            val sec = secEl.jsonObject
            FormSection(
                title = sec["title"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                description = sec["description"]?.jsonPrimitive?.contentOrNull,
                fields = (sec["fields"] as? JsonArray)?.map { fEl ->
                    val f = fEl.jsonObject
                    FormField(
                        key = f["key"]?.jsonPrimitive?.contentOrNull ?: error("schema field: missing key"),
                        label = f["label"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        type = decodeFieldType(f["type"]?.jsonPrimitive?.contentOrNull),
                        required = f["required"]?.jsonPrimitive?.booleanOrNull ?: false,
                        helperText = f["helperText"]?.jsonPrimitive?.contentOrNull,
                        placeholder = f["placeholder"]?.jsonPrimitive?.contentOrNull,
                        options = (f["options"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull },
                        defaultValue = f["defaultValue"]?.jsonPrimitive?.contentOrNull,
                        group = f["group"]?.jsonPrimitive?.contentOrNull,
                    )
                }.orEmpty(),
            )
        }.orEmpty()
        return FormSchema(
            id = raw["id"]?.jsonPrimitive?.contentOrNull ?: schemaId,
            name = raw["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            description = raw["description"]?.jsonPrimitive?.contentOrNull,
            sections = sections,
            version = raw["version"]?.jsonPrimitive?.longOrNull?.toInt() ?: 0,
        )
    }

    /** Dog + cat breed name lists for the Kin breed dropdown (seeded collections). */
    suspend fun getBreeds(): BreedsResult {
        val raw = fns.call("getBreeds", null)
        fun names(key: String) = (raw[key] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty()
        return BreedsResult(dogBreeds = names("dogBreeds"), catBreeds = names("catBreeds"))
    }

    private fun decodeFieldType(raw: String?): FormFieldType = when (raw) {
        "textarea" -> FormFieldType.Textarea
        "select" -> FormFieldType.Select
        "multiselect" -> FormFieldType.MultiSelect
        "date" -> FormFieldType.Date
        "number" -> FormFieldType.Number
        "checkbox" -> FormFieldType.Checkbox
        "phone" -> FormFieldType.Phone
        "email" -> FormFieldType.Email
        else -> FormFieldType.Text
    }

    /** Reads `base_services` catalog (active only). */
    suspend fun getServiceCatalog(): ServiceCatalog {
        val raw = fns.call("getServiceCatalog", null)
        val list = (raw["services"] as? JsonArray)?.map { el ->
            val o = el.jsonObject
            Service(
                id = o["id"]?.jsonPrimitive?.contentOrNull ?: error("service: missing id"),
                name = o["name"]?.jsonPrimitive?.contentOrNull ?: "Service",
                category = o["category"]?.jsonPrimitive?.contentOrNull,
                description = o["description"]?.jsonPrimitive?.contentOrNull,
                priceCents = o["priceCents"]?.jsonPrimitive?.longOrNull,
                priceMinCents = o["priceMinCents"]?.jsonPrimitive?.longOrNull,
                priceMaxCents = o["priceMaxCents"]?.jsonPrimitive?.longOrNull,
                isOvernight = o["isOvernight"]?.jsonPrimitive?.booleanOrNull ?: false,
                iconKey = o["iconKey"]?.jsonPrimitive?.contentOrNull,
            )
        }.orEmpty()
        return ServiceCatalog(services = list)
    }

    // -- Mapbox autocomplete (Function-proxied; secret access token never ships in the bundle) --
    suspend fun mapboxSearch(query: String, sessionToken: String, limit: Int = 5, country: String? = null): List<MapboxSuggestion> {
        if (query.length < 2) return emptyList()
        val raw = fns.call("mapboxSearch", buildJsonObject {
            put("query", query)
            put("sessionToken", sessionToken)
            put("limit", limit)
            country?.let { put("country", it) }
        })
        return (raw["suggestions"] as? JsonArray)?.map { el ->
            val o = el.jsonObject
            MapboxSuggestion(
                name = o["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                fullAddress = o["full_address"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                mapboxId = o["mapbox_id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                placeFormatted = o["place_formatted"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            )
        }.orEmpty()
    }

    suspend fun mapboxRetrieve(mapboxId: String, sessionToken: String): MapboxFeature? {
        if (mapboxId.isBlank()) return null
        val raw = fns.call("mapboxRetrieve", buildJsonObject {
            put("mapboxId", mapboxId)
            put("sessionToken", sessionToken)
        })
        val featureObj = raw["feature"] as? JsonObject ?: return null
        val props = featureObj["properties"] as? JsonObject
        val geom  = featureObj["geometry"] as? JsonObject
        val coords = geom?.get("coordinates") as? JsonArray
        val lng = coords?.getOrNull(0)?.jsonPrimitive?.doubleOrNull ?: 0.0
        val lat = coords?.getOrNull(1)?.jsonPrimitive?.doubleOrNull ?: 0.0
        return MapboxFeature(
            name = props?.get("name")?.jsonPrimitive?.contentOrNull.orEmpty(),
            fullAddress = props?.get("full_address")?.jsonPrimitive?.contentOrNull.orEmpty(),
            placeFormatted = props?.get("place_formatted")?.jsonPrimitive?.contentOrNull.orEmpty(),
            longitude = lng,
            latitude = lat,
        )
    }

    /** Reads the public-facing business contact (name/email/phone/address) from
     *  `business_settings/singleton`. Used by TribeScreen's "Contact Auntie" card.
     *  Operational fields (rates, schedules, notification toggles) are filtered
     *  server-side and never exposed here. */
    /** Requests signed Cloudinary upload params scoped to the caller's
     *  `tribetails/kinfolks/{uid}/avatars/` folder. Server holds the API
     *  secret; client never sees it. */
    suspend fun signKinfolkAvatar(): com.kinfolk.portal.media.CloudinarySignedUpload {
        val raw = fns.call("signKinfolkAvatar", null)
        return decodeCloudinarySignedUpload(raw)
    }

    /**
     * Requests signed Cloudinary upload params scoped to one specific kin's
     * own photo folder (`tribetails/kinfolks/{kinfolkId}/kin/{kinId}/`) —
     * replaces the base64-through-the-callable `uploadKinPhoto` path (2MB
     * cap). kin_edit-gated server-side before signing.
     */
    suspend fun signKinPhotoUpload(kinId: String, kinfolkId: String? = null): com.kinfolk.portal.media.CloudinarySignedUpload {
        val raw = fns.call("signKinPhotoUpload", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("kinId", kinId)
        })
        return decodeCloudinarySignedUpload(raw)
    }

    /**
     * Persists the `secure_url` from a direct-to-Cloudinary kin-photo upload
     * onto the kin doc. The server independently re-validates kin_edit
     * permission AND that secureUrl is actually a Cloudinary asset inside the
     * folder that was signed — never trusts the client-reported URL blindly.
     */
    suspend fun confirmKinPhotoUpload(kinId: String, secureUrl: String, kinfolkId: String? = null): String {
        val raw = fns.call("confirmKinPhotoUpload", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("kinId", kinId)
            put("secureUrl", secureUrl)
        })
        return raw["photoUrl"]?.jsonPrimitive?.contentOrNull ?: error("confirmKinPhotoUpload: missing photoUrl")
    }

    private fun decodeCloudinarySignedUpload(raw: JsonObject): com.kinfolk.portal.media.CloudinarySignedUpload =
        com.kinfolk.portal.media.CloudinarySignedUpload(
            cloudName      = raw["cloudName"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            apiKey         = raw["apiKey"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            timestamp      = raw["timestamp"]?.jsonPrimitive?.longOrNull ?: 0L,
            signature      = raw["signature"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            folder         = raw["folder"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            allowedFormats = raw["allowedFormats"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        )

    suspend fun getBusinessContact(): com.kinfolk.portal.config.BusinessContact {
        val raw = fns.call("getBusinessContact", null)
        return com.kinfolk.portal.config.BusinessContact(
            name    = raw["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            email   = raw["email"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            phone   = raw["phone"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            address = raw["address"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        )
    }

    /** Reads merged feature flags from the `getFeatureFlags` callable, which
     *  overlays the global `business_settings/feature_flags` doc with the
     *  per-tester `clients/{uid}.featureFlags` map. Only keys the client knows
     *  are applied; everything else falls back to the compile-time
     *  [com.kinfolk.portal.config.FeatureFlags] defaults, so a missing doc or an
     *  unknown remote key can never produce surprise behavior. */
    suspend fun getFeatureFlags(): com.kinfolk.portal.config.FeatureFlags {
        val raw = fns.call("getFeatureFlags", null)
        val overrides = (raw["flags"] as? JsonObject)?.entries
            ?.mapNotNull { (key, value) ->
                (value as? kotlinx.serialization.json.JsonPrimitive)?.booleanOrNull?.let { key to it }
            }
            ?.toMap()
            .orEmpty()
        return com.kinfolk.portal.config.FeatureFlags.fromOverrides(overrides)
    }

    /** Reads recent kin_care_sessions for the signed-in kinfolk, with GPS summary
     *  if AuntieOS has baked one onto the session doc. Used by ScheduleScreen
     *  to render the RouteMap on past visits. */
    suspend fun getMyVisits(kinfolkId: String? = null, limit: Int = 10): VisitsResult {
        val raw = fns.call("getMyVisits", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("limit", limit)
        })
        val list = (raw["visits"] as? JsonArray)?.map { el ->
            val o = el.jsonObject
            val summary = o["gpsSummary"]?.jsonObject
            val routeArr = summary?.get("route") as? JsonArray
            val route = routeArr?.mapNotNull { rp ->
                val p = rp.jsonObject
                val lat = p["lat"]?.jsonPrimitive?.doubleOrNull
                val lng = p["lng"]?.jsonPrimitive?.doubleOrNull
                if (lat == null || lng == null) null
                else com.kinfolk.portal.components.RoutePoint(
                    lat = lat,
                    lng = lng,
                    t   = p["t"]?.jsonPrimitive?.longOrNull,
                )
            }.orEmpty()
            Visit(
                id              = o["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                status          = o["status"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                serviceType     = o["serviceType"]?.jsonPrimitive?.contentOrNull,
                startTimeIso    = o["startTimeIso"]?.jsonPrimitive?.contentOrNull,
                endTimeIso      = o["endTimeIso"]?.jsonPrimitive?.contentOrNull,
                arrivedAtIso    = o["arrivedAtIso"]?.jsonPrimitive?.contentOrNull,
                departedAtIso   = o["departedAtIso"]?.jsonPrimitive?.contentOrNull,
                gpsRoute        = route,
                gpsDistanceMeters  = summary?.get("distanceMeters")?.jsonPrimitive?.doubleOrNull,
                gpsDurationSeconds = summary?.get("durationSeconds")?.jsonPrimitive?.longOrNull,
            )
        }.orEmpty()
        return VisitsResult(visits = list)
    }

    /** Reads the shared `vet_clinics` catalog (the vet bank). Returns only
     *  APPROVED clinics; pending kinfolk submissions are filtered server-side. */
    suspend fun getVetClinics(): List<VetClinic> {
        val raw = fns.call("getVetClinics", null)
        return (raw["clinics"] as? JsonArray)?.map { el ->
            val o = el.jsonObject
            VetClinic(
                id            = o["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                name          = o["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                phone         = o["phone"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                address       = o["address"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                website       = o["website"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                googleMapsUrl = o["googleMapsUrl"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                isEmergency   = o["isEmergency"]?.jsonPrimitive?.booleanOrNull ?: false,
            )
        }.orEmpty()
    }

    /** Result of submitting a not-on-the-list vet to the shared bank. */
    data class VetSubmitResult(val clinicId: String, val created: Boolean, val pending: Boolean)

    /**
     * Kinfolk add-new: submits a vet clinic the household couldn't find on the
     * list. Lands a PENDING entry (verified=false) the operator approves in
     * AuntieOS; if a clinic with the same name already exists, the call dedupes
     * and returns that clinic instead of creating a duplicate.
     */
    suspend fun submitVetClinic(
        name: String,
        phone: String = "",
        address: String = "",
        website: String = "",
    ): VetSubmitResult {
        val raw = fns.call("submitVetClinic", buildJsonObject {
            put("name", name)
            put("phone", phone)
            put("address", address)
            put("website", website)
        })
        return VetSubmitResult(
            clinicId = raw["clinicId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            created  = raw["created"]?.jsonPrimitive?.booleanOrNull ?: false,
            pending  = raw["pending"]?.jsonPrimitive?.booleanOrNull ?: true,
        )
    }

    // -- Kin --
    suspend fun getMyKin(kinfolkId: String? = null): KinResult {
        val raw = fns.call("getMyKin", kinfolkId?.let { buildJsonObject { put("kinfolkId", it) } })
        val list = (raw["kin"] as? JsonArray)?.map { el ->
            val o = el.jsonObject
            Kin(
                id = o["id"]?.jsonPrimitive?.contentOrNull ?: error("kin: missing id"),
                name = o["name"]?.jsonPrimitive?.contentOrNull,
                species = o["species"]?.jsonPrimitive?.contentOrNull,
                breed = o["breed"]?.jsonPrimitive?.contentOrNull,
                ageYears = o["ageYears"]?.jsonPrimitive?.doubleOrNull,
                photoUrl = o["photoUrl"]?.jsonPrimitive?.contentOrNull,
                status = if (o["status"]?.jsonPrimitive?.contentOrNull == "noLongerWithUs") KinStatus.NoLongerWithUs else KinStatus.Active,
                feedingInstructions = o["feedingInstructions"]?.jsonPrimitive?.contentOrNull,
                walkingInstructions = o["walkingInstructions"]?.jsonPrimitive?.contentOrNull,
                medications = o["medications"]?.jsonPrimitive?.contentOrNull,
                allergies = o["allergies"]?.jsonPrimitive?.contentOrNull,
                emergencyNotes = o["emergencyNotes"]?.jsonPrimitive?.contentOrNull,
                sitterNotes = o["sitterNotes"]?.jsonPrimitive?.contentOrNull,
            )
        }.orEmpty()
        return KinResult(kin = list)
    }

    // -- KinTales --
    suspend fun getMyKinTales(
        kinfolkId: String? = null,
        before: Long? = null,
        limit: Int? = null,
    ): KinTalesResult {
        val payload: JsonObject? = if (kinfolkId == null && before == null && limit == null) null
        else buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            before?.let { put("before", it) }
            limit?.let { put("limit", it) }
        }
        val raw = fns.call("getMyKinTales", payload)
        val list = (raw["tales"] as? JsonArray)?.map { el ->
            val o = el.jsonObject
            val routeArr = o["gpsRoute"] as? JsonArray
            val route = routeArr?.mapNotNull { rp ->
                val p = rp.jsonObject
                val lat = p["lat"]?.jsonPrimitive?.doubleOrNull
                val lng = p["lng"]?.jsonPrimitive?.doubleOrNull
                if (lat == null || lng == null) null
                else com.kinfolk.portal.components.RoutePoint(
                    lat = lat,
                    lng = lng,
                    t = p["t"]?.jsonPrimitive?.longOrNull,
                )
            }.orEmpty()
            val summary = o["gpsSummary"]?.jsonObject
            // Optional-tolerant (task-24): an older deployed getMyKinTales that
            // doesn't send `thumbs` yet parses as an empty list, not a crash.
            val thumbs = (o["thumbs"] as? JsonArray)?.mapNotNull { th ->
                val to = th.jsonObject
                val id = to["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val url = to["url"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                KinTaleThumb(id = id, url = url, contentType = to["contentType"]?.jsonPrimitive?.contentOrNull)
            }.orEmpty()
            // task-25 (P4): checked-only task checklist. Absent/malformed entries
            // are skipped, never surfaced as a placeholder — same tolerance as
            // `thumbs` above for a field an older deployed function might omit.
            val checklist = (o["checklist"] as? JsonArray)?.mapNotNull { ci ->
                val co = ci.jsonObject
                val key = co["key"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val text = co["text"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                KinTaleChecklistItem(key = key, text = text)
            }.orEmpty()
            KinTale(
                id = o["id"]?.jsonPrimitive?.contentOrNull ?: error("kinTale: missing id"),
                body = o["body"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                authorDisplayName = o["authorDisplayName"]?.jsonPrimitive?.contentOrNull,
                mediaIds = (o["mediaIds"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
                sentAtMs = o["sentAtMs"]?.jsonPrimitive?.longOrNull,
                shared = o["shared"]?.jsonPrimitive?.booleanOrNull ?: false,
                gpsRoute = route,
                gpsDistanceMeters  = summary?.get("distanceMeters")?.jsonPrimitive?.doubleOrNull,
                gpsDurationSeconds = summary?.get("durationSeconds")?.jsonPrimitive?.longOrNull,
                thumbs = thumbs,
                arrivedAtIso = o["arrivedAtIso"]?.jsonPrimitive?.contentOrNull,
                departedAtIso = o["departedAtIso"]?.jsonPrimitive?.contentOrNull,
                checklist = checklist,
            )
        }.orEmpty()
        return KinTalesResult(
            tales = list,
            hasMore = raw["hasMore"]?.jsonPrimitive?.booleanOrNull ?: false,
        )
    }

    // -- Invoices --
    suspend fun getMyInvoices(kinfolkId: String? = null): InvoicesResult {
        val raw = fns.call("getMyInvoices", kinfolkId?.let { buildJsonObject { put("kinfolkId", it) } })
        return InvoicesResult(
            open = (raw["open"] as? JsonArray)?.map { decodeInvoice(it) }.orEmpty(),
            paid = (raw["paid"] as? JsonArray)?.map { decodeInvoice(it) }.orEmpty(),
            credits = (raw["credits"] as? JsonArray)?.map { decodeInvoice(it) }.orEmpty(),
            accountBalanceCents = raw["accountBalanceCents"]?.jsonPrimitive?.longOrNull ?: 0L,
        )
    }

    suspend fun redeemCredit(
        invoiceId: String,
        kinfolkId: String? = null,
        target: CreditTarget,
    ): RedeemCreditResult {
        val raw = fns.call("redeemCredit", buildJsonObject {
            put("invoiceId", invoiceId)
            kinfolkId?.let { put("kinfolkId", it) }
            put("target", when (target) {
                CreditTarget.AccountBalance -> "accountBalance"
                CreditTarget.OriginalPaymentMethod -> "originalPaymentMethod"
            })
        })
        return RedeemCreditResult(
            ok = raw["ok"]?.jsonPrimitive?.booleanOrNull ?: false,
            redeemedAmountCents = raw["redeemedAmountCents"]?.jsonPrimitive?.longOrNull ?: 0L,
            target = when (raw["target"]?.jsonPrimitive?.contentOrNull) {
                "originalPaymentMethod" -> CreditTarget.OriginalPaymentMethod
                else -> CreditTarget.AccountBalance
            },
            newAccountBalanceCents = raw["newAccountBalanceCents"]?.jsonPrimitive?.longOrNull,
            refundId = raw["refundId"]?.jsonPrimitive?.contentOrNull,
        )
    }

    /**
     * THE HOUSEHOLD'S ANSWER TO A QUOTE (issue #385). Accepting turns the quote
     * into a bill server-side, so the caller reloads rather than patching its
     * own copy. Both refuse a quote that has already been answered, and accept
     * refuses one whose due date has passed; the refusal arrives as the
     * callable's own message, which is what the screen shows.
     */
    suspend fun acceptQuote(invoiceId: String, kinfolkId: String? = null): QuoteDecisionResult =
        decideQuote("acceptQuote", invoiceId, kinfolkId)
    suspend fun denyQuote(invoiceId: String, kinfolkId: String? = null): QuoteDecisionResult =
        decideQuote("denyQuote", invoiceId, kinfolkId)
    private suspend fun decideQuote(
        callable: String,
        invoiceId: String,
        kinfolkId: String?,
    ): QuoteDecisionResult {
        val raw = fns.call(callable, buildJsonObject {
            put("invoiceId", invoiceId)
            kinfolkId?.let { put("kinfolkId", it) }
        })
        return QuoteDecisionResult(
            ok = raw["ok"]?.jsonPrimitive?.booleanOrNull ?: false,
            invoiceId = raw["invoiceId"]?.jsonPrimitive?.contentOrNull ?: invoiceId,
            status = decodeInvoiceStatus(raw["status"]?.jsonPrimitive?.contentOrNull),
        )
    }
    // -- Tribe / Home Access --
    suspend fun getMyTribeProfile(kinfolkId: String? = null): TribeProfileResult {
        val raw = fns.call("getMyTribeProfile", kinfolkId?.let { buildJsonObject { put("kinfolkId", it) } })
        val p = raw["profile"]!!.jsonObject
        val a = raw["homeAccess"]!!.jsonObject
        return TribeProfileResult(
            profile = TribeProfile(
                kinfolkId = p["kinfolkId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                displayName = p["displayName"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                customFields = decodeCustomFields(p["customFields"]),
            ),
            homeAccess = HomeAccess(
                gateCode = a["gateCode"]?.jsonPrimitive?.contentOrNull,
                keyLocation = a["keyLocation"]?.jsonPrimitive?.contentOrNull,
                wifiPassword = a["wifiPassword"]?.jsonPrimitive?.contentOrNull,
                customFields = decodeCustomFields(a["customFields"]),
                updatedAtMs = a["updatedAtMs"]?.jsonPrimitive?.longOrNull,
            ),
        )
    }

    suspend fun saveTribeProfile(
        kinfolkId: String? = null,
        displayName: String? = null,
        customFields: List<CustomField>? = null,
    ) {
        fns.call("saveTribeProfile", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            displayName?.let { put("displayName", it) }
            customFields?.let { put("customFields", encodeCustomFields(it)) }
        })
    }

    suspend fun saveHomeAccess(
        kinfolkId: String? = null,
        gateCode: String? = null,
        keyLocation: String? = null,
        wifiPassword: String? = null,
        customFields: List<CustomField>? = null,
    ) {
        fns.call("saveHomeAccess", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            gateCode?.let { put("gateCode", it) }
            keyLocation?.let { put("keyLocation", it) }
            wifiPassword?.let { put("wifiPassword", it) }
            customFields?.let { put("customFields", encodeCustomFields(it)) }
        })
    }

    // -- Notification Prefs --
    suspend fun getMyNotificationPrefs(): NotificationPrefs {
        val raw = fns.call("getMyNotificationPrefs", null)
        val prefsObj = raw["prefs"] as? JsonObject
        return NotificationPrefs(
            byCategory = parseChannelMapMap(prefsObj?.get("byCategory") as? JsonObject),
            byKey = parseChannelMapMap(prefsObj?.get("byKey") as? JsonObject),
            marketingOptIn = (prefsObj?.get("marketingOptIn") as? JsonObject)?.entries
                ?.associate { (k, v) -> k to (v.jsonPrimitive.booleanOrNull ?: false) }
                .orEmpty(),
            updatedAtMs = raw["updatedAtMs"]?.jsonPrimitive?.longOrNull,
        )
    }

    suspend fun saveMyNotificationPrefs(
        byCategory: Map<String, Map<String, Boolean>>,
        byKey: Map<String, Map<String, Boolean>>,
        marketingOptIn: Map<String, Boolean>,
    ) {
        fns.call("saveMyNotificationPrefs", buildJsonObject {
            put("prefs", buildJsonObject {
                put("byCategory", buildJsonObject {
                    byCategory.forEach { (cat, channels) ->
                        put(cat, buildJsonObject { channels.forEach { (ch, v) -> put(ch, v) } })
                    }
                })
                put("byKey", buildJsonObject {
                    byKey.forEach { (key, channels) ->
                        put(key, buildJsonObject { channels.forEach { (ch, v) -> put(ch, v) } })
                    }
                })
                put("marketingOptIn", buildJsonObject {
                    marketingOptIn.forEach { (k, v) -> put(k, v) }
                })
            })
        })
    }

    private fun parseChannelMapMap(obj: JsonObject?): Map<String, Map<String, Boolean>> {
        if (obj == null) return emptyMap()
        return obj.entries.associate { (outerKey, channels) ->
            outerKey to (channels.jsonObject.entries.associate { (ch, v) ->
                ch to (v.jsonPrimitive.booleanOrNull ?: false)
            })
        }
    }

    // -- Account --
    suspend fun getMyAccount(): Account {
        val raw = fns.call("getMyAccount", null)
        return Account(
            uid = raw["uid"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            email = raw["email"]?.jsonPrimitive?.contentOrNull,
            displayName = raw["displayName"]?.jsonPrimitive?.contentOrNull,
            phone = raw["phone"]?.jsonPrimitive?.contentOrNull,
            photoUrl = raw["photoUrl"]?.jsonPrimitive?.contentOrNull,
            backupEmail = raw["backupEmail"]?.jsonPrimitive?.contentOrNull,
            backupPhone = raw["backupPhone"]?.jsonPrimitive?.contentOrNull,
            kinfolkIds = (raw["kinfolkIds"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
            hasPaymentMethod = raw["hasPaymentMethod"]?.jsonPrimitive?.booleanOrNull ?: false,
            updatedAtMs = raw["updatedAtMs"]?.jsonPrimitive?.longOrNull,
        )
    }

    suspend fun saveMyAccount(
        displayName: String? = null,
        phone: String? = null,
        photoUrl: String? = null,
        backupEmail: String? = null,
        backupPhone: String? = null,
    ) {
        fns.call("saveMyAccount", buildJsonObject {
            displayName?.let { put("displayName", it) }
            phone?.let { put("phone", it) }
            photoUrl?.let { put("photoUrl", it) }
            backupEmail?.let { put("backupEmail", it) }
            backupPhone?.let { put("backupPhone", it) }
        })
    }

    // -- Pay Invoice (Stripe Checkout) --
    suspend fun payInvoice(
        invoiceId: String,
        kinfolkId: String? = null,
        successUrl: String,
        cancelUrl: String,
    ): PayInvoiceResult {
        val raw = fns.call("payInvoice", buildJsonObject {
            put("invoiceId", invoiceId)
            kinfolkId?.let { put("kinfolkId", it) }
            put("successUrl", successUrl)
            put("cancelUrl", cancelUrl)
        })
        return PayInvoiceResult(
            checkoutUrl = raw["checkoutUrl"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            sessionId = raw["sessionId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            amountCents = raw["amountCents"]?.jsonPrimitive?.longOrNull ?: 0L,
            currency = raw["currency"]?.jsonPrimitive?.contentOrNull ?: "usd",
        )
    }

    // -- Card on file (portal/billing.ts, #399 item 3) --
    /** The card the household has on file, if any. */
    suspend fun getMyPaymentMethod(kinfolkId: String? = null): PaymentMethodState {
        val raw = fns.call("getMyPaymentMethod", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
        })
        return paymentMethodStateFrom(raw)
    }
    /**
     * Opens a Stripe Checkout Session in setup mode. Nothing is charged; the
     * card is attached to the household's Stripe customer. Open the returned
     * URL with `openExternalUrl`, then call [syncMyPaymentMethod] when the
     * kinfolk comes back to the app.
     */
    suspend fun createBillingSetupSession(
        successUrl: String,
        cancelUrl: String,
        kinfolkId: String? = null,
    ): BillingSetupSession {
        val raw = fns.call("createBillingSetupSession", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("successUrl", successUrl)
            put("cancelUrl", cancelUrl)
        })
        return BillingSetupSession(
            checkoutUrl = raw["checkoutUrl"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            sessionId = raw["sessionId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        )
    }
    /**
     * Re-reads the card from Stripe and stores it.
     *
     * The android client has no return trip from the external browser, so this
     * is what "Refresh" on the billing card calls. Safe to call at any time.
     */
    suspend fun syncMyPaymentMethod(kinfolkId: String? = null): PaymentMethodState {
        val raw = fns.call("syncMyPaymentMethod", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
        })
        return paymentMethodStateFrom(raw)
    }
    /** Takes the card off file. Removes an instrument, never a payment already made. */
    suspend fun removeMyPaymentMethod(kinfolkId: String? = null): Boolean {
        val raw = fns.call("removeMyPaymentMethod", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
        })
        return raw["alreadyEmpty"]?.jsonPrimitive?.booleanOrNull ?: false
    }
    /**
     * Shared decoder for the three card-state responses.
     *
     * A card is only built when all four display fields arrived. Fail-soft on
     * a partial payload, because "Visa •••• null" on a billing screen reads as
     * a broken account rather than as a missing field.
     */
    private fun paymentMethodStateFrom(raw: JsonObject): PaymentMethodState {
        val cardObj = raw["card"] as? JsonObject
        val brand = cardObj?.get("brand")?.jsonPrimitive?.contentOrNull
        val last4 = cardObj?.get("last4")?.jsonPrimitive?.contentOrNull
        val expMonth = cardObj?.get("expMonth")?.jsonPrimitive?.intOrNull
        val expYear = cardObj?.get("expYear")?.jsonPrimitive?.intOrNull
        return PaymentMethodState(
            hasPaymentMethod = raw["hasPaymentMethod"]?.jsonPrimitive?.booleanOrNull ?: false,
            card = if (brand != null && last4 != null && expMonth != null && expYear != null) {
                SavedCard(brand = brand, last4 = last4, expMonth = expMonth, expYear = expYear)
            } else {
                null
            },
            updatedAtMs = raw["updatedAtMs"]?.jsonPrimitive?.longOrNull,
        )
    }
    // -- Kin write paths --
    suspend fun addKin(kinfolkId: String? = null, kin: KinPayload): String {
        val raw = fns.call("addKin", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("kin", kinPayloadToJson(kin))
        })
        return raw["kinId"]?.jsonPrimitive?.contentOrNull ?: error("addKin: missing kinId")
    }

    suspend fun updateKin(kinfolkId: String? = null, kinId: String, kin: KinPayload) {
        fns.call("updateKin", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("kinId", kinId)
            put("kin", kinPayloadToJson(kin))
        })
    }

    suspend fun archiveKin(kinfolkId: String? = null, kinId: String, restore: Boolean = false) {
        fns.call("archiveKin", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("kinId", kinId)
            put("reason", if (restore) "restore" else "noLongerWithUs")
        })
    }

    /**
     * Uploads a kin photo direct-to-Cloudinary: validate ([KinPhotoPolicy]) →
     * sign ([signKinPhotoUpload], kin_edit-gated server-side) → upload
     * (client POSTs straight to Cloudinary, server never sees the bytes) →
     * confirm ([confirmKinPhotoUpload], which re-validates permission AND
     * that the returned URL is genuinely our Cloudinary asset in the signed
     * folder before persisting it onto the kin doc). Replaces the old
     * base64-through-a-callable `uploadKinPhoto` path and its 2MB cap.
     * Throws IllegalStateException with a user-facing message when the image
     * fails policy validation, and rethrows callable/upload failures.
     */
    suspend fun uploadKinPhotoSigned(
        kinfolkId: String? = null,
        kinId: String,
        image: com.kinfolk.portal.media.PickedImage,
    ): String {
        com.kinfolk.portal.media.KinPhotoPolicy.validate(image)?.let { problem -> error(problem) }
        val signed = signKinPhotoUpload(kinId = kinId, kinfolkId = kinfolkId)
        if (signed.cloudName.isBlank()) error("Photo uploads aren't available right now. Try again later.")
        val secureUrl = com.kinfolk.portal.media.uploadImageToCloudinary(signed, image)
            ?: error("Upload failed, try again")
        return confirmKinPhotoUpload(kinId = kinId, secureUrl = secureUrl, kinfolkId = kinfolkId)
    }

    private fun kinPayloadToJson(p: KinPayload): JsonObject = buildJsonObject {
        put("name", p.name)
        p.species?.let { put("species", it) }
        p.breed?.let { put("breed", it) }
        p.ageYears?.let { put("ageYears", it) }
        p.photoUrl?.let { put("photoUrl", it) }
        p.feedingInstructions?.let { put("feedingInstructions", it) }
        p.walkingInstructions?.let { put("walkingInstructions", it) }
        p.medications?.let { put("medications", it) }
        p.allergies?.let { put("allergies", it) }
        p.emergencyNotes?.let { put("emergencyNotes", it) }
        p.sitterNotes?.let { put("sitterNotes", it) }
        p.legacyKinId?.let { put("legacyKinId", it) }
    }

    // -- Secondary contact --
    suspend fun addSecondaryContact(
        kinfolkId: String? = null,
        invitedEmail: String,
        secondaryLabel: String? = null,
        billingFull: Boolean = false,
        kinEdit: Boolean = false,
        homeAccess: Boolean = false,
    ): String {
        val raw = fns.call("addSecondaryContact", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("invitedEmail", invitedEmail)
            secondaryLabel?.let { put("secondaryLabel", it) }
            put("permissions", buildJsonObject {
                put("billing_full", billingFull)
                put("messaging_direct", true)
                put("messaging_group", true)
                put("kin_edit", kinEdit)
                put("home_access", homeAccess)
                put("kintales_only", true)
            })
        })
        return raw["inviteId"]?.jsonPrimitive?.contentOrNull ?: error("addSecondaryContact: missing inviteId")
    }

    // -- Household members (PRIMARY edits a secondary's permissions) --
    /**
     * Lists the household members so a PRIMARY can edit each secondary's access.
     * Backed by the `listMembers` callable (PRIMARY-only; operator bypasses).
     * Each member's [Member.permissions] is fully populated (any absent flag
     * defaults to false) so the editor always has a complete shape to render.
     */
    suspend fun listMembers(kinfolkId: String? = null): List<Member> {
        val raw = fns.call("listMembers", kinfolkId?.let { buildJsonObject { put("kinfolkId", it) } })
        return (raw["members"] as? JsonArray)?.map { el ->
            val o = el.jsonObject
            Member(
                uid = o["uid"]?.jsonPrimitive?.contentOrNull ?: error("listMembers: member missing uid"),
                secondaryLabel = o["secondaryLabel"]?.jsonPrimitive?.contentOrNull,
                role = o["role"]?.jsonPrimitive?.contentOrNull ?: "SECONDARY",
                status = o["status"]?.jsonPrimitive?.contentOrNull ?: "INVITED",
                permissions = decodeMemberPermissions(o["permissions"] as? JsonObject),
                invitedEmail = o["invitedEmail"]?.jsonPrimitive?.contentOrNull,
            )
        }.orEmpty()
    }

    /**
     * Persists a secondary's permissions. Sends the five writable flags
     * (billing_full, messaging_direct, messaging_group, kin_edit, home_access).
     *
     * RULING: "Primary kinfolk is allowed to set the permissions of the
     * secondary, including billing if they want ... besides admin, primary
     * kinfolk can set permissions for the secondary." billing_full used to be
     * withheld here, and the callable's schema dropped it anyway, so a grant
     * returned ok and changed nothing. Both ends accept it now.
     *
     * kintales_only is still never sent: no path on any surface turns it off.
     * [familyId] is the kinfolkId. Every flag is sent explicitly so a toggle-off
     * reaches the server. Throws on auth/permission/validation (fail-loud).
     */
    suspend fun updateSecondaryPermissions(
        familyId: String,
        targetUid: String,
        billingFull: Boolean,
        messagingDirect: Boolean,
        messagingGroup: Boolean,
        kinEdit: Boolean,
        homeAccess: Boolean,
    ) {
        fns.call("updateSecondaryPermissions", buildJsonObject {
            put("familyId", familyId)
            put("targetUid", targetUid)
            put("permissions", buildJsonObject {
                put("billing_full", billingFull)
                put("messaging_direct", messagingDirect)
                put("messaging_group", messagingGroup)
                put("kin_edit", kinEdit)
                put("home_access", homeAccess)
            })
        })
    }

    /** Builds a complete [MemberPermissions] from the callable JSON, defaulting
     *  every absent flag to false (matches the server's projection). */
    private fun decodeMemberPermissions(obj: JsonObject?): MemberPermissions {
        if (obj == null) return MemberPermissions()
        fun flag(key: String) = obj[key]?.jsonPrimitive?.booleanOrNull ?: false
        return MemberPermissions(
            billing_full = flag("billing_full"),
            messaging_direct = flag("messaging_direct"),
            messaging_group = flag("messaging_group"),
            kin_edit = flag("kin_edit"),
            kintales_only = flag("kintales_only"),
            home_access = flag("home_access"),
        )
    }

    // -- FCM device tokens --
    suspend fun registerFcmToken(token: String, platform: String, appVersion: String? = null) {
        fns.call("registerFcmToken", buildJsonObject {
            put("token", token)
            put("platform", platform)
            appVersion?.let { put("appVersion", it) }
        })
    }

    suspend fun unregisterFcmToken(token: String) {
        fns.call("unregisterFcmToken", buildJsonObject { put("token", token) })
    }

    // -- Booking notes (kinfolk-facing subcollection) --
    /** Adds a kinfolk-facing note to one KinCare inside an envelope. Server
     *  enforces the 3hr-before-start cutoff and keeps back-compat for the old
     *  bookingId key, but we send the new {batchId, visitId, body} shape. */
    suspend fun addBookingNote(
        batchId: String,
        visitId: String,
        body: String,
        kinfolkId: String? = null,
    ): String {
        val raw = fns.call("addBookingNote", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("batchId", batchId)
            put("visitId", visitId)
            put("body", body)
        })
        return raw["noteId"]?.jsonPrimitive?.contentOrNull ?: error("addBookingNote: missing noteId")
    }

    /**
     * Asks the business to cancel one KinCare inside an envelope. Deliberately
     * NOT a status change: the server stamps a pending flag on the visit and
     * notifies the office; only the business cancels for real. A repeat ask on
     * the same visit returns alreadyPending=true, which the UI treats as
     * success (same pending state). Throws on auth/permission/validation and
     * when the visit is past its requested/confirmed window (fail-loud).
     */
    suspend fun requestBookingCancellation(
        batchId: String,
        visitId: String,
        reason: String? = null,
        kinfolkId: String? = null,
    ): CancelRequestResult {
        val raw = fns.call("requestBookingCancellation", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("batchId", batchId)
            put("visitId", visitId)
            reason?.trim()?.takeIf { it.isNotEmpty() }?.let { put("reason", it) }
        })
        return CancelRequestResult(
            ok = raw["ok"]?.jsonPrimitive?.booleanOrNull ?: false,
            visitId = raw["visitId"]?.jsonPrimitive?.contentOrNull ?: visitId,
            alreadyPending = raw["alreadyPending"]?.jsonPrimitive?.booleanOrNull ?: false,
        )
    }

    /**
     * Proposes a new time for one KinCare. Like the cancellation ask, this is
     * an ASK: the server records the proposed window and a pending flag, and
     * the visit keeps its own time and status until the office rules on it.
     * `admin/rescheduleBooking` is the only thing that moves a visit and stays
     * admin-gated.
     *
     * No end time is sent. The server carries the visit's current duration
     * over to the proposed start, which is what a household moving a 30-minute
     * drop-in to a different hour means, and is one fewer control on the
     * screen. The web portal makes the same call the same way.
     *
     * Throws fail-loud, and the server writes those messages for a household
     * to read: a past time comes back as invalid-argument, and a second ask
     * while one is pending comes back as already-exists naming the pending one.
     */
    suspend fun requestBookingReschedule(
        batchId: String,
        visitId: String,
        proposedStartTimeMs: Long,
        reason: String? = null,
        kinfolkId: String? = null,
    ): RescheduleRequestResult {
        val raw = fns.call("requestBookingReschedule", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("batchId", batchId)
            put("visitId", visitId)
            put("proposedStartTimeMs", proposedStartTimeMs)
            reason?.trim()?.takeIf { it.isNotEmpty() }?.let { put("reason", it) }
        })
        return RescheduleRequestResult(
            ok = raw["ok"]?.jsonPrimitive?.booleanOrNull ?: false,
            visitId = raw["visitId"]?.jsonPrimitive?.contentOrNull ?: visitId,
            proposedStartTimeMs = raw["proposedStartTimeMs"]?.jsonPrimitive?.longOrNull ?: proposedStartTimeMs,
            proposedEndTimeMs = raw["proposedEndTimeMs"]?.jsonPrimitive?.longOrNull,
        )
    }

    // -- Message Auntie (16.4): two-way kinfolk<->auntie conversation thread --
    /**
     * Sends a message from this kinfolk to the auntie. The server resolves the
     * caller's own kinfolkId (membership-checked) when omitted, appends to
     * conversations/{kinfolkId}/messages, and flags the thread unread for the
     * admin. Returns the new message id. Throws on auth/permission/validation.
     */
    suspend fun sendKinfolkMessage(
        body: String,
        kinfolkId: String? = null,
    ): String {
        val raw = fns.call("sendKinfolkMessage", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("body", body)
        })
        return raw["messageId"]?.jsonPrimitive?.contentOrNull ?: error("sendKinfolkMessage: missing messageId")
    }

    /**
     * Reads this kinfolk's own conversation thread (oldest-first) and clears the
     * kinfolk-side unread flag server-side. kinfolkId is resolved server-side when
     * omitted.
     */
    suspend fun getMyConversation(
        kinfolkId: String? = null,
    ): MyConversationResult {
        val raw = fns.call("getMyConversation", kinfolkId?.let { buildJsonObject { put("kinfolkId", it) } })
        val messages = (raw["messages"] as? JsonArray)?.map { el ->
            val o = el.jsonObject
            ConversationMessage(
                id = o["id"]?.jsonPrimitive?.contentOrNull ?: error("getMyConversation: message missing id"),
                senderRole = if (o["senderRole"]?.jsonPrimitive?.contentOrNull == "auntie") SenderRole.Auntie else SenderRole.Kinfolk,
                senderUid = o["senderUid"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                body = o["body"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                createdAtMs = o["createdAtMs"]?.jsonPrimitive?.longOrNull,
                deliveredAt = o["deliveredAt"]?.jsonPrimitive?.longOrNull,
                readAt = o["readAt"]?.jsonPrimitive?.longOrNull,
            )
        }.orEmpty()
        return MyConversationResult(
            kinfolkId = raw["kinfolkId"]?.jsonPrimitive?.contentOrNull ?: error("getMyConversation: missing kinfolkId"),
            messages = messages,
        )
    }

    /**
     * Explicitly stamps readAt on every unread auntie message in this
     * kinfolk's own thread and clears the kinfolk-side unread flag, without
     * a full getMyConversation refetch — for a thread already loaded and
     * showing a realtime-delivered new message. Returns how many messages
     * were marked (0 if none were unread).
     */
    suspend fun markThreadRead(
        kinfolkId: String? = null,
    ): Int {
        val raw = fns.call("markThreadRead", kinfolkId?.let { buildJsonObject { put("kinfolkId", it) } })
        return raw["markedCount"]?.jsonPrimitive?.intOrNull ?: 0
    }

    /**
     * AI message assist (O-8) via the generate callable. [mode] is "polish"
     * (rewrites [body], which is required then) or "suggest_reply" ([body]
     * ignored — the server reads the household thread itself). Returns the
     * plain-text result. Throws fail-loud on auth/validation and on server
     * errors like rate_limited / thread_empty / ai_unavailable.
     */
    suspend fun generateAssist(
        mode: String,
        body: String? = null,
        kinfolkId: String? = null,
    ): String {
        val raw = fns.call("generate", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("mode", mode)
            body?.let { put("body", it) }
        })
        return raw["text"]?.jsonPrimitive?.contentOrNull ?: error("generate result missing text")
    }

    // -- Invoice PDF (16.2): kinfolk downloads a PDF of their own invoice --
    /**
     * Renders + returns a download URL for the caller's own invoice PDF via the
     * getMyInvoicePdf portal callable (server scopes by kinfolkId + refuses other
     * households). Open the returned URL with openExternalUrl. Throws fail-loud.
     */
    suspend fun getMyInvoicePdf(
        invoiceId: String,
        kinfolkId: String? = null,
    ): String {
        val raw = fns.call("getMyInvoicePdf", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("invoiceId", invoiceId)
        })
        return raw["pdfUrl"]?.jsonPrimitive?.contentOrNull ?: error("getMyInvoicePdf: missing pdfUrl")
    }

    // -- KinTale sharing (primary kinfolk creates / revokes share links) --
    /**
     * Creates a public share link for a KinTale. Server enforces PRIMARY-only
     * via memberGate; secondary contacts get permission-denied.
     * Returns the share id + the full URL (configured via SHARE_LINK_BASE_URL).
     */
    suspend fun createShareLink(
        familyId: String,
        kinTaleId: String,
        includePhotos: Boolean = false,
        expiresInDays: Int? = null,
        passcode: String? = null,
    ): ShareLinkCreated {
        val raw = fns.call("createShareLink", buildJsonObject {
            put("familyId", familyId)
            put("kinTaleId", kinTaleId)
            put("includePhotos", includePhotos)
            expiresInDays?.let { put("expiresInDays", it) }
            passcode?.let { put("passcode", it) }
        })
        return ShareLinkCreated(
            shareId = raw["shareId"]?.jsonPrimitive?.contentOrNull
                ?: error("createShareLink: missing shareId"),
            shareUrl = raw["shareUrl"]?.jsonPrimitive?.contentOrNull
                ?: error("createShareLink: missing shareUrl"),
        )
    }

    /** Revokes an active share link. PRIMARY member OR the original creator. */
    suspend fun revokeShareLink(shareId: String) {
        fns.call("revokeShareLink", buildJsonObject { put("shareId", shareId) })
    }

    // -- KinTale comments (forum-style threaded) --
    /** Adds a comment to a KinTale. parentCommentId enables reply threading. */
    suspend fun addKinTaleComment(
        taleId: String,
        body: String,
        parentCommentId: String? = null,
        kinfolkId: String? = null,
    ): String {
        val raw = fns.call("addKinTaleComment", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("taleId", taleId)
            put("body", body)
            parentCommentId?.let { put("parentCommentId", it) }
        })
        return raw["commentId"]?.jsonPrimitive?.contentOrNull ?: error("addKinTaleComment: missing commentId")
    }

    /** Reads comments for a KinTale (one-shot; client refetches after post). */
    suspend fun getMyKinTaleComments(
        kinfolkId: String? = null,
        taleId: String,
    ): List<KinTaleComment> {
        val raw = fns.call("getKinTaleComments", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("taleId", taleId)
        })
        return (raw["comments"] as? JsonArray)?.map { el ->
            val o = el.jsonObject
            val role = when (o["authorRole"]?.jsonPrimitive?.contentOrNull) {
                "admin" -> CommentAuthorRole.Admin
                "guest" -> CommentAuthorRole.Guest
                else -> CommentAuthorRole.Kinfolk
            }
            KinTaleComment(
                id = o["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                authorRole = role,
                authorDisplayName = null,
                guestName = o["guestName"]?.jsonPrimitive?.contentOrNull,
                body = o["body"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                parentCommentId = o["parentCommentId"]?.jsonPrimitive?.contentOrNull,
                createdAtMs = o["createdAtMs"]?.jsonPrimitive?.longOrNull,
            )
        }.orEmpty()
    }

    // -- KinTale reactions (single love/heart toggle) --
    /** Current reaction state for one tale: has the caller loved it, and how many total. */
    suspend fun getKinTaleReaction(kinfolkId: String? = null, taleId: String): KinTaleReaction {
        val raw = fns.call("getKinTaleReaction", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("taleId", taleId)
        })
        return decodeKinTaleReaction(raw)
    }

    /** Toggles the caller's own reaction on/off; returns the new state. */
    suspend fun toggleKinTaleLove(kinfolkId: String? = null, taleId: String): KinTaleReaction {
        val raw = fns.call("toggleKinTaleLove", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("taleId", taleId)
        })
        return decodeKinTaleReaction(raw)
    }

    private fun decodeKinTaleReaction(raw: JsonObject): KinTaleReaction = KinTaleReaction(
        loved = raw["loved"]?.jsonPrimitive?.booleanOrNull ?: false,
        loveCount = raw["loveCount"]?.jsonPrimitive?.intOrNull ?: 0,
    )

    // -- KinTale media --
    suspend fun getMyKinTaleMedia(kinfolkId: String? = null, taleId: String): List<KinTaleMedia> {
        val raw = fns.call("getMyKinTaleMedia", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("taleId", taleId)
        })
        return (raw["media"] as? JsonArray)?.map { el ->
            val o = el.jsonObject
            KinTaleMedia(
                id = o["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                url = o["url"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                contentType = o["contentType"]?.jsonPrimitive?.contentOrNull,
                expiresAtMs = o["expiresAtMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            )
        }.orEmpty()
    }

    /**
     * One page of the household's photo archive, for the Gallery screen.
     *
     * [before] is the previous page's `nextBefore` (the last tale's sent time),
     * the same opaque cursor `getMyKinTales` uses, and [limit] counts TALES,
     * not photos: a tale can carry twenty pictures or none. Portraits arrive on
     * the first page only, so passing [before] returns an empty portrait list.
     *
     * A photo entry with no id or no url is skipped rather than surfaced as a
     * blank tile, the same tolerance the KinTale `thumbs` decode applies.
     */
    suspend fun getMyKinPhotos(
        kinfolkId: String? = null,
        limit: Int? = null,
        before: Long? = null,
    ): KinPhotosResult {
        val payload: JsonObject? = if (kinfolkId == null && limit == null && before == null) null
        else buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            limit?.let { put("limit", it) }
            before?.let { put("before", it) }
        }
        val raw = fns.call("getMyKinPhotos", payload)
        val photos = (raw["photos"] as? JsonArray)?.mapNotNull { el ->
            val o = el.jsonObject
            val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val url = o["url"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            KinPhoto(
                id = id,
                url = url,
                contentType = o["contentType"]?.jsonPrimitive?.contentOrNull,
                taleId = o["taleId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                taleTitle = o["taleTitle"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                takenAtMs = o["takenAtMs"]?.jsonPrimitive?.longOrNull,
            )
        }.orEmpty()
        val portraits = (raw["portraits"] as? JsonArray)?.mapNotNull { el ->
            val o = el.jsonObject
            val kinId = o["kinId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val url = o["url"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            KinPortrait(
                kinId = kinId,
                kinName = o["kinName"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                url = url,
            )
        }.orEmpty()
        return KinPhotosResult(
            photos = photos,
            portraits = portraits,
            hasMore = raw["hasMore"]?.jsonPrimitive?.booleanOrNull ?: false,
            nextBefore = raw["nextBefore"]?.jsonPrimitive?.longOrNull,
        )
    }

    // -- Helpers --
    private fun decodeBooking(o: JsonObject): Booking = Booking(
        id = o["id"]?.jsonPrimitive?.contentOrNull ?: error("booking: missing id"),
        kinfolkId = o["kinfolkId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        status = when (o["status"]?.jsonPrimitive?.contentOrNull) {
            "confirmed" -> BookingStatus.Confirmed
            "enRoute" -> BookingStatus.EnRoute
            "active" -> BookingStatus.Active
            "completed" -> BookingStatus.Completed
            "cancelled" -> BookingStatus.Cancelled
            else -> BookingStatus.Requested
        },
        serviceType = o["serviceType"]?.jsonPrimitive?.contentOrNull,
        title = o["title"]?.jsonPrimitive?.contentOrNull,
        startTimeMs = o["startTimeMs"]?.jsonPrimitive?.longOrNull,
        endTimeMs = o["endTimeMs"]?.jsonPrimitive?.longOrNull,
        kinIds = (o["kinIds"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
        kinNames = (o["kinNames"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
        auntieDisplayName = o["auntieDisplayName"]?.jsonPrimitive?.contentOrNull,
        auntieAvatarUrl = o["auntieAvatarUrl"]?.jsonPrimitive?.contentOrNull,
        notes = o["notes"]?.jsonPrimitive?.contentOrNull,
        createdAtMs = o["createdAtMs"]?.jsonPrimitive?.longOrNull,
        visitProgress = when (o["visitProgress"]?.jsonPrimitive?.contentOrNull) {
            "confirmed" -> VisitProgress.Confirmed
            "enRoute" -> VisitProgress.EnRoute
            "active" -> VisitProgress.Active
            "ended" -> VisitProgress.Ended
            else -> null
        },
        batchId = o["batchId"]?.jsonPrimitive?.contentOrNull,
        sourceBookingId = o["sourceBookingId"]?.jsonPrimitive?.contentOrNull,
        sessionId = o["sessionId"]?.jsonPrimitive?.contentOrNull,
        cancelRequested = o["cancelRequested"]?.jsonPrimitive?.booleanOrNull ?: false,
        cancelRequestStatus = decodeCancelStatus(o["cancelRequestStatus"]?.jsonPrimitive?.contentOrNull),
        cancelRequestReason = o["cancelRequestReason"]?.jsonPrimitive?.contentOrNull,
        cancelResponseNote = o["cancelResponseNote"]?.jsonPrimitive?.contentOrNull,
        rescheduleRequestStatus = decodeRescheduleStatus(o["rescheduleRequestStatus"]?.jsonPrimitive?.contentOrNull),
        rescheduleRequestedStartTimeMs = o["rescheduleRequestedStartTimeMs"]?.jsonPrimitive?.longOrNull,
        rescheduleRequestedEndTimeMs = o["rescheduleRequestedEndTimeMs"]?.jsonPrimitive?.longOrNull,
        rescheduleRequestReason = o["rescheduleRequestReason"]?.jsonPrimitive?.contentOrNull,
        rescheduleResponseNote = o["rescheduleResponseNote"]?.jsonPrimitive?.contentOrNull,
    )

    /**
     * Absent, null, or anything this client does not model reads as "never
     * asked". An older deployed getMyBookings that predates the reschedule ask
     * sends no such field at all, and that has to decode as no ask rather than
     * as a crash.
     */
    private fun decodeRescheduleStatus(raw: String?): RescheduleRequestStatus? = when (raw) {
        "pending" -> RescheduleRequestStatus.Pending
        "accepted" -> RescheduleRequestStatus.Accepted
        "declined" -> RescheduleRequestStatus.Declined
        else -> null
    }

    /**
     * The cancellation ask's state (#438). Same tolerance as the reschedule
     * decoder above: absent, null, or anything this client does not model reads
     * as "never asked", because a getMyBookings deployed before #438 sends no
     * such field.
     */
    private fun decodeCancelStatus(raw: String?): CancelRequestStatus? = when (raw) {
        "pending" -> CancelRequestStatus.Pending
        "accepted" -> CancelRequestStatus.Accepted
        "declined" -> CancelRequestStatus.Declined
        else -> null
    }

    private fun decodeEnvelopeStatus(raw: String?): EnvelopeStatus = when (raw) {
        "partiallyConfirmed" -> EnvelopeStatus.PartiallyConfirmed
        "confirmed" -> EnvelopeStatus.Confirmed
        "inProgress" -> EnvelopeStatus.InProgress
        "completed" -> EnvelopeStatus.Completed
        "cancelled" -> EnvelopeStatus.Cancelled
        else -> EnvelopeStatus.Requested
    }

    private fun decodeEnvelope(o: JsonObject): BookingEnvelope = BookingEnvelope(
        batchId = o["batchId"]?.jsonPrimitive?.contentOrNull ?: error("envelope: missing batchId"),
        envelopeStatus = decodeEnvelopeStatus(o["envelopeStatus"]?.jsonPrimitive?.contentOrNull),
        pattern = o["pattern"]?.jsonPrimitive?.contentOrNull,
        serviceName = o["serviceName"]?.jsonPrimitive?.contentOrNull,
        kinIds = (o["kinIds"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
        kinNames = (o["kinNames"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
        notes = o["notes"]?.jsonPrimitive?.contentOrNull,
        visitCount = o["visitCount"]?.jsonPrimitive?.longOrNull?.toInt() ?: 0,
        confirmedCount = o["confirmedCount"]?.jsonPrimitive?.longOrNull?.toInt() ?: 0,
        completedCount = o["completedCount"]?.jsonPrimitive?.longOrNull?.toInt() ?: 0,
        firstStartTimeMs = o["firstStartTimeMs"]?.jsonPrimitive?.longOrNull,
        lastStartTimeMs = o["lastStartTimeMs"]?.jsonPrimitive?.longOrNull,
        kinCares = (o["kinCares"] as? JsonArray)?.map { decodeBooking(it.jsonObject) }.orEmpty(),
    )

    /**
     * The stored Invoice State Stamp, every state of it.
     *
     * A state this decoder does not name does not go missing. It arrives
     * wearing another state's clothes. `quote` used to fall through to `Open`,
     * which put a Pay button on a proposal (issue #385), and `zero` and
     * `redeemed` fell through the same hole until issue #449.
     *
     * The `else` stays `Open` rather than throwing, and stays a STRING read: it
     * is the same fail-soft the server's own `statusFromStamp` applies to a doc
     * it cannot read, so an older or newer backend leaves the household looking
     * at an invoice rather than an error. Nothing reaches it today.
     */
    private fun decodeInvoiceStatus(raw: String?): InvoiceStatus = when (raw) {
        "paid" -> InvoiceStatus.Paid
        "credit" -> InvoiceStatus.Credit
        "redeemed" -> InvoiceStatus.Redeemed
        "draft" -> InvoiceStatus.Draft
        "quote" -> InvoiceStatus.Quote
        "zero" -> InvoiceStatus.Zero
        "cancelled" -> InvoiceStatus.Cancelled
        else -> InvoiceStatus.Open
    }
    private fun decodeInvoice(el: JsonElement): Invoice {
        val o = el.jsonObject
        val statusStr = o["status"]?.jsonPrimitive?.contentOrNull
        return Invoice(
            id = o["id"]?.jsonPrimitive?.contentOrNull ?: error("invoice: missing id"),
            kinfolkId = o["kinfolkId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            kinfolkName = o["kinfolkName"]?.jsonPrimitive?.contentOrNull,
            client = o["client"]?.jsonPrimitive?.contentOrNull,
            total = o["total"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
            amountDue = o["amountDue"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
            isPaid = o["isPaid"]?.jsonPrimitive?.booleanOrNull ?: false,
            status = decodeInvoiceStatus(statusStr),
            date = o["date"]?.jsonPrimitive?.contentOrNull,
            dueDate = o["dueDate"]?.jsonPrimitive?.contentOrNull,
            discount = o["discount"]?.jsonPrimitive?.contentOrNull,
            terms = o["terms"]?.jsonPrimitive?.contentOrNull,
            paymentsHistory = o["paymentsHistory"]?.jsonPrimitive?.contentOrNull,
            address = o["address"]?.jsonPrimitive?.contentOrNull,
            viewed = o["viewed"]?.jsonPrimitive?.booleanOrNull ?: false,
            creditAmountCents = o["creditAmountCents"]?.jsonPrimitive?.longOrNull,
            creditTarget = when (o["creditTarget"]?.jsonPrimitive?.contentOrNull) {
                "accountBalance" -> CreditTarget.AccountBalance
                "originalPaymentMethod" -> CreditTarget.OriginalPaymentMethod
                else -> null
            },
            creditRedeemedAtMs = o["creditRedeemedAtMs"]?.jsonPrimitive?.longOrNull,
            quoteDecision = when (o["quoteDecision"]?.jsonPrimitive?.contentOrNull) {
                "accepted" -> QuoteDecision.Accepted
                "denied" -> QuoteDecision.Denied
                else -> null
            },
            quoteDecidedAtMs = o["quoteDecidedAtMs"]?.jsonPrimitive?.longOrNull,
            originalPaymentIntentId = o["originalPaymentIntentId"]?.jsonPrimitive?.contentOrNull,
            // Optional per-visit breakdown; lenient so an older backend (field
            // absent) or a malformed payload just yields null, never a throw.
            lineItems = (o["lineItems"] as? JsonArray)
                ?.mapNotNull { it as? JsonObject }
                ?.map { li ->
                    InvoiceLineItem(
                        sessionId = li["sessionId"]?.jsonPrimitive?.contentOrNull,
                        label = li["label"]?.jsonPrimitive?.contentOrNull,
                        dateIso = li["dateIso"]?.jsonPrimitive?.contentOrNull,
                        amountCents = li["amountCents"]?.jsonPrimitive?.longOrNull,
                        qty = li["qty"]?.jsonPrimitive?.doubleOrNull,
                        unitCents = li["unitCents"]?.jsonPrimitive?.longOrNull,
                    )
                }
                ?.takeIf { it.isNotEmpty() },
            // ISSUE #409: this bill's own payment options. `null` when the key
            // is absent (a server older than the field), which the controller
            // reads as "ask the home list instead". An EMPTY array is a real
            // answer — a settled bill offers nothing — and stays empty.
            payMethods = (o["payMethods"] as? JsonArray)?.let { decodePayMethods(it) },
        )
    }

    private fun decodeCustomFields(el: JsonElement?): List<CustomField> {
        val arr = el as? JsonArray ?: return emptyList()
        return arr.map { it.jsonObject }.map {
            CustomField(
                key = it["key"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                label = it["label"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                value = it["value"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            )
        }
    }

    private fun encodeCustomFields(list: List<CustomField>): JsonArray = buildJsonArray {
        list.forEach { cf ->
            add(buildJsonObject {
                put("key", cf.key)
                put("label", cf.label)
                put("value", cf.value)
            })
        }
    }
}

data class MyHomeResult(
    val kinfolkId: String,
    val displayName: String,
    val businessLogoUrl: String = "",
    val businessName: String = "",
    /** Shared MyTribe portal config (branding, home layout, banner, chat). */
    val portal: PortalConfig = PortalConfig(),
    /** True when the signed-in user has dismissed the current banner id
     *  (`dismissMode == perUser`); the client hides the banner accordingly. */
    val bannerDismissedByUser: Boolean = false,
    /**
     * PR30: every payment processor the operator has configured, business-
     * level (not filtered to a specific invoice — see `getMyHome.ts`).
     * Defaults empty like [lineItems][InvoiceLineItem] elsewhere in this
     * file: decode is lenient, so an old server or a malformed entry simply
     * yields no methods rather than a decode failure, and callers fall back
     * to a Stripe-only list (`InvoicesController`) so a household can still
     * pay.
     */
    val payMethods: List<PayMethod> = emptyList(),
)

data class MyAccessResult(
    val kinfolkIds: List<String>,
    val isOperator: Boolean,
)

/** Lightweight tribe identity for the picker — id + display name. */
data class TribeSummary(
    val id: String,
    val displayName: String,
)
