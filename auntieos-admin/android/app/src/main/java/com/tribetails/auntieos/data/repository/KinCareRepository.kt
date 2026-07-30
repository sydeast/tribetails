package com.tribetails.auntieos.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.model.GpsSummary
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.LocationPoint
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.model.VisitStatus
import com.tribetails.auntieos.data.model.createdAtIso
import com.tribetails.auntieos.domain.scopedKinfolkId
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

/**
 * The KIN CARE domain repo (W4-3): a visit from the moment it is scheduled to
 * the KinTale the household receives afterwards. Second of the per-domain repos
 * carved out of the `AuntieRepository` god-file, after Invoice (W4-1).
 *
 * WHAT "KIN CARE" MEANS HERE, so the boundary is a rule rather than a habit:
 * this repo owns the two `kin_care_*` collections and the MyTribe booking
 * envelope they write back to.
 *
 *  - `kin_care_sessions`: the visit itself, its lifecycle status and timestamps,
 *    and the breadcrumbs subcollection hanging off it.
 *  - `kin_care_reports`: the KinTale written about a visit. It is not a separate
 *    domain because it cannot be written without writing the session: creating a
 *    report appends to the session's `reportIds`, and sending one bumps
 *    `sentReportCount` and flips `autoCompleteEligible`, which is the rule the
 *    dashboard's auto-complete sweep reads. Splitting the two would put two
 *    repos on one document.
 *  - `families/{id}/bookings/{batchId}/kinCares/{visitId}`: the originating
 *    MyTribe booking envelope. Staff actions write back onto it so the kinfolk's
 *    live state resolves, and assignment is never mirrored onto the flat
 *    session, so this doc is the only client-side source for who is going.
 *
 * The breadcrumbs subcollection came along because it is stored INSIDE the
 * session document tree (`kin_care_sessions/{id}/breadcrumbs/{autoId}`), and a
 * carve that leaves another repo writing this tree is a fork rather than a
 * carve. The root-level location collections it is read alongside -
 * `visit_routes`, `location_checkpoints`, `location_sharing_preferences` - are
 * untouched here and belong to the Location carve; if that carve wants the three
 * breadcrumb methods, they move as three methods between two domain repos.
 *
 * NOT HERE, deliberately: the invoice a visit is billed on. PR #105 moved the
 * session `invoiceId` write off this surface and PR #106 revoked client invoice
 * writes entirely, so a session is linked to an invoice by the
 * `linkInvoiceSessions` callable, which owns both directions inside one
 * transaction. This repo reads sessions for the link picker and never writes
 * that field; [InvoiceRepository] owns the callable.
 *
 * @param authGate W4-2's shared sign-in gate and `testTribeId` claim source. The
 *   default [AuthGate.shared] keeps the claim read and its cache in one place
 *   across every repo; this file neither copies the sign-in check nor reads the
 *   claim itself.
 * @param authProvider a [FirebaseAuth] handle of this repo's own, for the two
 *   places kin care needs the signed-in operator's IDENTITY rather than the
 *   gate's two questions: stamping a new report's author, and refusing to attach
 *   a snapshot listener while signed out.
 */
class KinCareRepository(
    internal val authGate: AuthGate = AuthGate.shared,
    functionsProvider: () -> FirebaseFunctions = { FirebaseFunctions.getInstance("us-central1") },
    firestoreProvider: () -> FirebaseFirestore = { FirebaseFirestore.getInstance() },
    authProvider: () -> FirebaseAuth = { FirebaseAuth.getInstance() },
) {
    // Lazy so merely constructing the repo (e.g. as a ViewModel default in a
    // Firebase-less Robolectric test) never eagerly touches Firebase singletons.
    // Same reason as InvoiceRepository's providers.
    private val functions: FirebaseFunctions by lazy(functionsProvider)
    private val firestore: FirebaseFirestore by lazy(firestoreProvider)
    private val auth: FirebaseAuth by lazy(authProvider)

    /**
     * The Stage-0I seam, built exactly as [InvoiceRepository] builds its own:
     * over this repo's firestore handle, sourcing its mode from [authGate] so a
     * new kinfolk-scoped read here cannot forget the sandbox constraint.
     */
    private val scoped: ScopedFirestore by lazy { ScopedFirestore(firestore, authGate::requireTestMode) }

    // --- Kin Care Sessions ---

    suspend fun getKinCareSessions(): Result<List<KinCareSession>> = runCatching {
        authGate.ensureAuthenticated()
        scoped.scopedQuery("kin_care_sessions").toObjects(KinCareSession::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care sessions", it) }

    suspend fun getKinCareSession(sessionId: String): Result<KinCareSession?> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("kin_care_sessions").document(sessionId).get().await()
        snapshot.toObject(KinCareSession::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care session $sessionId", it) }

    suspend fun getKinCareSessionsForKinfolk(kinfolkId: String): Result<List<KinCareSession>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("kin_care_sessions")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get()
            .await()
        snapshot.toObjects(KinCareSession::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care sessions for $kinfolkId", it) }

    suspend fun getKinCareSessionsBySourceBookingId(sourceBookingId: String): Result<List<KinCareSession>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("kin_care_sessions")
            .whereEqualTo("sourceBookingId", sourceBookingId)
            .get()
            .await()
        snapshot.toObjects(KinCareSession::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care sessions for source booking $sourceBookingId", it) }

    suspend fun createKinCareSession(session: KinCareSession): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        // Write stamp, not a query: scopedKinfolkId forces the sandbox scope in
        // test mode and passes the caller's kinfolkId through otherwise.
        val mode = authGate.requireTestMode()
        val session = session.copy(kinfolkId = mode.scopedKinfolkId(session.kinfolkId))
        val docRef = firestore.collection("kin_care_sessions").document()
        val timestamp = getCurrentTimestamp()

        // Auto-fill kinIds from the kinfolk's active kin if the caller didn't supply them.
        // KinTale rendering is per-kin, so an empty kinIds list would make the report
        // show no per-pet checklist items.
        val kinIds = if (session.kinIds.isEmpty() && session.kinfolkId.isNotBlank()) {
            kinForKinfolk(session.kinfolkId).getOrDefault(emptyList())
                .filter { it.status == "active" }
                .map { it.id }
        } else session.kinIds

        docRef.set(session.copy(
            id = docRef.id,
            kinIds = kinIds,
            createdAt = if (session.createdAtIso().isBlank()) timestamp else session.createdAt,
            updatedAt = timestamp
        )).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to create kin care session", it) }

    /**
     * Writes every modelled field of one session. No caller in the app today;
     * carried over rather than deleted, because this repo predates its own git
     * history and an absent caller here is not evidence a surface was never
     * wired. Latent, therefore, but it is a loaded gun: the day something calls
     * it, a bare set() would take the provenance fields with it.
     *
     * MERGE for the same reason as [updateKinCareReport] below. `kin_care_sessions`
     * carries `_backfilledFrom`, `_backfilledAt`, and `_reason` on the stub
     * sessions `cleanup_prod_data_pass2.py:87-89` created for pre-cutover orphan
     * visit_logs. [KinCareSession] declares none of them, so a bare set() erases
     * the only record of why those documents exist.
     */
    suspend fun updateKinCareSession(session: KinCareSession): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("kin_care_sessions").document(session.id)
            .set(
                session.copy(updatedAt = getCurrentTimestamp()),
                com.google.firebase.firestore.SetOptions.merge(),
            )
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update kin care session ${session.id}", it) }

    suspend fun getKinCareSessionsForDay(dayStartIso: String, dayEndIso: String): Result<List<KinCareSession>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = scoped.scopedQuery("kin_care_sessions") {
            whereGreaterThanOrEqualTo("startTime", dayStartIso)
                .whereLessThan("startTime", dayEndIso)
                .orderBy("startTime")
        }
        snapshot.toObjects(KinCareSession::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care sessions for day", it) }

    /**
     * Patches a single Kin Care session with the given fields. Used by Auntie
     * Time row buttons to flip status + drop the matching lifecycle timestamp
     * in one round-trip. Pass empty-string to clear a field (e.g. Undo Arrived).
     */
    suspend fun patchKinCareSession(id: String, patch: Map<String, Any>): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("kin_care_sessions").document(id).update(patch).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to patch KinCareSession $id", it) }

    // ---- Session GPS summary (parity w/ AuntieOS web) ----
    suspend fun saveSessionGpsSummary(sessionId: String, summary: GpsSummary): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(sessionId.isNotBlank()) { "sessionId required" }
        firestore.collection("kin_care_sessions").document(sessionId)
            .set(mapOf("gpsSummary" to summary), com.google.firebase.firestore.SetOptions.merge())
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to save session gpsSummary $sessionId", it) }

    // --- Visit lifecycle transitions ---

    private suspend fun patchSession(sessionId: String, updates: Map<String, Any>): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        val patched = updates.toMutableMap().apply { put("updatedAt", getCurrentTimestamp()) }
        firestore.collection("kin_care_sessions").document(sessionId)
            .update(patched)
            .await()
        Unit
    }

    suspend fun markSessionOnMyWay(sessionId: String, etaMinutes: Int): Result<Unit> =
        patchSession(sessionId, mapOf(
            "status" to VisitStatus.ON_MY_WAY.name,
            "onMyWayAt" to getCurrentTimestamp(),
            "etaMinutesAway" to etaMinutes
        )).onFailure { AuntieLog.e("Failed to mark on-my-way for $sessionId", it) }

    suspend fun markSessionArrived(sessionId: String, visitRouteId: String): Result<Unit> =
        patchSession(sessionId, mapOf(
            "status" to VisitStatus.ARRIVED.name,
            "arrivedAt" to getCurrentTimestamp(),
            "visitRouteId" to visitRouteId
        )).onFailure { AuntieLog.e("Failed to mark arrived for $sessionId", it) }

    suspend fun markSessionDeparted(sessionId: String): Result<Unit> =
        patchSession(sessionId, mapOf(
            "status" to VisitStatus.DEPARTED.name,
            "departedAt" to getCurrentTimestamp()
        )).onFailure { AuntieLog.e("Failed to mark departed for $sessionId", it) }

    suspend fun markSessionComplete(sessionId: String): Result<Unit> =
        patchSession(sessionId, mapOf(
            "status" to VisitStatus.COMPLETED.name,
            "completedAt" to getCurrentTimestamp()
        )).onFailure { AuntieLog.e("Failed to mark complete for $sessionId", it) }

    // ---- Care-ops session callables (1E §A.9) ----

    /** 1E §A.9: create a SCHEDULED kin_care_sessions doc. Returns the new session id. */
    suspend fun createKinCareSession(
        kinfolkId: String,
        kinIds: List<String>,
        serviceType: String,
        startTime: String,
        endTime: String,
        serviceDurationMinutes: Int = 0,
        notes: String = "",
    ): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        val mode = authGate.requireTestMode()
        val kinfolkId = mode.scopedKinfolkId(kinfolkId)
        val payload = mapOf(
            "kinfolkId" to kinfolkId, "kinIds" to kinIds, "serviceType" to serviceType,
            "startTime" to startTime, "endTime" to endTime,
            "serviceDurationMinutes" to serviceDurationMinutes, "notes" to notes,
        )
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("createKinCareSession").call(payload).await().data as? Map<String, Any?>
            ?: error("createKinCareSession: non-map payload")
        raw["sessionId"] as? String ?: error("createKinCareSession: missing sessionId")
    }.onFailure { AuntieLog.e("createKinCareSession failed", it) }

    /** 1E §A.9: reschedule an existing session (Schedule drag / Bookings reschedule). */
    suspend fun rescheduleBooking(sessionId: String, startTime: String, endTime: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        functions.getHttpsCallable("rescheduleBooking")
            .call(mapOf("sessionId" to sessionId, "startTime" to startTime, "endTime" to endTime))
            .await()
        Unit
    }.onFailure { AuntieLog.e("rescheduleBooking failed", it) }

    // ---- Breadcrumbs subcollection (canonical GPS storage; parity w/ AuntieOS web FirestoreClient) ----
    //
    // Per bug-sprint architecture: GPS points live in
    // `kin_care_sessions/{sessionId}/breadcrumbs/{autoId}` - NOT as an array on
    // the parent doc.

    suspend fun addBreadcrumb(sessionId: String, point: LocationPoint): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        require(sessionId.isNotBlank()) { "sessionId required" }
        // LocationPoint stamps `timestamp = System.currentTimeMillis()` at construction by default;
        // LocationTrackingService overrides with `location.time` from the actual GPS fix. Caller is
        // authoritative - no re-stamp here.
        val docRef = firestore.collection("kin_care_sessions")
            .document(sessionId)
            .collection("breadcrumbs")
            .add(point)
            .await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to add breadcrumb for session $sessionId", it) }

    suspend fun getBreadcrumbs(sessionId: String): Result<List<LocationPoint>> = runCatching {
        authGate.ensureAuthenticated()
        require(sessionId.isNotBlank()) { "sessionId required" }
        val snapshot = firestore.collection("kin_care_sessions")
            .document(sessionId)
            .collection("breadcrumbs")
            .orderBy("timestamp")
            .get()
            .await()
        breadcrumbsOrderedByTimestamp(snapshot.toObjects(LocationPoint::class.java))
    }.onFailure { AuntieLog.e("Failed to get breadcrumbs for session $sessionId", it) }

    // Auth check via checkAuthOrCloseFlow() short-circuits the flow immediately
    // when unauthenticated, consistent with observeCalls/observeVoicemails/observeSmsMessages.
    // Firestore snapshot listener also surfaces auth errors via the `error != null` branch.
    fun observeBreadcrumbs(sessionId: String): Flow<Result<List<LocationPoint>>> = callbackFlow {
        if (sessionId.isBlank()) {
            trySend(Result.failure(IllegalArgumentException("sessionId required")))
            close()
            return@callbackFlow
        }
        if (!checkAuthOrCloseFlow("observeBreadcrumbs")) return@callbackFlow
        val reg = firestore.collection("kin_care_sessions")
            .document(sessionId)
            .collection("breadcrumbs")
            .orderBy("timestamp")
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    AuntieLog.e("Breadcrumbs snapshot listener failed for session $sessionId", error)
                    trySend(Result.failure(error))
                    return@addSnapshotListener
                }
                val points = snapshot?.toObjects(LocationPoint::class.java).orEmpty()
                trySend(Result.success(breadcrumbsOrderedByTimestamp(points)))
            }
        awaitClose { reg.remove() }
    }

    // --- MyTribe booking envelope (families/{id}/bookings/{batchId}/kinCares/{visitId}) ---

    /**
     * Patches the originating MyTribe kinCare doc at
     * families/{familyId}/bookings/{batchId}/kinCares/{visitId}. This is the
     * booking-envelope write-back path: AuntieOS staff actions (approve, lifecycle
     * transitions) flow back onto the kinCare so the kinfolk's MyTribe live state
     * resolves. Mirrors [patchKinCareSession] but targets the family-tree doc
     * rather than the flat kin_care_sessions collection. Skips silently when the
     * session has no kinCare linkage (AuntieOS-native sessions).
     */
    suspend fun patchKinCareDoc(
        familyId: String,
        batchId: String,
        visitId: String,
        patch: Map<String, Any?>,
    ): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(familyId.isNotBlank() && batchId.isNotBlank() && visitId.isNotBlank()) {
            "patchKinCareDoc requires familyId, batchId, visitId"
        }
        firestore
            .document("families/$familyId/bookings/$batchId/kinCares/$visitId")
            .update(patch)
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to patch kinCare doc families/$familyId/bookings/$batchId/kinCares/$visitId", it) }

    /**
     * One-shot read of the assignment fields off the MyTribe kinCare doc at
     * families/{familyId}/bookings/{batchId}/kinCares/{visitId}. Assignment is
     * never mirrored onto kin_care_sessions, so this is the only client-side
     * source. Both fields null when the visit is unassigned or the doc is gone.
     */
    suspend fun getKinCareAssignment(
        familyId: String,
        batchId: String,
        visitId: String,
    ): Result<com.tribetails.auntieos.data.model.KinCareAssignment> = runCatching {
        authGate.ensureAuthenticated()
        require(familyId.isNotBlank() && batchId.isNotBlank() && visitId.isNotBlank()) {
            "getKinCareAssignment requires familyId, batchId, visitId"
        }
        val snap = firestore
            .document("families/$familyId/bookings/$batchId/kinCares/$visitId")
            .get()
            .await()
        com.tribetails.auntieos.data.model.KinCareAssignment(
            assignedAuntieUid = snap.getString("assignedAuntieUid"),
            auntieDisplayName = snap.getString("auntieDisplayName"),
        )
    }.onFailure { AuntieLog.e("Failed to read kinCare assignment families/$familyId/bookings/$batchId/kinCares/$visitId", it) }

    /**
     * Assigns (auntieUid set) or unassigns (auntieUid = null) an Auntie on one
     * KinCare visit via the admin assignAuntie callable. The backend resolves
     * the display name from staff/{uid} and the onBookingsWrite trigger owns
     * the assignment notifications, so this only sends ids.
     */
    suspend fun assignAuntie(
        kinfolkId: String,
        batchId: String,
        visitId: String,
        auntieUid: String?,
    ): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        functions.getHttpsCallable("assignAuntie")
            .call(assignAuntiePayload(kinfolkId, batchId, visitId, auntieUid))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to assign Auntie on visit $visitId", it) }

    /**
     * The staff roster (one entry per staff/{uid} doc) via the admin listStaff
     * callable, for the Assigned Auntie picker. The server sorts by displayName;
     * [decodeListStaff] re-sorts defensively so the picker reads stably either way.
     */
    suspend fun listStaff(): Result<List<StaffMember>> = runCatching {
        authGate.ensureAuthenticated()
        val raw = functions.getHttpsCallable("listStaff")
            .call(emptyMap<String, Any?>())
            .await()
            .data as? Map<*, *>
        decodeListStaff(raw)
    }.onFailure { AuntieLog.e("Failed to list staff", it) }

    // --- Kin Care Reports (KinTales) ---

    suspend fun createKinCareReport(report: KinCareReport): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        // Write stamp, not a query: scopedKinfolkId forces the sandbox scope in
        // test mode and passes the caller's kinfolkId through otherwise.
        val mode = authGate.requireTestMode()
        val report = report.copy(kinfolkId = mode.scopedKinfolkId(report.kinfolkId))
        val docRef = firestore.collection("kin_care_reports").document()
        val timestamp = getCurrentTimestamp()
        val currentUser = auth.currentUser
        val newReport = report.copy(
            id = docRef.id,
            authorId = currentUser?.uid ?: "",
            authorDisplayName = currentUser?.displayName ?: "Auntie",
            createdAt = timestamp,
            updatedAt = timestamp
        )
        docRef.set(newReport).await()
        // Append to session's reportIds
        firestore.collection("kin_care_sessions").document(report.sessionId)
            .update("reportIds", com.google.firebase.firestore.FieldValue.arrayUnion(docRef.id))
            .await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to create kin care report", it) }

    /**
     * Saves an operator's edits to one KinTale.
     *
     * MERGE, never a bare set(). A bare set() replaces the whole document, so
     * every field the backend writes but [KinCareReport] does not declare is
     * DELETED by an ordinary draft save. On `kin_care_reports` that is not a
     * hypothetical: `reconcile_comms.py` runs this collection through the same
     * pending-queue as the comm logs (`LOG_COLLECTIONS[:43]`), selecting work
     * with `.where("reconcileStatus", "==", "pending")` (`:704`) and stamping
     * `reconcileStatus`, `reconciledAt`, `reconcileNotes` (`:731-734,748-751`)
     * plus `reconcileClaimedAt` on the atomic claim (`:657,675`). None of those
     * four are on the model. Erase `reconcileStatus` and the KinTale leaves the
     * nightly pass PERMANENTLY - the query can no longer see it - so its content
     * never reaches the kinfolk dossier, and nothing anywhere reports a failure.
     * Also erased: `_migratedFrom` / `_migratedAt`, the provenance the May
     * visit_logs migration stamped (`migrate_visit_logs_to_kin_care_reports.py:93-94`).
     *
     * NOT fixed by declaring the fields on [KinCareReport]. That would make this
     * client an OWNER of pipeline state it does not manage, and swap a loud bug
     * for a quiet one: `.set()` would round-trip whatever the client last read,
     * so a save racing the pipeline writes `pending` back over the `in_progress`
     * claim and the report gets reconciled twice; and any report loaded before
     * the field existed decodes to the Kotlin default `""`, which matches no
     * query at all. It would also cover only the fields we know about TODAY -
     * the next server-side field added is silently deleted again. Merge closes
     * the class, and is what `AuntieRepository.updateKinfolk`/`updateKin` chose
     * on 07-21 for the identical bug; `kin_care_reports` was the site missed.
     *
     * Merge costs nothing here: the data class serialises every modelled field,
     * including blanked ones, so a deliberate clear still ships. Subcollections
     * (`comments`, `reactions` - `mytribe/functions/src/portal/kinTaleEngagement.ts`)
     * were never at risk either way; a document write does not touch them.
     *
     * `updatedAt` stays [getCurrentTimestamp] rather than moving to
     * `serverTimestamp()` as updateKinfolk did: [KinCareReport.updatedAt] is a
     * `String` and every reader parses it as ISO-8601, so a Timestamp here would
     * be type drift, not a fix.
     */
    suspend fun updateKinCareReport(report: KinCareReport): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("kin_care_reports").document(report.id)
            .set(
                report.copy(updatedAt = getCurrentTimestamp()),
                com.google.firebase.firestore.SetOptions.merge(),
            )
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update kin care report ${report.id}", it) }

    suspend fun markReportSent(reportId: String, sessionId: String, sentVia: String, deliveryReceiptId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        val timestamp = getCurrentTimestamp()
        firestore.collection("kin_care_reports").document(reportId)
            .update(mapOf(
                "status" to ReportStatus.SENT.name,
                "sentAt" to timestamp,
                "sentVia" to sentVia,
                "deliveryReceiptId" to deliveryReceiptId,
                "updatedAt" to timestamp
            ))
            .await()
        // Bump session sentReportCount and flag autoCompleteEligible
        firestore.collection("kin_care_sessions").document(sessionId)
            .update(mapOf(
                "sentReportCount" to com.google.firebase.firestore.FieldValue.increment(1),
                "autoCompleteEligible" to true,
                "updatedAt" to timestamp
            ))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to mark report sent $reportId", it) }

    suspend fun getKinCareReport(reportId: String): Result<KinCareReport?> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("kin_care_reports").document(reportId).get().await()
        snapshot.toObject(KinCareReport::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care report $reportId", it) }

    suspend fun getReportsForSession(sessionId: String): Result<List<KinCareReport>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("kin_care_reports")
            .whereEqualTo("sessionId", sessionId)
            .orderBy("createdAt")
            .get()
            .await()
        snapshot.toObjects(KinCareReport::class.java)
    }.onFailure { AuntieLog.e("Failed to get reports for session $sessionId", it) }

    /**
     * Every DRAFT KinTale, most recently touched first. No caller in the app
     * today; carried over rather than deleted, on the same reading as
     * [updateKinCareSession] - see this repo's KDoc on the git-era caveat.
     */
    suspend fun getDraftReports(): Result<List<KinCareReport>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = scoped.scopedQuery("kin_care_reports") {
            whereEqualTo("status", ReportStatus.DRAFT.name)
                .orderBy("updatedAt", com.google.firebase.firestore.Query.Direction.DESCENDING)
        }
        snapshot.toObjects(KinCareReport::class.java)
    }.onFailure { AuntieLog.e("Failed to get draft reports", it) }

    suspend fun getAllKinCareReports(): Result<List<KinCareReport>> = runCatching {
        authGate.ensureAuthenticated()
        scoped.scopedQuery("kin_care_reports").toObjects(KinCareReport::class.java)
    }.onFailure { AuntieLog.e("Failed to get all kin care reports", it) }

    // --- Orphan KinCareReport triage ---
    //
    // The May 17 prod migration imported 7 pre-cutover visit_logs into
    // `kin_care_reports/legacy_79..85` with empty `kinfolkId` and
    // `sentVia="legacy_visit_logs"` (Pass-2 rename of `legacy_orphan`).
    // These three helpers let an admin disposition each orphan exactly once:
    //   • assignKinfolkToOrphanReport    - link to a real kinfolk
    //   • markOrphanReportAsDuplicate    - point at the canonical report ID
    //   • archiveOrphanReportAsBadData   - soft-archive with a free-text reason
    //
    // Each helper writes the same triage fields (triageStatus / triagedAt /
    // triagedBy / updatedAt) so the screen can filter triaged rows out of all
    // buckets uniformly, plus fires an `activity_log` entry per repo policy.
    // Fail-loud: any Firestore error is surfaced via Result.failure AND logged
    // through AuntieLog so the UI can render an error toast without swallowing.

    // M5 server-bound triage. The Cloud Function `triageOrphanReport`:
    //   1. Re-validates admin claim via wrapAdminCallable (admin custom claim).
    //   2. Derives canonical kinfolk display name from kinfolk/{id} doc.
    //   3. Applies the mutation AND writes the activity_log audit entry in
    //      one server-side flow - audit is structurally bound to the actual
    //      doc change, closing CWE-345 (client could previously batch a
    //      misleading audit with a different doc state).
    // Client no longer refreshes token, looks up kinfolk, OR fires audit.
    suspend fun assignKinfolkToOrphanReport(
        reportId: String,
        kinfolkId: String,
        kinfolkName: String,
    ): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(reportId.isNotBlank()) { "reportId required" }
        require(kinfolkId.isNotBlank()) { "kinfolkId required" }
        functions.getHttpsCallable("triageOrphanReport")
            .call(mapOf(
                "action"       to "ASSIGN",
                "reportId"     to reportId,
                "kinfolkId"    to kinfolkId,
                "suppliedName" to kinfolkName,
            ))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to assign kinfolk to orphan report $reportId", it) }

    suspend fun markOrphanReportAsDuplicate(
        reportId: String,
        duplicateOfReportId: String,
    ): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(reportId.isNotBlank()) { "reportId required" }
        require(duplicateOfReportId.isNotBlank()) { "duplicateOfReportId required" }
        require(reportId != duplicateOfReportId) { "Cannot mark a report as a duplicate of itself" }
        functions.getHttpsCallable("triageOrphanReport")
            .call(mapOf(
                "action"              to "DUPLICATE",
                "reportId"            to reportId,
                "duplicateOfReportId" to duplicateOfReportId,
            ))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to mark orphan report $reportId as duplicate", it) }

    suspend fun archiveOrphanReportAsBadData(
        reportId: String,
        reason: String,
    ): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(reportId.isNotBlank()) { "reportId required" }
        require(reason.length >= 5) { "Archive reason must be at least 5 characters" }
        functions.getHttpsCallable("triageOrphanReport")
            .call(mapOf(
                "action"   to "ARCHIVE",
                "reportId" to reportId,
                "reason"   to reason,
            ))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to archive orphan report $reportId", it) }

    // ───────────────────────────────────────────────────────────────────────
    // KinTale share link (view-as-kinfolk). Mints a scrubbed, kinfolk-facing
    // share of a SENT KinTale via the deployed `createShareLink` onCall callable.
    // The server (share/createShareLink.ts) re-checks PRIMARY membership, scrubs
    // the payload (author display name + body + optional photos), writes the
    // sharedKinTales/{shareId} doc + an audit row, and returns { shareId, shareUrl }.
    // The companion `getShareLink` HTTP endpoint serves that shareId to unauth
    // guests; it cannot mint a link from a reportId, so creation routes here.
    // ───────────────────────────────────────────────────────────────────────

    /** Result of minting a kinfolk-facing share link for a KinTale. */
    data class ShareLinkResult(val shareId: String, val shareUrl: String)

    /**
     * Mint a kinfolk-facing share link for a SENT KinTale report.
     *
     * @param reportId   the kin_care_reports doc id (KinCareReport.id).
     * @param familyId   the recipient household (KinCareReport.kinfolkId); the
     *                   server requires it to match the report's kinfolkId.
     * @param includePhotos whether to bundle resolved media URLs into the share.
     *
     * Fail-loud: a blank reportId/familyId rejects before the call; a callable
     * failure or a malformed payload surfaces as Result.failure (the caller
     * banners it), never a fabricated URL.
     */
    suspend fun createShareLink(
        reportId: String,
        familyId: String,
        includePhotos: Boolean = false,
    ): Result<ShareLinkResult> = runCatching {
        authGate.ensureAuthenticated()
        require(reportId.isNotBlank()) { "createShareLink: reportId required" }
        require(familyId.isNotBlank()) { "createShareLink: familyId required" }
        val payload = mapOf(
            "familyId" to familyId,
            "kinTaleId" to reportId,
            "includePhotos" to includePhotos,
        )
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("createShareLink").call(payload).await().data as? Map<String, Any?>
            ?: error("createShareLink: non-map payload")
        val shareId = raw["shareId"] as? String ?: error("createShareLink: missing shareId")
        val shareUrl = (raw["shareUrl"] as? String)?.takeIf { it.isNotBlank() }
            ?: error("createShareLink: missing shareUrl")
        ShareLinkResult(shareId = shareId, shareUrl = shareUrl)
    }.onFailure { AuntieLog.e("Failed to create share link for report $reportId", it) }

    // --- Internal helpers, carried over from the god-file verbatim ---

    private fun getCurrentTimestamp(): String {
        return java.time.Instant.now().toString()
    }

    /**
     * The DIRECTORY domain's per-household kin read, needed here because a new
     * session auto-fills its kinIds from the household's ACTIVE kin and a report
     * renders per kin. Copied verbatim from the god-file's `getKin` query rather
     * than reached back through a facade; when the Directory repo is carved this
     * becomes a call into it.
     */
    private suspend fun kinForKinfolk(kinfolkId: String): Result<List<Kin>> = runCatching {
        AuntieLog.d("Fetching kin for kinfolk: $kinfolkId")
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("kin")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get().await()
        snapshot.toObjects(Kin::class.java).also {
            AuntieLog.d("Fetched ${it.size} kin for $kinfolkId")
        }
    }.onFailure { AuntieLog.e("Failed to get kin for $kinfolkId", it) }

    /**
     * The signed-out short-circuit for snapshot-listener flows, carried over
     * verbatim so `observeBreadcrumbs` still closes with the same message. It is
     * NOT [AuthGate.ensureAuthenticated]: that throws a different, user-facing
     * sentence, and a flow has to CLOSE rather than throw. The god-file's four
     * comms observers use the same helper, which is why it is a copy today
     * rather than a move; the Comms carve is where the two meet again.
     */
    private fun ProducerScope<*>.checkAuthOrCloseFlow(caller: String): Boolean {
        if (auth.currentUser != null) return true
        val err = IllegalStateException("$caller: no authenticated user — admin sign-in required")
        AuntieLog.e("$caller: attaching Firestore listener without auth", err)
        close(err)
        return false
    }
}

/**
 * One staff member from the listStaff callable: the uid plus whatever identity
 * fields the staff/{uid} doc carries (either can be null on a sparse doc).
 */
data class StaffMember(
    val uid: String,
    val displayName: String?,
    val email: String?,
) {
    /** What the picker shows: display name, else email, else the raw uid. */
    val label: String get() = displayName?.ifBlank { null } ?: email?.ifBlank { null } ?: uid
}

/**
 * Pure decode of the listStaff callable payload ({ staff: [{ uid, displayName,
 * email }] }) into [StaffMember]s. Entries without a uid are dropped (nothing to
 * assign); missing name/email decode to null. Sorted by displayName (else uid),
 * case-insensitive, matching the server's ordering contract. Pure; unit-tested.
 */
internal fun decodeListStaff(raw: Map<*, *>?): List<StaffMember> =
    (raw?.get("staff") as? List<*>).orEmpty()
        .mapNotNull { item ->
            val m = item as? Map<*, *> ?: return@mapNotNull null
            val uid = (m["uid"] as? String)?.ifBlank { null } ?: return@mapNotNull null
            StaffMember(
                uid = uid,
                displayName = m["displayName"] as? String,
                email = m["email"] as? String,
            )
        }
        .sortedBy { (it.displayName ?: it.uid).lowercase() }

/**
 * Pure encode of the assignAuntie callable payload. The backend schema is
 * `auntieUid: string | null` (not optional), so the key is always present and
 * an unassign sends an explicit null. Pure; unit-tested.
 */
internal fun assignAuntiePayload(
    kinfolkId: String,
    batchId: String,
    visitId: String,
    auntieUid: String?,
): Map<String, Any?> = mapOf(
    "kinfolkId" to kinfolkId,
    "batchId" to batchId,
    "visitId" to visitId,
    "auntieUid" to auntieUid,
)
