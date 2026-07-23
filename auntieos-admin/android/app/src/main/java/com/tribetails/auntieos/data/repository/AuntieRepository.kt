package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.BuildConfig
import com.tribetails.auntieos.domain.withSandboxScope
import com.tribetails.auntieos.domain.RecentSend
import com.tribetails.auntieos.domain.decodeRecentSends

import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.domain.TestMode
import com.tribetails.auntieos.domain.allowsKinfolkDoc
import com.tribetails.auntieos.domain.kinfolkScopeFilter
import com.tribetails.auntieos.domain.scopedKinfolkId
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.util.*

class AuntieRepository(
    private val n8n: N8nApi
) {
    private val firestore by lazy { FirebaseFirestore.getInstance() }
    private val storage by lazy { FirebaseStorage.getInstance() }
    private val auth by lazy { FirebaseAuth.getInstance() }
    private val functions by lazy { FirebaseFunctions.getInstance("us-central1") }
    private val authMutex = Mutex()

    data class SessionUser(
        val uid: String,
        val email: String?,
    )

    private suspend fun ensureAuthenticated() {
        if (auth.currentUser == null) {
            throw IllegalStateException("Admin sign-in required before using AuntieOS.")
        }
    }

    fun authStateFlow(): Flow<SessionUser?> = callbackFlow {
        val listener = FirebaseAuth.AuthStateListener { firebaseAuth ->
            trySend(firebaseAuth.currentUser?.toSessionUser())
        }
        auth.addAuthStateListener(listener)
        trySend(auth.currentUser?.toSessionUser())
        awaitClose { auth.removeAuthStateListener(listener) }
    }

    suspend fun signInAdmin(email: String, password: String): Result<Unit> = runCatching {
        require(email.isNotBlank()) { "Email is required." }
        require(password.isNotBlank()) { "Password is required." }
        authMutex.withLock {
            auth.signInWithEmailAndPassword(email.trim(), password).await()
            val token = auth.currentUser?.getIdToken(true)?.await()
            if (token?.claims?.get("admin") != true) {
                auth.signOut()
                error("This account does not have the admin claim.")
            }
            AuntieLog.i("Admin sign-in successful: ${auth.currentUser?.uid}")
        }
        Unit
    }.onFailure { AuntieLog.e("Admin sign-in failed", it) }

    suspend fun sendPasswordReset(email: String): Result<Unit> = runCatching {
        require(email.isNotBlank()) { "Email is required." }
        auth.sendPasswordResetEmail(email.trim()).await()
        Unit
    }.onFailure { AuntieLog.e("Password reset failed", it) }

    /**
     * Reauthenticate with [currentPassword], then send a verify-before-update link
     * to [newEmail] (spec 29 item 15.4). The login email only flips after the
     * operator confirms via the link, so we never report a fake "changed" state.
     */
    suspend fun updateLoginEmail(currentPassword: String, newEmail: String): Result<Unit> = runCatching {
        val user = auth.currentUser ?: error("Not signed in.")
        val em = user.email ?: error("Current account has no email.")
        require(newEmail.isNotBlank()) { "New email is required." }
        user.reauthenticate(com.google.firebase.auth.EmailAuthProvider.getCredential(em, currentPassword)).await()
        user.verifyBeforeUpdateEmail(newEmail.trim()).await()
        logActivity(
            com.tribetails.auntieos.data.admin.ActivityLogEntry(
                actionType = "AUTH_EMAIL_CHANGE_REQUESTED",
                description = "Login email change requested to ${newEmail.trim()}",
                status = "SUCCESS", actorId = user.uid,
            )
        )
        Unit
    }.onFailure { AuntieLog.e("Login email change failed", it) }

    /** Reauthenticate with [currentPassword], then set [newPassword]. */
    suspend fun updateLoginPassword(currentPassword: String, newPassword: String): Result<Unit> = runCatching {
        val user = auth.currentUser ?: error("Not signed in.")
        val em = user.email ?: error("Current account has no email.")
        require(newPassword.length >= 6) { "Password must be at least 6 characters." }
        user.reauthenticate(com.google.firebase.auth.EmailAuthProvider.getCredential(em, currentPassword)).await()
        user.updatePassword(newPassword).await()
        logActivity(
            com.tribetails.auntieos.data.admin.ActivityLogEntry(
                actionType = "AUTH_PASSWORD_CHANGED",
                description = "Login password changed", status = "SUCCESS", actorId = user.uid,
            )
        )
        Unit
    }.onFailure { AuntieLog.e("Password change failed", it) }

    suspend fun signOut(): Result<Unit> = runCatching {
        auth.signOut()
        clearTestModeCache()
        Unit
    }.onFailure { AuntieLog.e("Sign-out failed", it) }

    suspend fun currentAdminIdToken(forceRefresh: Boolean = false): Result<String> = runCatching {
        ensureAuthenticated()
        val user = auth.currentUser ?: error("Admin sign-in required before requesting an ID token.")
        val token = user.getIdToken(forceRefresh).await().token
        if (token.isNullOrBlank()) error("No Firebase ID token available.")
        token
    }.onFailure { AuntieLog.e("Failed to fetch Firebase ID token", it) }

    /** Reads custom claim `admin` from current user's ID token. Forces refresh so server-side
     *  changes (e.g. setAdminClaim Cloud Function) are picked up without app restart. */
    suspend fun isCurrentUserAdmin(): Result<Boolean> = runCatching {
        ensureAuthenticated()
        val token = auth.currentUser?.getIdToken(true)?.await()
        val isAdmin = token?.claims?.get("admin") == true
        AuntieLog.d("isCurrentUserAdmin uid=${auth.currentUser?.uid} → $isAdmin")
        isAdmin
    }.onFailure { AuntieLog.e("Failed to read admin claim", it) }

    /** Defense-in-depth: forces an ID-token refresh and throws if the admin
     *  claim is missing. Use before any destructive admin action so that
     *  client-side state can't be tampered to bypass Firestore rules. */
    private suspend fun requireAdminClaim() {
        ensureAuthenticated()
        val isAdmin = isCurrentUserAdmin().getOrDefault(false)
        if (!isAdmin) {
            throw SecurityException("Admin claim required for this action")
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    // Stage 0I test-admin sandbox. A test admin signs in as a normal Firebase
    // user carrying the custom claim `testTribeId` (string) and does NOT carry
    // `admin: true`. Firestore rules HARD-restrict it to docs where
    // kinfolkId == testTribeId, so the broad collection reads the normal-admin
    // path uses would be permission-denied. Every kinfolk-scoped read below
    // therefore adds `whereEqualTo("kinfolkId", testTribeId)` when active, and
    // every kinfolk-scoped create stamps kinfolkId = testTribeId. The
    // normal-admin path (no claim) is UNCHANGED. Decision logic is the pure,
    // unit-tested [TestMode] in the domain package.
    // ───────────────────────────────────────────────────────────────────────

    @Volatile
    private var cachedTestMode: TestMode? = null

    /**
     * Reads the `testTribeId` custom claim from the current user's ID token and
     * returns [TestMode]. Forces a token refresh so a server-set claim is picked
     * up without an app restart (parity with [isCurrentUserAdmin]). Caches the
     * result so the per-query scoping below doesn't re-fetch the token on every
     * read. Fail-loud: a token-read failure surfaces via Result.failure.
     */
    suspend fun getTestMode(forceRefresh: Boolean = false): Result<TestMode> = runCatching {
        ensureAuthenticated()
        cachedTestMode?.let { if (!forceRefresh) return@runCatching it }
        val token = auth.currentUser?.getIdToken(true)?.await()
        val mode = TestMode.fromClaims(token?.claims)
        AuntieLog.d("getTestMode uid=${auth.currentUser?.uid} active=${mode.active} tribe=${mode.testTribeId}")
        cachedTestMode = mode
        mode
    }.onFailure { AuntieLog.e("Failed to read testTribeId claim", it) }

    /** Clears the cached TestMode (called on sign-out so a new account re-reads its claim). */
    private fun clearTestModeCache() { cachedTestMode = null }

    /**
     * True iff a Stage-0I test admin is signed in. Plain-Boolean wrapper around
     * [getTestMode] (defaults to false if the claim can't be read) so a caller — e.g.
     * a ViewModel deciding whether to suppress a cross-tenant permission banner — can
     * ask without unpacking a value-class `Result`. (Value-class returns also trip up
     * mockk-relaxed test doubles, so the plain Boolean keeps those green by default.)
     */
    suspend fun isTestAdminActive(): Boolean = getTestMode().getOrNull()?.active == true

    /**
     * Resolve the active TestMode for an in-flight scoped read. Throws (rather
     * than silently treating the user as a normal admin) if the claim can't be
     * read, so a denied/failed claim check fails loud instead of leaking a broad
     * unscoped query that Firestore rules would reject anyway.
     */
    private suspend fun requireTestMode(): TestMode =
        getTestMode().getOrElse {
            throw IllegalStateException("Could not resolve test-mode claim before a scoped read", it)
        }

    /**
     * Applies the sandbox kinfolkId constraint to a query over a kinfolk-scoped
     * collection (one with a `kinfolkId` field). In test mode adds
     * `whereEqualTo("kinfolkId", testTribeId)`; the normal-admin path returns the
     * query untouched. Uses the pure [TestMode.kinfolkScopeFilter] for the
     * decision so the selection is unit-tested.
     */
    private fun com.google.firebase.firestore.Query.scopedByKinfolk(mode: TestMode): com.google.firebase.firestore.Query {
        val filter = mode.kinfolkScopeFilter() ?: return this
        return whereEqualTo("kinfolkId", filter)
    }

    suspend fun getKinfolk(): Result<List<Kinfolk>> = runCatching {
        AuntieLog.d("Fetching kinfolk list")
        ensureAuthenticated()
        val mode = requireTestMode()
        if (mode.active) {
            // Test admin: the only reachable kinfolk doc is the one whose id ==
            // testTribeId. A broad collection read would be permission-denied, so
            // collapse to a single doc fetch (fail-loud: errors propagate).
            val doc = firestore.collection("kinfolk").document(mode.testTribeId).get().await()
            val k = doc.toObject(Kinfolk::class.java)
            return@runCatching listOfNotNull(k).filter { mode.allowsKinfolkDoc(it.id) }
        }
        val snapshot = firestore.collection("kinfolk").get().await()
        snapshot.toObjects(Kinfolk::class.java).also {
            AuntieLog.d("Fetched ${it.size} kinfolk")
        }
    }.onFailure { AuntieLog.e("Failed to get kinfolk", it) }

    suspend fun findKinfolkByPhone(phone: String): Result<Kinfolk?> = runCatching {
        AuntieLog.d("Searching kinfolk by phone: ${AuntieLog.redactPhone(phone)}")
        ensureAuthenticated()
        val mode = requireTestMode()
        if (mode.active) {
            // Test admin can only reach kinfolk/{testTribeId}; a phone query across
            // the collection would be denied. Fetch the sandbox doc and match locally.
            val doc = firestore.collection("kinfolk").document(mode.testTribeId).get().await()
            val k = doc.toObject(Kinfolk::class.java)
            return@runCatching k?.takeIf { it.phoneNumber == phone }
        }
        val snapshot = firestore.collection("kinfolk")
            .whereEqualTo("phoneNumber", phone)
            .get().await()
        snapshot.documents.firstOrNull()?.toObject(Kinfolk::class.java).also {
            if (it != null) AuntieLog.d("Found kinfolk id=${it.id}")
            else AuntieLog.d("No kinfolk found for phone ${AuntieLog.redactPhone(phone)}")
        }
    }.onFailure { AuntieLog.e("Error finding kinfolk by phone", it) }

    suspend fun createKinfolk(firstName: String, lastName: String, phone: String): Result<Kinfolk> = runCatching {
        AuntieLog.i("Creating new kinfolk phone=${AuntieLog.redactPhone(phone)}")
        ensureAuthenticated()
        val newKinfolk = Kinfolk(
            firstName = firstName,
            lastName = lastName,
            phoneNumber = phone,
            internalNotes = "Prospect converted on Firebase"
        )
        val docRef = firestore.collection("kinfolk").add(newKinfolk).await()
        newKinfolk.copy(id = docRef.id).also {
            AuntieLog.i("Created kinfolk id=${it.id}")
        }
    }.onFailure { AuntieLog.e("Failed to create kinfolk", it) }

    suspend fun createKinfolkComplete(kinfolk: Kinfolk): Result<Kinfolk> = runCatching {
        AuntieLog.i("Creating kinfolk complete phone=${AuntieLog.redactPhone(kinfolk.phoneNumber)}")
        ensureAuthenticated()
        val docRef = firestore.collection("kinfolk").add(kinfolk).await()
        kinfolk.copy(id = docRef.id).also {
            AuntieLog.i("Created kinfolk id=${it.id}")
        }
    }.onFailure { AuntieLog.e("Failed to create complete kinfolk", it) }

    suspend fun updateKinfolk(kinfolk: Kinfolk): Result<Unit> = runCatching {
        AuntieLog.i("Updating kinfolk id=${kinfolk.id}")
        ensureAuthenticated()
        // STAMP updatedAt, do not round-trip it. Adding the field to the model
        // stopped the save from DESTROYING it, but `.set()` would then write back
        // the value that was read, freezing the timestamp at its old value and
        // silently lying about when the record last changed. serverTimestamp()
        // matches what the React admin writes (api/directoryWrite.ts), so both
        // clients produce a Firestore Timestamp; getCurrentTimestamp() would
        // write an ISO String and reintroduce type drift on this field.
        //
        // MERGE, never a bare set(). A bare set() replaces the whole document, so
        // every field the backend writes but this model does not declare is
        // DELETED by an ordinary admin save. Measured against MyTribe: it erases
        // `myTribeLinkedAt` (portal auth linkage, revokeKinfolkClaim.ts),
        // `isTestData` (the sandbox marker, familyProvision.ts), and
        // `businessName` (read by getMyHome.ts). Losing `isTestData` silently
        // breaks sandbox isolation. The `updatedAt` note above is the same bug
        // caught once and patched one field at a time; merge closes the class.
        // Every modelled field still ships, including blanked ones, because the
        // data class serialises them, so merge costs nothing.
        firestore.collection("kinfolk").document(kinfolk.id)
            .set(kinfolk.copy(updatedAt = FieldValue.serverTimestamp()), com.google.firebase.firestore.SetOptions.merge()).await()
        AuntieLog.d("Update successful for kinfolk id=${kinfolk.id}")
        Unit
    }.onFailure { AuntieLog.e("Failed to update kinfolk ${kinfolk.id}", it) }

    suspend fun deleteKinfolk(kinfolkId: String): Result<Unit> = runCatching {
        AuntieLog.w("Deleting kinfolk: $kinfolkId")
        ensureAuthenticated()
        firestore.collection("kinfolk").document(kinfolkId).delete().await()
        AuntieLog.i("Deleted kinfolk: $kinfolkId")
        Unit
    }.onFailure { AuntieLog.e("Failed to delete kinfolk $kinfolkId", it) }

    // Archive: reversible state flip (matches web ArchiveBlock semantics).
    // Sets status="archived" + archivedAt timestamp + archivedReason. Document
    // remains in Firestore; lists must filter status="archived" to hide it.
    suspend fun archiveKinfolk(kinfolkId: String, reason: String, archivedBy: String = "admin"): Result<Unit> = runCatching {
        AuntieLog.i("Archiving kinfolk: $kinfolkId (reason: $reason)")
        ensureAuthenticated()
        firestore.collection("kinfolk").document(kinfolkId).update(
            mapOf(
                "status"         to "archived",
                "archivedAt"     to getCurrentTimestamp(),
                "archivedReason" to reason,
                "archivedBy"     to archivedBy,
            )
        ).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to archive kinfolk $kinfolkId", it) }

    // Activity log writer. As of 2026-05-26 routes through the server
    // `logActivity` callable rather than writing to Firestore directly so the
    // SHA-256 hash chain in writeAuditEntry seals every client-origin entry
    // too (closes C-A residual chain hole). The callable is admin-gated; the
    // server uses req.auth.uid as the actual actor and re-runs all validation.
    suspend fun logActivity(entry: com.tribetails.auntieos.data.admin.ActivityLogEntry): Result<Unit> = runCatching {
        ensureAuthenticated()
        val payload = buildMap<String, Any> {
            put("actionType", entry.actionType)
            if (entry.description.isNotBlank()) put("description", entry.description)
            if (entry.status.isNotBlank()) put("status", entry.status)
            val actor = entry.actorId.ifBlank { auth.currentUser?.uid.orEmpty() }
            if (actor.isNotBlank()) put("actorId", actor)
            if (entry.targetId.isNotBlank()) put("targetId", entry.targetId)
            if (entry.targetCollection.isNotBlank()) put("targetCollection", entry.targetCollection)
        }
        functions.getHttpsCallable("logActivity").call(payload).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to write activity_log entry", it) }

    /**
     * #14 (2026-06-08): invite an existing kinfolk to the kinfolk portal. Calls the
     * admin-gated inviteKinfolkToPortal callable. Returns the status string:
     * "sent" | "already_active" | "no_email". Fail-loud via Result.
     */
    suspend fun inviteKinfolkToPortal(kinfolkId: String): Result<String> = runCatching {
        AuntieLog.i("inviteKinfolkToPortal: $kinfolkId")
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("inviteKinfolkToPortal")
            .call(mapOf("kinfolkId" to kinfolkId)).await().data as? Map<String, Any?>
            ?: error("inviteKinfolkToPortal: non-map payload")
        raw["status"] as? String ?: error("inviteKinfolkToPortal: missing status")
    }.onFailure { AuntieLog.e("inviteKinfolkToPortal failed", it) }

    suspend fun unarchiveKinfolk(kinfolkId: String): Result<Unit> = runCatching {
        AuntieLog.i("Unarchiving kinfolk: $kinfolkId")
        ensureAuthenticated()
        firestore.collection("kinfolk").document(kinfolkId).update(
            mapOf(
                "status"         to "active",
                "archivedAt"     to "",
                "archivedReason" to "",
                "archivedBy"     to "",
            )
        ).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to unarchive kinfolk $kinfolkId", it) }

    suspend fun getKinfolkById(kinfolkId: String): Result<Kinfolk?> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("kinfolk").document(kinfolkId).get().await()
        snapshot.toObject(Kinfolk::class.java)
    }.onFailure { AuntieLog.e("Failed to get kinfolk $kinfolkId", it) }

    suspend fun getKin(kinfolkId: String): Result<List<Kin>> = runCatching {
        AuntieLog.d("Fetching kin for kinfolk: $kinfolkId")
        ensureAuthenticated()
        val snapshot = firestore.collection("kin")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get().await()
        snapshot.toObjects(Kin::class.java).also {
            AuntieLog.d("Fetched ${it.size} kin for $kinfolkId")
        }
    }.onFailure { AuntieLog.e("Failed to get kin for $kinfolkId", it) }

    suspend fun createKin(kin: Kin): Result<Kin> = runCatching {
        val mode = requireTestMode()
        val kin = if (mode.active) kin.copy(kinfolkId = mode.scopedKinfolkId(kin.kinfolkId)) else kin
        AuntieLog.i("Creating kin: ${kin.name} for kinfolk: ${kin.kinfolkId}")
        ensureAuthenticated()
        val docRef = firestore.collection("kin").add(kin).await()
        // Additive FK for the MyTribe pet mirror (onFlatKinWrite). When the pet
        // belongs to a known kinfolk, stamp kinfolkId + familyKinPath so the
        // trigger can mirror this staff-created pet into the family tree at
        // families/{kinfolkId}/kin/{kinId}. The kin doc id is only known after
        // the add() resolves, so this is a follow-up merge that leaves the
        // existing Kin field writes untouched.
        stampFamilyKinPath(kinId = docRef.id, kinfolkId = kin.kinfolkId)
        kin.copy(id = docRef.id).also {
            AuntieLog.i("Created kin with ID: ${it.id}")
        }
    }.onFailure { AuntieLog.e("Failed to create kin", it) }

    suspend fun getAllKin(): Result<List<Kin>> = runCatching {
        AuntieLog.d("Fetching all kin (directory index)")
        ensureAuthenticated()
        val mode = requireTestMode()
        firestore.collection("kin").scopedByKinfolk(mode).get().await().toObjects(Kin::class.java)
    }.onFailure { AuntieLog.e("Failed to get all kin", it) }

    suspend fun updateKin(kin: Kin): Result<Unit> = runCatching {
        AuntieLog.i("Updating kin: ${kin.id}")
        ensureAuthenticated()
        // STAMP updatedAt rather than round-tripping the value that was read.
        // See updateKinfolk for why serverTimestamp() and not getCurrentTimestamp().
        // MERGE for the same reason as updateKinfolk: a bare set() deletes any
        // backend-written field this model does not declare. `familyKinPath` was
        // already destroyed this way once.
        firestore.collection("kin").document(kin.id)
            .set(kin.copy(updatedAt = FieldValue.serverTimestamp()), com.google.firebase.firestore.SetOptions.merge()).await()
        // Additive FK for the MyTribe pet mirror (onFlatKinWrite). Same fields as
        // createKin; re-stamped on edit in case the pet was reassigned to a
        // kinfolk. Leaves the Kin field writes above untouched.
        stampFamilyKinPath(kinId = kin.id, kinfolkId = kin.kinfolkId)
        AuntieLog.d("Update successful for kin: ${kin.id}")
        Unit
    }.onFailure { AuntieLog.e("Failed to update kin ${kin.id}", it) }

    /**
     * Additively stamps the MyTribe mirror FK (kinfolkId + familyKinPath) onto a
     * flat kin/{kinId} doc. No-op when the pet has no known kinfolk. Used by
     * createKin/updateKin so onFlatKinWrite can mirror staff pets into the family
     * tree. SetOptions.merge() so only these two fields are written.
     */
    private suspend fun stampFamilyKinPath(kinId: String, kinfolkId: String) {
        if (kinId.isBlank() || kinfolkId.isBlank()) return
        runCatching {
            firestore.collection("kin").document(kinId).set(
                mapOf(
                    "kinfolkId" to kinfolkId,
                    "familyKinPath" to "families/$kinfolkId/kin/$kinId",
                ),
                com.google.firebase.firestore.SetOptions.merge(),
            ).await()
        }.onFailure { AuntieLog.e("Failed to stamp familyKinPath on kin $kinId", it) }
    }

    suspend fun getDossier(kinfolkId: String): Result<Dossier?> = runCatching {
        AuntieLog.d("Fetching dossier for kinfolk: $kinfolkId")
        ensureAuthenticated()
        val snapshot = firestore.collection("dossiers")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get().await()
        snapshot.documents.firstOrNull()?.toObject(Dossier::class.java).also {
            AuntieLog.d("Dossier found: ${it != null}")
        }
    }.onFailure { AuntieLog.e("Failed to get dossier for $kinfolkId", it) }

    suspend fun get411ForKin(kinId: String): Result<Kin411?> = runCatching {
        AuntieLog.d("Fetching 411 for kin: $kinId")
        ensureAuthenticated()
        val snapshot = firestore.collection("the_411")
            .whereEqualTo("kinId", kinId)
            .get().await()
        snapshot.documents.firstOrNull()?.toObject(Kin411::class.java).also {
            if (it != null) AuntieLog.d("411 found")
            else AuntieLog.d("411 not found")
        }
    }.onFailure { AuntieLog.e("Failed to get 411 for $kinId", it) }

    suspend fun get411ByKinIds(kinIds: List<String>): Result<Map<String, Kin411>> = runCatching {
        val cleaned = kinIds.filter { it.isNotBlank() }.distinct()
        if (cleaned.isEmpty()) return@runCatching emptyMap()
        ensureAuthenticated()
        // Firestore whereIn caps at 30; chunk for safety even though sessions rarely exceed a few kin.
        val out = mutableMapOf<String, Kin411>()
        cleaned.chunked(30).forEach { chunk ->
            val snap = firestore.collection("the_411")
                .whereIn("kinId", chunk)
                .get().await()
            snap.documents.forEach { doc ->
                val rec = doc.toObject(Kin411::class.java) ?: return@forEach
                if (rec.kinId.isNotBlank()) out[rec.kinId] = rec
            }
        }
        out
    }.onFailure { AuntieLog.e("Failed bulk 411 lookup", it) }

    suspend fun getKinByIds(kinIds: List<String>): Result<Map<String, Kin>> = runCatching {
        val cleaned = kinIds.filter { it.isNotBlank() }.distinct()
        if (cleaned.isEmpty()) return@runCatching emptyMap()
        ensureAuthenticated()
        val out = mutableMapOf<String, Kin>()
        cleaned.chunked(30).forEach { chunk ->
            val snap = firestore.collection("kin")
                .whereIn(com.google.firebase.firestore.FieldPath.documentId(), chunk)
                .get().await()
            snap.documents.forEach { doc ->
                val rec = doc.toObject(Kin::class.java) ?: return@forEach
                if (rec.id.isNotBlank()) out[rec.id] = rec
            }
        }
        out
    }.onFailure { AuntieLog.e("Failed bulk kin lookup", it) }

    suspend fun generate(request: GenerateRequest, useFunction: Boolean = true): Result<GenerateResponse> = runCatching {
        AuntieLog.i("Generating content for recipient: ${request.recipient} (useFunction=$useFunction)")
        withContext(Dispatchers.IO) {
            // generate runs admin-only via the Firebase `generate` Function. The n8n
            // webhook fallback is retired, so there is no alternate backend. The
            // `useFunction` param is retained for call-site compatibility (it will be
            // removed together with the communicateGenerateViaFunction flag in a
            // separate flag de-gating pass) and no longer selects a backend.
            val idToken = auth.currentUser?.getIdToken(false)?.await()?.token
                ?: error("Admin sign-in required for generate")
            val resp = n8n.generateViaFunction("Bearer $idToken", request)
            if (!resp.isSuccessful) {
                // The function returns a byte-compatible GenerateResponse even on error
                // (error field set); Retrofit puts a non-2xx body in errorBody(), so dig
                // out the error field for a clean fail-loud message.
                val raw = resp.errorBody()?.string().orEmpty()
                val parsedError = runCatching {
                    com.google.gson.Gson().fromJson(raw, GenerateResponse::class.java)?.error
                }.getOrNull()
                val errorMsg = parsedError ?: "generate failed with code ${resp.code()}: ${raw.take(220)}"
                AuntieLog.e(errorMsg)
                error(errorMsg)
            }
            resp.body() ?: error("Empty response body from generate")
        }
    }.onFailure { AuntieLog.e("Error during generation", it) }

    @Suppress("UNUSED_PARAMETER")
    suspend fun approveDraft(
        draftId: String,
        editedCopy: String,
        kinfolkId: String?, // kinfolkId retained for call-site contract; profile refresh now owned by reconcile
    ): Result<Unit> = runCatching {
        AuntieLog.i("Approving draft: $draftId")
        ensureAuthenticated()
        firestore.collection("generated_drafts").document(draftId).update(
            mapOf(
                "status" to "approved",
                "generatedCopy" to editedCopy,
                "approvedAt" to getCurrentTimestamp(),
                "approvedBy" to (auth.currentUser?.uid ?: "")
            )
        ).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to approve draft $draftId", it) }

    suspend fun sendMessage(request: SendMessageRequest): Result<String> = runCatching {
        AuntieLog.i("Sending message to: ${AuntieLog.redactPhone(request.recipient_phone)}")
        ensureAuthenticated()
        withContext(Dispatchers.IO) {
            val idToken = auth.currentUser?.getIdToken(false)?.await()?.token
                ?: error("No Firebase ID token available for sendMessage")
            val resp = n8n.sendMessage("Bearer $idToken", request)
            if (!resp.isSuccessful) {
                val errorMsg = "Send message failed: ${resp.errorBody()?.string()}"
                AuntieLog.e(errorMsg)
                error(errorMsg)
            }
            resp.body()?.receiptId ?: ""
        }
    }.onFailure { AuntieLog.e("Failed to send message", it) }

    suspend fun synthesizeProfile(kinfolkId: String): Result<Unit> = runCatching {
        AuntieLog.i("Synthesizing profile for kinfolk: $kinfolkId")
        ensureAuthenticated()
        withContext(Dispatchers.IO) {
            functions.getHttpsCallable("synthesize_kinfolk_profile")
                .call(mapOf("kinfolkId" to kinfolkId))
                .await()
        }
        Unit
    }.onFailure { AuntieLog.e("Failed to synthesize profile for $kinfolkId", it) }

    suspend fun clearDossierHouseholdNotes(kinfolkId: String): Result<Unit> = runCatching {
        AuntieLog.i("Clearing dossier household notes for kinfolk: $kinfolkId")
        ensureAuthenticated()
        withContext(Dispatchers.IO) {
            functions.getHttpsCallable("clear_dossier_household_notes")
                .call(mapOf("kinfolkId" to kinfolkId))
                .await()
        }
        Unit
    }.onFailure { AuntieLog.e("Failed to clear dossier household notes for $kinfolkId", it) }

    /**
     * Stage 2 step 5 (Communicate external send). Sends a one-off email or SMS to an
     * arbitrary recipient via the deployed sendExternalMessage callable (validation +
     * consent gate + provider send + audit, all server-side). Subject is required for
     * email and omitted for SMS by the caller. Returns the channel, the provider
     * message id, and the server-REDACTED recipient (we never echo the plaintext
     * contact back). Fail-loud: a suppressed recipient surfaces as the verbatim
     * server message 'recipient_opted_out', and provider failures surface the
     * provider error. */
    suspend fun sendExternalMessage(
        channel: String,
        to: String,
        subject: String?,
        body: String,
        transactional: Boolean = false,
    ): Result<ExternalSendResult> = runCatching {
        ensureAuthenticated()
        val payload = buildMap<String, Any?> {
            put("channel", channel)
            put("to", to)
            put("body", body)
            if (channel == "email" && !subject.isNullOrBlank()) put("subject", subject)
            put("transactional", transactional)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("sendExternalMessage")
            .call(payload)
            .await().data as? Map<String, Any?>
        decodeExternalSendResult(raw, channel)
    }.onFailure { AuntieLog.e("sendExternalMessage failed (channel=$channel)", it) }

    /**
     * Stage 2 step 5: records an opt-out for a recipient via the deployed
     * suppressExternalRecipient callable so future sendExternalMessage calls to this
     * recipient are blocked at the source by the server consent gate. Returns the
     * channel and the server-REDACTED recipient. */
    suspend fun suppressExternalRecipient(
        channel: String,
        to: String,
    ): Result<ExternalSuppressResult> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("suppressExternalRecipient")
            .call(mapOf("channel" to channel, "to" to to))
            .await().data as? Map<String, Any?>
        decodeExternalSuppressResult(raw, channel)
    }.onFailure { AuntieLog.e("suppressExternalRecipient failed (channel=$channel)", it) }

    /**
     * Communicate "Recent": recent external sends + engagement counts via the
     * admin-gated listRecentSends callable (external_messages has no client read
     * rule). Counts are bumped by the SendGrid/Twilio webhooks. Fail-loud on error.
     */
    suspend fun listRecentSends(): Result<List<RecentSend>> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listRecentSends")
            .call(emptyMap<String, Any?>())
            .await().data as? Map<String, Any?>
        decodeRecentSends(raw)
    }.onFailure { AuntieLog.e("listRecentSends failed", it) }

    /**
     * Run-4 #6: dog + cat breed name banks for the Kin breed dropdown, from the
     * `getBreeds` callable (reads the seeded dog_breeds / cat_breeds collections).
     * Fail-loud: a failure propagates via Result so the UI falls back to free-text
     * rather than showing a silent empty dropdown. Mirrors web FirestoreClient.breeds().
     */
    suspend fun getBreeds(): Result<BreedBank> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getBreeds")
            .call(emptyMap<String, Any?>())
            .await().data as? Map<String, Any?>
            ?: error("getBreeds: non-map payload")
        BreedBank(
            dogBreeds = (raw["dogBreeds"] as? List<*>).orEmpty().mapNotNull { it as? String },
            catBreeds = (raw["catBreeds"] as? List<*>).orEmpty().mapNotNull { it as? String },
        )
    }.onFailure { AuntieLog.e("getBreeds failed", it) }

    /**
     * A8 W16/W17: local forecast for the Home weather widgets via the keyless-NWS-backed
     * getLocalWeather callable. Fail-loud via Result so the widget shows a real reason
     * (e.g. "business_address_not_set"), never fake weather. Numbers arrive as Double
     * from the callable. Mirrors web FirestoreClient.getLocalWeather.
     */
    suspend fun getLocalWeather(): Result<com.tribetails.auntieos.data.model.LocalWeather> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getLocalWeather")
            .call(emptyMap<String, Any?>())
            .await().data as? Map<String, Any?>
            ?: error("getLocalWeather: non-map payload")
        val alerts = (raw["alerts"] as? List<*>).orEmpty().mapNotNull { el ->
            val m = el as? Map<*, *> ?: return@mapNotNull null
            val event = m["event"] as? String ?: return@mapNotNull null
            com.tribetails.auntieos.data.model.WeatherAlert(
                event = event,
                severity = m["severity"] as? String ?: "",
                headline = m["headline"] as? String ?: "",
            )
        }
        com.tribetails.auntieos.data.model.LocalWeather(
            city = raw["city"] as? String ?: "",
            state = raw["state"] as? String ?: "",
            tempF = (raw["tempF"] as? Number)?.toInt(),
            humidityPct = (raw["humidityPct"] as? Number)?.toInt(),
            shortForecast = raw["shortForecast"] as? String ?: "",
            isDaytime = raw["isDaytime"] as? Boolean ?: true,
            alerts = alerts,
            observedAtMs = (raw["observedAtMs"] as? Number)?.toLong() ?: 0L,
            cached = raw["cached"] as? Boolean ?: false,
        )
    }.onFailure { AuntieLog.e("getLocalWeather failed", it) }

    /**
     * Run-4 #7b: shared bank of common KinTale checklist items (defaults union the
     * admin-saved `checklist_bank`). Fail-loud via Result so the editor surfaces an
     * error rather than a silent-empty picker. Mirrors web FirestoreClient.listChecklistBank().
     */
    suspend fun getChecklistBank(): Result<List<ChecklistBankItem>> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listChecklistBank")
            .call(emptyMap<String, Any?>())
            .await().data as? Map<String, Any?>
            ?: error("listChecklistBank: non-map payload")
        (raw["items"] as? List<*>).orEmpty().mapNotNull { el ->
            val m = el as? Map<*, *> ?: return@mapNotNull null
            val text = (m["text"] as? String)?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            ChecklistBankItem(
                id = m["id"] as? String ?: "",
                text = text,
                scope = if (m["scope"] == "PER_VISIT") "PER_VISIT" else "PER_PET",
            )
        }
    }.onFailure { AuntieLog.e("getChecklistBank failed", it) }

    /** Run-4 #7b: persist a custom checklist item to the shared bank ("Save to bank"). */
    suspend fun saveChecklistBankItem(text: String, scope: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        functions.getHttpsCallable("saveChecklistBankItem")
            .call(mapOf("text" to text, "scope" to scope))
            .await()
        Unit
    }.onFailure { AuntieLog.e("saveChecklistBankItem failed", it) }

    // ── Stage 2 step 6 (Communicate broadcast) ──────────────────────────────
    // Saved audience segments + a multichannel broadcast, all via admin-gated
    // callables (MyTribe functions/src/admin/{audienceSegments,broadcastMessage}).
    // Fail-loud: the no_recipients / broadcast_all_failed sentinels and provider
    // errors surface verbatim through the Result failure.

    suspend fun listAudienceSegments(): Result<List<com.tribetails.auntieos.ui.communicate.AudienceSegment>> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listAudienceSegments")
            .call(emptyMap<String, Any?>())
            .await().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.communicate.decodeSegments(raw)
    }.onFailure { AuntieLog.e("listAudienceSegments failed", it) }

    suspend fun saveAudienceSegment(
        id: String?,
        name: String,
        criteria: com.tribetails.auntieos.ui.communicate.BroadcastCriteria,
    ): Result<String> = runCatching {
        ensureAuthenticated()
        val payload = buildMap<String, Any?> {
            if (!id.isNullOrBlank()) put("id", id)
            put("name", name)
            put("criteria", criteria.toPayload())
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("saveAudienceSegment").call(payload).await().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.communicate.decodeSavedSegmentId(raw)
    }.onFailure { AuntieLog.e("saveAudienceSegment failed", it) }

    suspend fun deleteAudienceSegment(id: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        functions.getHttpsCallable("deleteAudienceSegment").call(mapOf("id" to id)).await()
        Unit
    }.onFailure { AuntieLog.e("deleteAudienceSegment failed", it) }

    suspend fun broadcastMessage(
        segmentId: String?,
        criteria: com.tribetails.auntieos.ui.communicate.BroadcastCriteria?,
        channels: List<com.tribetails.auntieos.ui.communicate.BroadcastChannel>,
        subject: String?,
        body: String,
    ): Result<com.tribetails.auntieos.ui.communicate.BroadcastResult> = runCatching {
        ensureAuthenticated()
        val payload = buildMap<String, Any?> {
            if (!segmentId.isNullOrBlank()) put("segmentId", segmentId)
            if (criteria != null) put("criteria", criteria.toPayload())
            put("channels", channels.distinct().map { it.wire })
            if (!subject.isNullOrBlank()) put("subject", subject)
            put("body", body)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("broadcastMessage").call(payload).await().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.communicate.decodeBroadcastResult(raw)
    }.onFailure { AuntieLog.e("broadcastMessage failed", it) }

    // ── Stage 2 step 7 (Inbox conversations / Message Auntie 16.4) ────────────
    // Two-way kinfolk<->auntie threads via admin-gated callables. Fail-loud:
    // errors surface verbatim through the Result failure.

    suspend fun listConversations(): Result<List<com.tribetails.auntieos.ui.inbox.ConversationSummary>> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listConversations").call(emptyMap<String, Any?>()).await().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.inbox.decodeConversations(raw)
    }.onFailure { AuntieLog.e("listConversations failed", it) }

    suspend fun getConversationThread(kinfolkId: String): Result<List<com.tribetails.auntieos.ui.inbox.ThreadMessage>> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getConversationThread").call(mapOf("kinfolkId" to kinfolkId)).await().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.inbox.decodeThread(raw)
    }.onFailure { AuntieLog.e("getConversationThread failed", it) }

    suspend fun replyToConversation(kinfolkId: String, body: String): Result<String> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("replyToConversation").call(mapOf("kinfolkId" to kinfolkId, "body" to body)).await().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.inbox.decodeReplyMessageId(raw)
    }.onFailure { AuntieLog.e("replyToConversation failed", it) }

    suspend fun markConversationRead(kinfolkId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        functions.getHttpsCallable("markConversationRead").call(mapOf("kinfolkId" to kinfolkId)).await()
        Unit
    }.onFailure { AuntieLog.e("markConversationRead failed", it) }

    // ── Dashboard widget callables (AO-35/39/40/41) ──────────────────────────
    // Admin-gated MyTribe callables backing the hidden-by-default Home widgets.
    // Fail-loud: every failure (missing Mapbox key, missing supply, etc) rides the
    // Result.failure so the widget surfaces a real reason, never a fake value.

    /**
     * AO-35: optimize [dateYmd]'s (YYYY-MM-DD) route via the optimizeRoute callable.
     * Returns ordered stops + totals, and the fail-loud `unroutable` households that
     * have no serviceAddress. A missing Mapbox key surfaces as the callable's error.
     */
    suspend fun optimizeRoute(dateYmd: String): Result<RouteResult> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("optimizeRoute")
            .call(mapOf("date" to dateYmd)).await().data as? Map<String, Any?>
            ?: error("optimizeRoute: non-map payload")
        decodeRouteResult(raw)
    }.onFailure { AuntieLog.e("optimizeRoute failed", it) }

    /** AO-40: recent expenses + server week/month totals via listExpenses (default last 30 days). */
    suspend fun listExpenses(sinceIso: String? = null): Result<ExpenseSummary> = runCatching {
        ensureAuthenticated()
        val payload = buildMap<String, Any?> { if (!sinceIso.isNullOrBlank()) put("sinceIso", sinceIso) }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listExpenses")
            .call(payload).await().data as? Map<String, Any?>
            ?: error("listExpenses: non-map payload")
        decodeExpenseSummary(raw)
    }.onFailure { AuntieLog.e("listExpenses failed", it) }

    /** AO-40: quick-log an expense via logExpense; returns the new doc id. occurredAt defaults server-side to now. */
    suspend fun logExpense(
        kind: String,
        amountCents: Int,
        note: String? = null,
        occurredAt: String? = null,
    ): Result<String> = runCatching {
        ensureAuthenticated()
        val payload = buildMap<String, Any?> {
            put("kind", kind)
            put("amountCents", amountCents)
            if (!note.isNullOrBlank()) put("note", note)
            if (!occurredAt.isNullOrBlank()) put("occurredAt", occurredAt)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("logExpense").call(payload).await().data as? Map<String, Any?>
            ?: error("logExpense: non-map payload")
        raw["id"] as? String ?: error("logExpense: missing id")
    }.onFailure { AuntieLog.e("logExpense failed", it) }

    /** AO-41: supplies + low count (onHand <= par) via listSupplies. */
    suspend fun listSupplies(): Result<SuppliesResult> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listSupplies")
            .call(emptyMap<String, Any?>()).await().data as? Map<String, Any?>
            ?: error("listSupplies: non-map payload")
        decodeSuppliesResult(raw)
    }.onFailure { AuntieLog.e("listSupplies failed", it) }

    /** AO-41: bump a supply's on-hand by [delta] via adjustSupply (server clamps at 0); returns the new onHand. */
    suspend fun adjustSupply(supplyId: String, delta: Int): Result<Int> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("adjustSupply")
            .call(mapOf("supplyId" to supplyId, "delta" to delta)).await().data as? Map<String, Any?>
            ?: error("adjustSupply: non-map payload")
        (raw["onHand"] as? Number)?.toInt() ?: error("adjustSupply: missing onHand")
    }.onFailure { AuntieLog.e("adjustSupply failed", it) }

    /** AO-39: upcoming expirations via listExpirations (server sorts by dateIso asc). */
    suspend fun listExpirations(): Result<List<ExpirationItem>> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listExpirations")
            .call(emptyMap<String, Any?>()).await().data as? Map<String, Any?>
            ?: error("listExpirations: non-map payload")
        decodeExpirations(raw)
    }.onFailure { AuntieLog.e("listExpirations failed", it) }

    private fun decodeExpirations(raw: Map<String, Any?>): List<ExpirationItem> =
        (raw["expirations"] as? List<*>).orEmpty().mapNotNull { el ->
            val m = el as? Map<*, *> ?: return@mapNotNull null
            ExpirationItem(
                id = (m["_id"] ?: m["id"]) as? String ?: "",
                label = m["label"] as? String ?: "",
                dateIso = m["dateIso"] as? String ?: "",
                kinfolkId = m["kinfolkId"] as? String ?: "",
                kind = m["kind"] as? String ?: "",
            )
        }

    private fun decodeExpense(m: Map<*, *>): Expense = Expense(
        id = (m["_id"] ?: m["id"]) as? String ?: "",
        kind = m["kind"] as? String ?: "",
        amountCents = (m["amountCents"] as? Number)?.toInt() ?: 0,
        note = m["note"] as? String ?: "",
        occurredAt = m["occurredAt"] as? String ?: "",
    )

    private fun decodeExpenseSummary(raw: Map<String, Any?>): ExpenseSummary = ExpenseSummary(
        expenses = (raw["expenses"] as? List<*>).orEmpty().mapNotNull { (it as? Map<*, *>)?.let(::decodeExpense) },
        weekTotalCents = (raw["weekTotalCents"] as? Number)?.toInt() ?: 0,
        monthTotalCents = (raw["monthTotalCents"] as? Number)?.toInt() ?: 0,
    )

    private fun decodeSupply(m: Map<*, *>): Supply = Supply(
        id = (m["_id"] ?: m["id"]) as? String ?: "",
        name = m["name"] as? String ?: "",
        onHand = (m["onHand"] as? Number)?.toInt() ?: 0,
        par = (m["par"] as? Number)?.toInt() ?: 0,
        unit = m["unit"] as? String ?: "",
    )

    private fun decodeSuppliesResult(raw: Map<String, Any?>): SuppliesResult = SuppliesResult(
        supplies = (raw["supplies"] as? List<*>).orEmpty().mapNotNull { (it as? Map<*, *>)?.let(::decodeSupply) },
        lowCount = (raw["lowCount"] as? Number)?.toInt() ?: 0,
    )

    private fun decodeRouteResult(raw: Map<String, Any?>): RouteResult = RouteResult(
        stops = (raw["stops"] as? List<*>).orEmpty().mapNotNull { el ->
            val m = el as? Map<*, *> ?: return@mapNotNull null
            RouteStop(
                order = (m["order"] as? Number)?.toInt() ?: 0,
                sessionId = m["sessionId"] as? String ?: "",
                kinfolkId = m["kinfolkId"] as? String ?: "",
                household = m["household"] as? String ?: "",
                address = m["address"] as? String ?: "",
                arrivalEta = m["arrivalEta"] as? String ?: "",
            )
        },
        totalMiles = (raw["totalMiles"] as? Number)?.toDouble() ?: 0.0,
        totalMinutes = (raw["totalMinutes"] as? Number)?.toInt() ?: 0,
        unroutable = (raw["unroutable"] as? List<*>).orEmpty().mapNotNull { el ->
            val m = el as? Map<*, *> ?: return@mapNotNull null
            UnroutableStop(
                sessionId = m["sessionId"] as? String ?: "",
                household = m["household"] as? String ?: "",
                reason = m["reason"] as? String ?: "",
            )
        },
    )

    suspend fun getRecentDrafts(): Result<List<Draft>> = runCatching {
        AuntieLog.d("Fetching recent drafts")
        ensureAuthenticated()
        val mode = requireTestMode()
        val col = firestore.collection("generated_drafts")
        if (mode.active) {
            // Stage-0I sandbox: rules DENY an unfiltered list of generated_drafts, so
            // constrain to this tribe's own drafts (the doc's snake_case `kinfolk_id`
            // field == testScope; see generate.js). Sort + cap client-side to avoid a
            // composite (kinfolk_id, createdOn) index; the sandbox draft set is tiny.
            col.whereEqualTo("kinfolk_id", mode.testTribeId)
                .get().await()
                .toObjects(Draft::class.java)
                .sortedByDescending { it.createdOn }
                .take(3)
        } else {
            col.orderBy("createdOn", com.google.firebase.firestore.Query.Direction.DESCENDING)
                .limit(3)
                .get().await()
                .toObjects(Draft::class.java)
        }
    }.onFailure { AuntieLog.e("Failed to get recent drafts", it) }

    suspend fun getKinfolkCount(): Result<Int> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        if (mode.active) {
            // Only kinfolk/{testTribeId} is reachable; count is 0 or 1.
            return@runCatching if (firestore.collection("kinfolk").document(mode.testTribeId).get().await().exists()) 1 else 0
        }
        firestore.collection("kinfolk").get().await().size()
    }.onFailure { AuntieLog.e("Failed to get kinfolk count", it) }

    suspend fun getKinCount(): Result<Int> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        firestore.collection("kin").scopedByKinfolk(mode).get().await().size()
    }.onFailure { AuntieLog.e("Failed to get kin count", it) }

    suspend fun getPendingDraftCount(): Result<Int> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val col = firestore.collection("generated_drafts")
        if (mode.active) {
            // Stage-0I sandbox: scope to this tribe (kinfolk_id == testScope) and count
            // 'pending' client-side to avoid a composite (kinfolk_id, status) index. An
            // unfiltered read is denied by rules for a test admin.
            col.whereEqualTo("kinfolk_id", mode.testTribeId)
                .get().await()
                .documents.count { it.getString("status") == "pending" }
        } else {
            col.whereEqualTo("status", "pending")
                .get().await()
                .size()
        }
    }.onFailure { AuntieLog.e("Failed to get pending draft count", it) }

    // Business/Operational Settings
    suspend fun getBusinessSettings(): Result<BusinessSettings> = runCatching {
        AuntieLog.d("Fetching business settings")
        ensureAuthenticated()
        val snapshot = firestore.collection("business_settings")
            .document("business_settings")
            .get()
            .await()

        if (snapshot.exists()) {
            snapshot.toObject(BusinessSettings::class.java) ?: BusinessSettings()
        } else {
            AuntieLog.i("Business settings document not found, returning defaults")
            BusinessSettings()
        }
    }.onFailure { AuntieLog.e("Failed to get business settings", it) }

    suspend fun saveBusinessSettings(
        settings: BusinessSettings,
        updatedBy: String = "admin"
    ): Result<Unit> = runCatching {
        AuntieLog.i("Saving business settings by $updatedBy")
        ensureAuthenticated()
        val timestamp = getCurrentTimestamp()
        val updatedSettings = settings.copy(
            updatedAt = timestamp,
            updatedBy = updatedBy
        )
        // SetOptions.merge() read-modify-write: a save never deletes sibling
        // fields it did not touch. Unified settings doc (2026-06-05), so a
        // screen that only edits a subset can never clobber the rest of the
        // union (booking config, timeBlocks, GPS, profile, etc). See
        // docs/2026-06-05-settings-unification-design.md.
        firestore.collection("business_settings")
            .document("business_settings")
            .set(updatedSettings, com.google.firebase.firestore.SetOptions.merge())
            .await()
        AuntieLog.d("Business settings saved successfully")
        Unit
    }.onFailure { AuntieLog.e("Failed to save business settings", it) }

    // Business Hours - single source of truth lives in ServiceRepository.
    // AuntieRepository delegates so AdminSettings + ServiceManagement screens
    // never diverge on the `business_hours` collection.
    private val serviceRepo by lazy { ServiceRepository() }

    suspend fun getBusinessHours(): Result<List<BusinessHours>> {
        ensureAuthenticated()
        return serviceRepo.getBusinessHours()
    }

    suspend fun saveBusinessHours(hours: List<BusinessHours>): Result<Unit> {
        ensureAuthenticated()
        return serviceRepo.updateBusinessHours(hours)
    }

    private fun getCurrentTimestamp(): String {
        return java.time.Instant.now().toString()
    }

    // --- Media Storage Management ---

    suspend fun getMediaFiles(entityId: String, entityType: MediaEntityType): Result<List<MediaFile>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("media_files")
            .whereEqualTo("entityId", entityId)
            .whereEqualTo("entityType", entityType.name)
            .orderBy("uploadedAt", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .get()
            .await()
        snapshot.toObjects(MediaFile::class.java)
    }.onFailure { AuntieLog.e("Failed to get media files", it) }

    /** #13 Gallery: ALL business media (every entity). Test-admin sandbox: scoped to the
     *  test kinfolk's media via [scopedByKinfolk]; the operator gets the full collection. */
    suspend fun getAllMedia(): Result<List<MediaFile>> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        firestore.collection("media_files").scopedByKinfolk(mode).get().await()
            .toObjects(MediaFile::class.java)
    }.onFailure { AuntieLog.e("Failed to get all media", it) }

    /** #13 Gallery: set the kin tagged in a media file (rules gate to isAuntie/testOwns). */
    suspend fun updateMediaTags(mediaFileId: String, taggedKinIds: List<String>): Result<Unit> = runCatching {
        ensureAuthenticated()
        firestore.collection("media_files").document(mediaFileId)
            .update("taggedKinIds", taggedKinIds).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update media tags", it) }

    suspend fun saveMediaFile(mediaFile: MediaFile): Result<String> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val docRef = firestore.collection("media_files").document()
        // Stage 0I: a test admin must stamp kinfolkId == testTribeId so the sandbox
        // rules (testOwnsIncoming) allow the write; the operator writes no scope.
        // kinfolkId is now a typed MediaFile field, so a single set() carries it
        // (replaces the prior second SetOptions.merge write from before the field existed).
        val newMediaFile = mediaFile
            .copy(id = docRef.id, uploadedAt = getCurrentTimestamp())
            .withSandboxScope(if (mode.active) mode.testTribeId else null)
        docRef.set(newMediaFile).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to save media file", it) }

    suspend fun deleteMediaFile(mediaFileId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        firestore.collection("media_files").document(mediaFileId).delete().await()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete media file", it) }

    // --- Location Tracking Management ---

    // ---- Breadcrumbs subcollection (canonical GPS storage; parity w/ AuntieOS web FirestoreClient) ----
    //
    // Per bug-sprint architecture: GPS points live in
    // `kin_care_sessions/{sessionId}/breadcrumbs/{autoId}` - NOT as an array on
    // the parent doc.

    suspend fun addBreadcrumb(sessionId: String, point: LocationPoint): Result<String> = runCatching {
        ensureAuthenticated()
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
        ensureAuthenticated()
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

    suspend fun saveVisitRoute(route: VisitRoute): Result<String> = runCatching {
        ensureAuthenticated()
        // Respect caller-supplied id so the route shell persisted at startTracking
        // becomes the same doc updated at saveRoute end-of-visit. Prevents orphan
        // LocationCheckpoint rows whose routeId references a route id that didn't
        // yet exist when the checkpoint was written.
        val docRef = if (route.id.isNotBlank()) {
            firestore.collection("visit_routes").document(route.id)
        } else {
            firestore.collection("visit_routes").document()
        }
        val newRoute = route.copy(
            id = docRef.id,
            createdAt = if (route.createdAt.isBlank()) getCurrentTimestamp() else route.createdAt,
            updatedAt = getCurrentTimestamp()
        )
        docRef.set(newRoute).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to save visit route", it) }

    suspend fun getVisitRoute(routeId: String): Result<VisitRoute?> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("visit_routes").document(routeId).get().await()
        snapshot.toObject(VisitRoute::class.java)
    }.onFailure { AuntieLog.e("Failed to get visit route", it) }

    suspend fun getVisitRoutesForKinfolk(kinfolkId: String): Result<List<VisitRoute>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("visit_routes")
            .whereEqualTo("kinfolkId", kinfolkId)
            .orderBy("startTime", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .get()
            .await()
        snapshot.toObjects(VisitRoute::class.java)
    }.onFailure { AuntieLog.e("Failed to get visit routes", it) }

    suspend fun saveLocationCheckpoint(checkpoint: LocationCheckpoint): Result<String> = runCatching {
        ensureAuthenticated()
        val docRef = firestore.collection("location_checkpoints").document()
        val newCheckpoint = checkpoint.copy(
            id = docRef.id,
            timestamp = if (checkpoint.timestamp.isBlank()) getCurrentTimestamp() else checkpoint.timestamp
        )
        docRef.set(newCheckpoint).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to save location checkpoint", it) }

    suspend fun getCheckpointsForRoute(routeId: String): Result<List<LocationCheckpoint>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("location_checkpoints")
            .whereEqualTo("routeId", routeId)
            .orderBy("timestamp")
            .get()
            .await()
        snapshot.toObjects(LocationCheckpoint::class.java)
    }.onFailure { AuntieLog.e("Failed to get checkpoints", it) }

    suspend fun getLocationSharingPreferences(kinfolkId: String): Result<LocationSharingPreferences?> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("location_sharing_preferences")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get()
            .await()
        snapshot.toObjects(LocationSharingPreferences::class.java).firstOrNull()
    }.onFailure { AuntieLog.e("Failed to get location sharing preferences", it) }

    suspend fun saveLocationSharingPreferences(preferences: LocationSharingPreferences): Result<Unit> = runCatching {
        ensureAuthenticated()
        val timestamp = getCurrentTimestamp()

        if (preferences.id.isBlank()) {
            val docRef = firestore.collection("location_sharing_preferences").document()
            val newPrefs = preferences.copy(
                id = docRef.id,
                updatedAt = timestamp
            )
            docRef.set(newPrefs).await()
        } else {
            val updatedPrefs = preferences.copy(
                updatedAt = timestamp
            )
            firestore.collection("location_sharing_preferences").document(preferences.id).set(updatedPrefs).await()
        }
        Unit
    }.onFailure { AuntieLog.e("Failed to save location sharing preferences", it) }

    suspend fun getVisitRoutesForSession(sessionId: String): Result<List<VisitRoute>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("visit_routes")
            .whereEqualTo("kinCareSessionId", sessionId)
            .orderBy("startTime", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .get()
            .await()
        snapshot.toObjects(VisitRoute::class.java)
    }.onFailure { AuntieLog.e("Failed to get visit routes for session $sessionId", it) }

    // --- Household Data ---

    suspend fun getHouseholdData(kinfolkId: String): Result<HouseholdData?> = runCatching {
        AuntieLog.d("Fetching household data for kinfolk: $kinfolkId")
        ensureAuthenticated()
        val snapshot = firestore.collection("household_data")
            .whereEqualTo("kinfolkId", kinfolkId)
            .limit(1)
            .get()
            .await()
        snapshot.documents.firstOrNull()?.toObject(HouseholdData::class.java)
    }.onFailure { AuntieLog.e("Failed to get household data for $kinfolkId", it) }

    suspend fun saveHouseholdData(data: HouseholdData): Result<Unit> = runCatching {
        ensureAuthenticated()
        val timestamp = getCurrentTimestamp()
        if (data.id.isBlank()) {
            val docRef = firestore.collection("household_data").document()
            docRef.set(data.copy(
                id = docRef.id,
                createdAt = if (data.createdAt.isBlank()) timestamp else data.createdAt,
                updatedAt = timestamp
            )).await()
        } else {
            // MERGE: update path on an existing record, so it must not delete
            // fields outside this model. The create branch above is a bare set()
            // on purpose, since there is nothing yet to clobber.
            firestore.collection("household_data").document(data.id)
                .set(data.copy(updatedAt = timestamp), com.google.firebase.firestore.SetOptions.merge())
                .await()
        }
        Unit
    }.onFailure { AuntieLog.e("Failed to save household data for ${data.kinfolkId}", it) }

    // --- Media Albums ---

    suspend fun getMediaAlbums(entityId: String, entityType: MediaEntityType): Result<List<MediaAlbum>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("media_albums")
            .whereEqualTo("entityId", entityId)
            .whereEqualTo("entityType", entityType.name)
            .orderBy("sortOrder")
            .get()
            .await()
        snapshot.toObjects(MediaAlbum::class.java)
    }.onFailure { AuntieLog.e("Failed to get media albums", it) }

    // --- Dynamic Field Definitions ---

    suspend fun getFieldDefinitions(targetEntity: TargetEntity? = null): Result<List<FieldDefinition>> = runCatching {
        ensureAuthenticated()
        val base = firestore.collection("field_definitions")
            .whereEqualTo("isActive", true)
        val query = if (targetEntity != null) {
            base.whereEqualTo("targetEntity", targetEntity.name)
        } else {
            base
        }
        val snapshot = query.get().await()
        snapshot.toObjects(FieldDefinition::class.java).sortedBy { it.sortOrder }
    }.onFailure { AuntieLog.e("Failed to get field definitions", it) }

    suspend fun createFieldDefinition(field: FieldDefinition): Result<String> = runCatching {
        ensureAuthenticated()
        val docRef = firestore.collection("field_definitions").document()
        val timestamp = getCurrentTimestamp()
        docRef.set(field.copy(
            id = docRef.id,
            createdAt = timestamp,
            updatedAt = timestamp
        )).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to create field definition", it) }

    suspend fun updateFieldDefinition(field: FieldDefinition): Result<Unit> = runCatching {
        ensureAuthenticated()
        firestore.collection("field_definitions").document(field.id)
            .set(field.copy(updatedAt = getCurrentTimestamp()))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update field definition ${field.id}", it) }

    suspend fun deleteFieldDefinition(fieldId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        firestore.collection("field_definitions").document(fieldId).delete().await()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete field definition $fieldId", it) }

    // --- Dynamic Field Values ---

    suspend fun getDynamicFieldValues(entityId: String, entityType: TargetEntity): Result<List<DynamicFieldValue>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("dynamic_field_values")
            .whereEqualTo("entityId", entityId)
            .whereEqualTo("entityType", entityType.name)
            .get()
            .await()
        snapshot.toObjects(DynamicFieldValue::class.java)
    }.onFailure { AuntieLog.e("Failed to get dynamic field values", it) }

    suspend fun saveDynamicFieldValue(value: DynamicFieldValue): Result<String> = runCatching {
        ensureAuthenticated()
        val timestamp = getCurrentTimestamp()
        if (value.id.isBlank()) {
            val docRef = firestore.collection("dynamic_field_values").document()
            docRef.set(value.copy(
                id = docRef.id,
                createdAt = timestamp,
                updatedAt = timestamp
            )).await()
            docRef.id
        } else {
            firestore.collection("dynamic_field_values").document(value.id)
                .set(value.copy(updatedAt = timestamp))
                .await()
            value.id
        }
    }.onFailure { AuntieLog.e("Failed to save dynamic field value", it) }

    // --- Invoices ---

    suspend fun getInvoices(): Result<List<Invoice>> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val snapshot = firestore.collection("invoices").scopedByKinfolk(mode).get().await()
        snapshot.toObjects(Invoice::class.java)
    }.onFailure { AuntieLog.e("Failed to get invoices", it) }

    suspend fun getInvoicesForKinfolk(kinfolkId: String): Result<List<Invoice>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("invoices")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get()
            .await()
        snapshot.toObjects(Invoice::class.java)
    }.onFailure { AuntieLog.e("Failed to get invoices for $kinfolkId", it) }

    /**
     * Slice 2: routes through the createInvoice callable (server mints the id,
     * writes audit BILLING_INVOICE_CREATED, and enqueues the invoice.new
     * notification). Replaces the old silent direct Firestore write.
     */
    suspend fun createInvoice(invoice: Invoice): Result<String> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        // In test mode force the invoice's household to the sandbox kinfolk so the
        // server write lands inside the rules-enforced scope.
        val scopedFamilyId = mode.scopedKinfolkId(invoice.kinfolkId)
        val payload = mapOf(
            "familyId" to scopedFamilyId,
            "kinfolkName" to invoice.kinfolkName,
            "invoiceNumber" to invoice.invoiceNumber,
            "client" to invoice.client,
            "address" to invoice.address,
            "date" to invoice.date,
            "terms" to invoice.terms,
            "dueDate" to invoice.dueDate,
            "discount" to invoice.discount,
            "total" to invoice.total,
            "amountDue" to invoice.amountDue,
            "status" to invoice.status,
            "sessionIds" to invoice.sessionIds,
        )
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("createInvoice").call(payload).await().data as? Map<String, Any?>
            ?: error("createInvoice: non-map payload")
        raw["invoiceId"] as? String ?: error("createInvoice: missing invoiceId")
    }.onFailure { AuntieLog.e("Failed to create invoice", it) }

    /**
     * Stage 3 / 16.2: generates a downloadable PDF of an invoice via the
     * generateInvoicePdf callable (server renders with pdf-lib + stores to Cloud
     * Storage) and returns the download URL to open. Fail-loud on error.
     */
    suspend fun generateInvoicePdf(invoiceId: String): Result<String> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("generateInvoicePdf")
            .call(mapOf("invoiceId" to invoiceId))
            .await().data as? Map<String, Any?>
        (raw?.get("pdfUrl") as? String)?.takeIf { it.isNotBlank() }
            ?: error("generateInvoicePdf: server returned no pdfUrl")
    }.onFailure { AuntieLog.e("generateInvoicePdf failed for $invoiceId", it) }

    /** Slice 2: marks an invoice receipted via the generateReceipt callable. */
    suspend fun generateReceipt(invoiceId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        functions.getHttpsCallable("generateReceipt")
            .call(mapOf("invoiceId" to invoiceId))
            .await()
        Unit
    }.onFailure { AuntieLog.e("generateReceipt failed for $invoiceId", it) }

    /**
     * Stage 2 tail: admin-initiated on-demand resend of a single invoice reminder
     * via the sendInvoiceReminder callable (reuses the cron's per-invoice dispatch
     * path; stamps reminderNotifiedAtMs for idempotency). Returns the invoiceId on
     * success. Fail-loud: the server message (already-paid, not-found, etc.) is
     * surfaced verbatim.
     */
    suspend fun sendInvoiceReminder(invoiceId: String): Result<String> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("sendInvoiceReminder")
            .call(mapOf("invoiceId" to invoiceId))
            .await().data as? Map<String, Any?>
        decodeSentReminderInvoiceId(raw, invoiceId)
    }.onFailure { AuntieLog.e("sendInvoiceReminder failed for $invoiceId", it) }

    /**
     * Stage 2 tail: transition a DRAFT invoice to "sent" via the postInvoiceEvent
     * callable. postInvoiceEvent merges the supplied payload onto invoices/{invoiceId}
     * and (because the doc already exists) fires the invoice.updated notification.
     * Only the status field is merged, leaving the rest of the invoice untouched.
     */
    suspend fun reviewAndSendDraftInvoice(invoiceId: String, familyId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val scopedFamilyId = mode.scopedKinfolkId(familyId)
        val payload = mapOf(
            "familyId" to scopedFamilyId,
            "invoiceId" to invoiceId,
            "payload" to mapOf("status" to "sent"),
        )
        functions.getHttpsCallable("postInvoiceEvent").call(payload).await()
        Unit
    }.onFailure { AuntieLog.e("reviewAndSendDraftInvoice failed for $invoiceId", it) }

    /**
     * Stage 2 tail: apply ONE booking transition (APPROVE/REJECT/CANCEL) to many
     * individual visit ids at once via the batchUpdateBookings callable. Returns the
     * updated count + per-id failures. Fail-loud: per-id failures are surfaced in
     * [BatchBookingResult.failed] so callers can show updated/failed honestly.
     */
    suspend fun batchUpdateBookings(ids: List<String>, action: String): Result<BatchBookingResult> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("batchUpdateBookings")
            .call(mapOf("ids" to ids, "action" to action))
            .await().data as? Map<String, Any?>
        decodeBatchBookingResult(raw, action)
    }.onFailure { AuntieLog.e("batchUpdateBookings ($action) failed for ${ids.size} id(s)", it) }

    /**
     * Stage 2 tail: mark MANY notifications read at once via the
     * bulkMarkNotificationsRead callable. Returns the number actually marked (ids
     * not owned/missing are skipped server-side).
     */
    suspend fun bulkMarkNotificationsRead(ids: List<String>): Result<Int> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("bulkMarkNotificationsRead")
            .call(mapOf("ids" to ids))
            .await().data as? Map<String, Any?>
        decodeMarkedCount(raw)
    }.onFailure { AuntieLog.e("bulkMarkNotificationsRead failed for ${ids.size} id(s)", it) }

    /**
     * Step 4 quick-action: mark ONE notification read via the markNotificationRead
     * callable (writes a readAt server timestamp). Fail-loud: server preconditions
     * (not-found / not-your-notification) surface verbatim.
     */
    suspend fun markNotificationRead(id: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(id.isNotBlank()) { "markNotificationRead requires a notification id" }
        functions.getHttpsCallable("markNotificationRead")
            .call(mapOf("notificationId" to id))
            .await()
        Unit
    }.onFailure { AuntieLog.e("markNotificationRead failed for $id", it) }

    /**
     * Step 4 quick-action: clear ONE notification's read markers via the
     * markNotificationUnread callable (inverse of markNotificationRead).
     */
    suspend fun markNotificationUnread(id: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(id.isNotBlank()) { "markNotificationUnread requires a notification id" }
        functions.getHttpsCallable("markNotificationUnread")
            .call(mapOf("notificationId" to id))
            .await()
        Unit
    }.onFailure { AuntieLog.e("markNotificationUnread failed for $id", it) }

    /**
     * Step 4 quick-action: archive ONE notification out of the active inbox via the
     * archiveNotification callable (writes an archivedAt server timestamp; nothing
     * is deleted). Returns the number actually archived (0 when the id is stale or
     * not the caller's). Fail-loud.
     */
    suspend fun archiveNotification(id: String): Result<Int> = runCatching {
        ensureAuthenticated()
        require(id.isNotBlank()) { "archiveNotification requires a notification id" }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("archiveNotification")
            .call(mapOf("id" to id))
            .await().data as? Map<String, Any?>
        decodeArchivedCount(raw)
    }.onFailure { AuntieLog.e("archiveNotification failed for $id", it) }

    /**
     * Step 4 quick-action: archive MANY notifications at once via the
     * bulkArchiveNotifications callable. Returns the number actually archived (ids
     * not owned/missing are skipped server-side).
     */
    suspend fun bulkArchiveNotifications(ids: List<String>): Result<Int> = runCatching {
        ensureAuthenticated()
        require(ids.isNotEmpty()) { "bulkArchiveNotifications requires at least one id" }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("bulkArchiveNotifications")
            .call(mapOf("ids" to ids))
            .await().data as? Map<String, Any?>
        decodeArchivedCount(raw)
    }.onFailure { AuntieLog.e("bulkArchiveNotifications failed for ${ids.size} id(s)", it) }

    /**
     * Step 4 (PART B): create a QUOTE via the createQuote callable. A quote is NOT a
     * separate model; it is an invoice in QUOTE status. createQuote mirrors
     * createInvoice's args exactly but forces QUOTE status server-side and, when
     * [sendToKinfolk] is true, dispatches the issued-quote notification (catalog key
     * invoice.new) targeting the new invoice doc. Returns the new invoiceId.
     */
    suspend fun createQuote(invoice: Invoice, sendToKinfolk: Boolean): Result<String> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val scopedFamilyId = mode.scopedKinfolkId(invoice.kinfolkId)
        val payload = mapOf(
            "familyId" to scopedFamilyId,
            "kinfolkName" to invoice.kinfolkName,
            "invoiceNumber" to invoice.invoiceNumber,
            "client" to invoice.client,
            "address" to invoice.address,
            "date" to invoice.date,
            "terms" to invoice.terms,
            "dueDate" to invoice.dueDate,
            "discount" to invoice.discount,
            "total" to invoice.total,
            "amountDue" to invoice.amountDue,
            "sessionIds" to invoice.sessionIds,
            "sendToKinfolk" to sendToKinfolk,
        )
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("createQuote").call(payload).await().data as? Map<String, Any?>
            ?: error("createQuote: non-map payload")
        raw["invoiceId"] as? String ?: error("createQuote: missing invoiceId")
    }.onFailure { AuntieLog.e("Failed to create quote", it) }

    suspend fun updateInvoice(invoice: Invoice): Result<Unit> = runCatching {
        ensureAuthenticated()
        // MERGE: `invoices` carries backend-written structure this model does not
        // declare (`sessionIds` is populated by backfill_structural_links.py), and
        // a bare set() from the admin would drop it.
        firestore.collection("invoices").document(invoice.id).set(invoice, com.google.firebase.firestore.SetOptions.merge()).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update invoice ${invoice.id}", it) }

    suspend fun getInvoiceById(invoiceId: String): Result<Invoice> = runCatching {
        ensureAuthenticated()
        val doc = firestore.collection("invoices").document(invoiceId).get().await()
        doc.toObject(Invoice::class.java)
            ?: throw NoSuchElementException("Invoice $invoiceId not found")
    }.onFailure { AuntieLog.e("Failed to get invoice $invoiceId", it) }

    suspend fun updateInvoiceSessionIds(invoiceId: String, sessionIds: List<String>): Result<Unit> = runCatching {
        ensureAuthenticated()
        val ts = getCurrentTimestamp()
        firestore.collection("invoices").document(invoiceId).update(
            mapOf(
                "sessionIds"      to sessionIds,
                "_attribution"    to "manual",
                "_attributionAt"  to ts,
                "updatedAt"       to ts,
            )
        ).await()
        AuntieLog.i("Linked ${sessionIds.size} session(s) to invoice $invoiceId")
        Unit
    }.onFailure { AuntieLog.e("Failed to update invoice sessionIds for $invoiceId", it) }

    suspend fun updateSessionInvoiceId(sessionId: String, invoiceId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        val ts = getCurrentTimestamp()
        val update = if (invoiceId.isBlank()) {
            mapOf("invoiceId" to "", "_attribution" to "manual_unlink", "_attributionAt" to ts, "updatedAt" to ts)
        } else {
            mapOf("invoiceId" to invoiceId, "_attribution" to "manual", "_attributionAt" to ts, "updatedAt" to ts)
        }
        firestore.collection("kin_care_sessions").document(sessionId).update(update).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update session invoiceId for $sessionId", it) }

    // --- Payments ---

    suspend fun getPayments(): Result<List<Payment>> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val snapshot = firestore.collection("payments").scopedByKinfolk(mode).get().await()
        snapshot.toObjects(Payment::class.java)
    }.onFailure { AuntieLog.e("Failed to get payments", it) }

    suspend fun getPaymentsForKinfolk(kinfolkId: String): Result<List<Payment>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("payments")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get()
            .await()
        snapshot.toObjects(Payment::class.java)
    }.onFailure { AuntieLog.e("Failed to get payments for $kinfolkId", it) }

    suspend fun createPayment(payment: Payment): Result<String> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val payment = if (mode.active) payment.copy(kinfolkId = mode.scopedKinfolkId(payment.kinfolkId)) else payment
        val docRef = firestore.collection("payments").document()
        docRef.set(payment.copy(id = docRef.id)).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to create payment", it) }

    // --- Visit Logs ---

    suspend fun getVisitLogs(): Result<List<VisitLog>> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val snapshot = firestore.collection("visit_logs").scopedByKinfolk(mode).get().await()
        snapshot.toObjects(VisitLog::class.java)
    }.onFailure { AuntieLog.e("Failed to get visit logs", it) }

    suspend fun getVisitLogsForKinfolk(kinfolkId: String): Result<List<VisitLog>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("visit_logs")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get()
            .await()
        snapshot.toObjects(VisitLog::class.java)
    }.onFailure { AuntieLog.e("Failed to get visit logs for $kinfolkId", it) }

    suspend fun createVisitLog(log: VisitLog): Result<String> = runCatching {
        ensureAuthenticated()
        val docRef = firestore.collection("visit_logs").document()
        val timestamp = getCurrentTimestamp()
        docRef.set(log.copy(
            id = docRef.id,
            submitted = if (log.submitted.isBlank()) timestamp else log.submitted
        )).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to create visit log", it) }

    // --- Training Documents ---

    suspend fun getTrainingDocuments(): Result<List<TrainingDocument>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("training_documents").get().await()
        snapshot.toObjects(TrainingDocument::class.java)
    }.onFailure { AuntieLog.e("Failed to get training documents", it) }

    private fun trainingDocAttachmentMaps(attachments: List<TrainingDocAttachment>): List<Map<String, Any?>> =
        attachments.map { a ->
            mapOf(
                "storageUrl" to a.storageUrl,
                "cloudinaryPublicId" to a.cloudinaryPublicId,
                "fileType" to a.fileType,
                "mimeType" to a.mimeType,
                "fileName" to a.fileName,
            )
        }

    /**
     * Spec 23: create a Tribal Intel note via the server-bound createTrainingDocument
     * callable (admin claim enforced + audit sealed server-side; replaces the old
     * client-side Firestore write). Queues the doc for the nightly reconcile pipeline.
     */
    suspend fun createTrainingDocument(
        title: String,
        content: String,
        notes: String,
        targetType: String,
        targetKinfolkId: String,
        targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
        communicationType: String = "note",
    ): Result<String> = runCatching {
        ensureAuthenticated()
        require(targetKinfolkId.isNotBlank()) { "targetKinfolkId required" }
        val payload = mutableMapOf<String, Any?>(
            "title" to title,
            "content" to content,
            "notes" to notes,
            "communicationType" to communicationType,
            "targetType" to targetType,
            "targetKinfolkId" to targetKinfolkId,
            "attachments" to trainingDocAttachmentMaps(attachments),
        )
        if (targetType == "KIN" && !targetKinId.isNullOrBlank()) payload["targetKinId"] = targetKinId
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("createTrainingDocument").call(payload).await().data as? Map<String, Any?>
            ?: error("createTrainingDocument: non-map payload")
        raw["docId"] as? String ?: error("createTrainingDocument: missing docId")
    }.onFailure { AuntieLog.e("Failed to create training document", it) }

    /** Spec 23: edit a Tribal Intel note. Re-queues it for the next reconcile pass. */
    suspend fun updateTrainingDocument(
        docId: String,
        title: String,
        content: String,
        notes: String,
        targetType: String,
        targetKinfolkId: String,
        targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
        communicationType: String = "note",
    ): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(docId.isNotBlank()) { "docId required" }
        require(targetKinfolkId.isNotBlank()) { "targetKinfolkId required" }
        val payload = mutableMapOf<String, Any?>(
            "docId" to docId,
            "title" to title,
            "content" to content,
            "notes" to notes,
            "communicationType" to communicationType,
            "targetType" to targetType,
            "targetKinfolkId" to targetKinfolkId,
            "attachments" to trainingDocAttachmentMaps(attachments),
        )
        if (targetType == "KIN" && !targetKinId.isNullOrBlank()) payload["targetKinId"] = targetKinId
        functions.getHttpsCallable("updateTrainingDocument").call(payload).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update training document $docId", it) }

    /** Spec 23: delete a Tribal Intel note. Does NOT unmerge already-folded dossier/411 text. */
    suspend fun deleteTrainingDocument(docId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(docId.isNotBlank()) { "docId required" }
        functions.getHttpsCallable("deleteTrainingDocument").call(mapOf("docId" to docId)).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete training document $docId", it) }

    // --- Kin Care Sessions ---

    suspend fun getKinCareSessions(): Result<List<KinCareSession>> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val snapshot = firestore.collection("kin_care_sessions").scopedByKinfolk(mode).get().await()
        snapshot.toObjects(KinCareSession::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care sessions", it) }

    suspend fun getKinCareSession(sessionId: String): Result<KinCareSession?> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("kin_care_sessions").document(sessionId).get().await()
        snapshot.toObject(KinCareSession::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care session $sessionId", it) }

    suspend fun getKinCareSessionsForKinfolk(kinfolkId: String): Result<List<KinCareSession>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("kin_care_sessions")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get()
            .await()
        snapshot.toObjects(KinCareSession::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care sessions for $kinfolkId", it) }

    suspend fun getKinCareSessionsBySourceBookingId(sourceBookingId: String): Result<List<KinCareSession>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("kin_care_sessions")
            .whereEqualTo("sourceBookingId", sourceBookingId)
            .get()
            .await()
        snapshot.toObjects(KinCareSession::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care sessions for source booking $sourceBookingId", it) }

    suspend fun createKinCareSession(session: KinCareSession): Result<String> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val session = if (mode.active) session.copy(kinfolkId = mode.scopedKinfolkId(session.kinfolkId)) else session
        val docRef = firestore.collection("kin_care_sessions").document()
        val timestamp = getCurrentTimestamp()

        // Auto-fill kinIds from the kinfolk's active kin if the caller didn't supply them.
        // KinTale rendering is per-kin, so an empty kinIds list would make the report
        // show no per-pet checklist items.
        val kinIds = if (session.kinIds.isEmpty() && session.kinfolkId.isNotBlank()) {
            getKin(session.kinfolkId).getOrDefault(emptyList())
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

    suspend fun updateKinCareSession(session: KinCareSession): Result<Unit> = runCatching {
        ensureAuthenticated()
        firestore.collection("kin_care_sessions").document(session.id)
            .set(session.copy(updatedAt = getCurrentTimestamp()))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update kin care session ${session.id}", it) }

    suspend fun getKinCareSessionsForDay(dayStartIso: String, dayEndIso: String): Result<List<KinCareSession>> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val snapshot = firestore.collection("kin_care_sessions")
            .scopedByKinfolk(mode)
            .whereGreaterThanOrEqualTo("startTime", dayStartIso)
            .whereLessThan("startTime", dayEndIso)
            .orderBy("startTime")
            .get()
            .await()
        snapshot.toObjects(KinCareSession::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care sessions for day", it) }

    // --- Visit lifecycle transitions ---

    private suspend fun patchSession(sessionId: String, updates: Map<String, Any>): Result<Unit> = runCatching {
        ensureAuthenticated()
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

    // --- Kin Care Reports (KinTales) ---

    suspend fun createKinCareReport(report: KinCareReport): Result<String> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val report = if (mode.active) report.copy(kinfolkId = mode.scopedKinfolkId(report.kinfolkId)) else report
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

    suspend fun updateKinCareReport(report: KinCareReport): Result<Unit> = runCatching {
        ensureAuthenticated()
        firestore.collection("kin_care_reports").document(report.id)
            .set(report.copy(updatedAt = getCurrentTimestamp()))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update kin care report ${report.id}", it) }

    suspend fun markReportSent(reportId: String, sessionId: String, sentVia: String, deliveryReceiptId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
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

    suspend fun getReportsForSession(sessionId: String): Result<List<KinCareReport>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("kin_care_reports")
            .whereEqualTo("sessionId", sessionId)
            .orderBy("createdAt")
            .get()
            .await()
        snapshot.toObjects(KinCareReport::class.java)
    }.onFailure { AuntieLog.e("Failed to get reports for session $sessionId", it) }

    suspend fun getDraftReports(): Result<List<KinCareReport>> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val snapshot = firestore.collection("kin_care_reports")
            .scopedByKinfolk(mode)
            .whereEqualTo("status", ReportStatus.DRAFT.name)
            .orderBy("updatedAt", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .get()
            .await()
        snapshot.toObjects(KinCareReport::class.java)
    }.onFailure { AuntieLog.e("Failed to get draft reports", it) }

    suspend fun getAllKinCareReports(): Result<List<KinCareReport>> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val snapshot = firestore.collection("kin_care_reports").scopedByKinfolk(mode).get().await()
        snapshot.toObjects(KinCareReport::class.java)
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
        ensureAuthenticated()
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
        ensureAuthenticated()
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
        ensureAuthenticated()
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

    // --- FCM Device Token ---

    /**
     * Register this device for push via the `registerFcmToken` callable, the same
     * path the MyTribe kinfolk app uses.
     *
     * This used to write `fcm_tokens/{uid}` directly, which was broken three ways
     * at once and silent about all of them:
     *  - firestore.rules declared `fcmTokens` (camelCase), a collection nothing
     *    uses, so the real one was default-deny and every save was rejected;
     *  - the document carried no `uid` field, while `pushChannel` and
     *    `broadcastMessage` both resolve devices with `.where('uid','==',...)`,
     *    so the device would have stayed invisible even once the rule was fixed;
     *  - it keyed the doc by uid, while the server keys by token, so the two
     *    writers disagreed and a second device would clobber the first.
     *
     * The callable owns all three (token as doc id, deduped, with `uid` stamped),
     * so the collection is now closed to clients entirely.
     */
    suspend fun saveDeviceToken(token: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        val payload = hashMapOf(
            "token" to token,
            "platform" to "android",
            "appVersion" to BuildConfig.VERSION_NAME,
        )
        functions.getHttpsCallable("registerFcmToken").call(payload).await()
        AuntieLog.i("FCM token registered via callable")
        Unit
    }.onFailure { AuntieLog.e("Failed to register FCM device token", it) }

    // --- Firestore streams for comms history (survives app restart) ---

    fun observeCalls(limit: Long = 200): Flow<List<CallLog>> = callbackFlow {
        if (!checkAuthOrCloseFlow("observeCalls")) return@callbackFlow
        val reg = firestore.collection("calls_log")
            .orderBy("timestamp", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .limit(limit)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    close(error)
                    return@addSnapshotListener
                }
                trySend(snapshot?.toObjects(CallLog::class.java).orEmpty())
            }
        awaitClose { reg.remove() }
    }

    fun observeVoicemails(limit: Long = 200): Flow<List<VoicemailLog>> = callbackFlow {
        if (!checkAuthOrCloseFlow("observeVoicemails")) return@callbackFlow
        val reg = firestore.collection("voicemails")
            .orderBy("timestamp", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .limit(limit)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    close(error)
                    return@addSnapshotListener
                }
                trySend(snapshot?.toObjects(VoicemailLog::class.java).orEmpty())
            }
        awaitClose { reg.remove() }
    }

    fun observeSmsMessages(limit: Long = 300): Flow<List<SmsMessage>> = callbackFlow {
        if (!checkAuthOrCloseFlow("observeSmsMessages")) return@callbackFlow
        val reg = firestore.collection("sms_messages")
            .orderBy("timestamp", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .limit(limit)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    close(error)
                    return@addSnapshotListener
                }
                trySend(snapshot?.toObjects(SmsMessage::class.java).orEmpty())
            }
        awaitClose { reg.remove() }
    }

    /**
     * Defense-in-depth auth gate for callbackFlow-based listeners.
     * Returns true (listener may attach) when a user is signed in.
     * Returns false and closes the flow with an error when unauthenticated —
     * so callers see an immediate failure instead of silently attaching an
     * unauthenticated Firestore listener. Server rules are the authoritative
     * gate; this is a client-side short-circuit for fast failure.
     */
    private fun ProducerScope<*>.checkAuthOrCloseFlow(caller: String): Boolean {
        if (auth.currentUser != null) return true
        val err = IllegalStateException("$caller: no authenticated user — admin sign-in required")
        AuntieLog.e("$caller: attaching Firestore listener without auth", err)
        close(err)
        return false
    }

    // --- Comms log writes used by notifications/inbox actions ---

    suspend fun upsertInboundCallLog(
        callSid: String,
        callerNumber: String,
        transcript: String,
        popupUrl: String = ""
    ): Result<String> = runCatching {
        ensureAuthenticated()
        val id = callSid.ifBlank { UUID.randomUUID().toString() }
        val doc = firestore.collection("calls_log").document(id)
        val existing = doc.get().await().toObject(CallLog::class.java)
        val now = getCurrentTimestamp()
        val call = (existing ?: CallLog()).copy(
            id = id,
            counterpartNumber = callerNumber,
            direction = "inbound",
            status = existing?.status?.takeIf { it.isNotBlank() } ?: "ringing",
            transcript = transcript,
            recordingUrl = popupUrl,
            timestamp = existing?.timestamp?.takeIf { it.isNotBlank() } ?: now,
            twilioCallSid = callSid
        )
        doc.set(call).await()
        id
    }.onFailure { AuntieLog.e("Failed to upsert inbound call", it) }

    suspend fun createInboundVoicemailLog(
        callerNumber: String,
        transcript: String,
        audioUrl: String
    ): Result<String> = runCatching {
        ensureAuthenticated()
        val docRef = firestore.collection("voicemails").document()
        val log = VoicemailLog(
            id = docRef.id,
            callerNumber = callerNumber,
            transcript = transcript,
            audioUrl = audioUrl,
            direction = "inbound",
            timestamp = getCurrentTimestamp(),
            replyStatus = "unread"
        )
        docRef.set(log).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to create inbound voicemail", it) }

    suspend fun createInboundSmsLog(from: String, body: String): Result<String> = runCatching {
        ensureAuthenticated()
        val docRef = firestore.collection("sms_messages").document()
        val msg = SmsMessage(
            id = docRef.id,
            counterpartNumber = from,
            direction = "inbound",
            subType = "sms",
            body = body,
            timestamp = getCurrentTimestamp(),
            status = "received"
        )
        docRef.set(msg).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to create inbound SMS", it) }

    suspend fun markVoicemailReplied(voicemailId: String, replyLogId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        firestore.collection("voicemails").document(voicemailId).update(
            mapOf(
                "replyStatus" to "replied",
                "repliedAt" to getCurrentTimestamp(),
                "replyLogId" to replyLogId
            )
        ).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to mark voicemail replied $voicemailId", it) }

    // --- Comms log reads (one collection per channel; consumed by InboxScreen) ---

    suspend fun getVoicemails(): Result<List<VoicemailLog>> = runCatching {
        ensureAuthenticated()
        firestore.collection("voicemails").get().await()
            .toObjects(VoicemailLog::class.java)
    }.onFailure { AuntieLog.e("Failed to get voicemails", it) }

    suspend fun getCalls(): Result<List<CallLog>> = runCatching {
        ensureAuthenticated()
        firestore.collection("calls_log").get().await()
            .toObjects(CallLog::class.java)
    }.onFailure { AuntieLog.e("Failed to get calls", it) }

    suspend fun getSmsMessages(): Result<List<SmsMessage>> = runCatching {
        ensureAuthenticated()
        firestore.collection("sms_messages").get().await()
            .toObjects(SmsMessage::class.java)
    }.onFailure { AuntieLog.e("Failed to get SMS messages", it) }

    suspend fun getEmails(): Result<List<EmailMessage>> = runCatching {
        ensureAuthenticated()
        firestore.collection("emails").get().await()
            .toObjects(EmailMessage::class.java)
    }.onFailure { AuntieLog.e("Failed to get emails", it) }

    /**
     * Patches a single Kin Care session with the given fields. Used by Auntie
     * Time row buttons to flip status + drop the matching lifecycle timestamp
     * in one round-trip. Pass empty-string to clear a field (e.g. Undo Arrived).
     */
    suspend fun patchKinCareSession(id: String, patch: Map<String, Any>): Result<Unit> = runCatching {
        ensureAuthenticated()
        firestore.collection("kin_care_sessions").document(id).update(patch).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to patch KinCareSession $id", it) }

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
        ensureAuthenticated()
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
        ensureAuthenticated()
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
        ensureAuthenticated()
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
        ensureAuthenticated()
        val raw = functions.getHttpsCallable("listStaff")
            .call(emptyMap<String, Any?>())
            .await()
            .data as? Map<*, *>
        decodeListStaff(raw)
    }.onFailure { AuntieLog.e("Failed to list staff", it) }

    // --- Activity log (audit trail) ---

    suspend fun getActivityLog(): Result<List<com.tribetails.auntieos.data.admin.ActivityLogEntry>> = runCatching {
        ensureAuthenticated()
        // WARNING-10: bound the read to the 100 most recent entries ordered by seq
        // (the hash-chain sequence number written by writeAuditEntry). Chain integrity
        // is verified server-side via verifyActivityLogChain; the client only needs the
        // recent tail for display. Older entries remain in Firestore untouched.
        firestore.collection("activity_log")
            .orderBy("seq", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .limit(100)
            .get().await()
            .toObjects(com.tribetails.auntieos.data.admin.ActivityLogEntry::class.java)
    }.onFailure { AuntieLog.e("Failed to get activity log", it) }

    /**
     * Catalog-dispatched notifications for the signed-in operator. Firestore
     * rules scope reads to recipientUid == auth.uid; this helper filters
     * server-side so we don't pull other admins' dispatches.
     */
    suspend fun getNotifications(): Result<List<com.tribetails.auntieos.data.admin.NotificationEntry>> = runCatching {
        ensureAuthenticated()
        val uid = auth.currentUser?.uid
            ?: throw IllegalStateException("getNotifications called without auth uid")
        firestore.collection("notifications")
            .whereEqualTo("recipientUid", uid)
            .get().await()
            .toObjects(com.tribetails.auntieos.data.admin.NotificationEntry::class.java)
            // Step 4: archived notifications are hidden from the default inbox. The
            // dispatcher writes no archivedAt, so absence => active. Filtered client
            // side (a where-clause would require a composite index for the common case).
            .filter { it.archivedAt.isNullOrBlank() }
    }.onFailure { AuntieLog.e("Failed to get notifications", it) }

    suspend fun getKinCareReport(reportId: String): Result<KinCareReport?> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("kin_care_reports").document(reportId).get().await()
        snapshot.toObject(KinCareReport::class.java)
    }.onFailure { AuntieLog.e("Failed to get kin care report $reportId", it) }

    // --- KinTale Templates ---

    suspend fun getKinTaleTemplates(): Result<List<KinTaleTemplate>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("kintale_templates").get().await()
        snapshot.toObjects(KinTaleTemplate::class.java)
    }.onFailure { AuntieLog.e("Failed to get KinTale templates", it) }

    suspend fun getKinTaleTemplate(templateId: String): Result<KinTaleTemplate?> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("kintale_templates").document(templateId).get().await()
        snapshot.toObject(KinTaleTemplate::class.java)
    }.onFailure { AuntieLog.e("Failed to get KinTale template $templateId", it) }

    suspend fun createKinTaleTemplate(template: KinTaleTemplate): Result<String> = runCatching {
        ensureAuthenticated()
        val docRef = firestore.collection("kintale_templates").document()
        val ts = getCurrentTimestamp()
        docRef.set(template.copy(id = docRef.id, createdAt = ts, updatedAt = ts)).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to create KinTale template", it) }

    suspend fun updateKinTaleTemplate(template: KinTaleTemplate): Result<Unit> = runCatching {
        ensureAuthenticated()
        firestore.collection("kintale_templates").document(template.id)
            .set(template.copy(updatedAt = getCurrentTimestamp()))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update KinTale template ${template.id}", it) }

    suspend fun deleteKinTaleTemplate(templateId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        firestore.collection("kintale_templates").document(templateId).delete().await()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete KinTale template $templateId", it) }

    /** Pick the best template for a service type. Falls back to the default template if no match. */
    suspend fun getActiveTemplateForService(serviceType: String): Result<KinTaleTemplate?> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("kintale_templates")
            .whereEqualTo("isActive", true)
            .get().await()
        val templates = snapshot.toObjects(KinTaleTemplate::class.java)
        val needle = serviceType.lowercase().trim()
        val match = templates.firstOrNull { tpl ->
            tpl.serviceTypeKeys.any { it.lowercase().trim() == needle }
        }
        match ?: templates.firstOrNull { it.isDefault }
    }.onFailure { AuntieLog.e("Failed to resolve KinTale template for service $serviceType", it) }

    private fun FirebaseUser.toSessionUser(): SessionUser = SessionUser(
        uid = uid,
        email = email,
    )

    // ---- Session GPS summary (parity w/ AuntieOS web) ----
    suspend fun saveSessionGpsSummary(sessionId: String, summary: GpsSummary): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(sessionId.isNotBlank()) { "sessionId required" }
        firestore.collection("kin_care_sessions").document(sessionId)
            .set(mapOf("gpsSummary" to summary), com.google.firebase.firestore.SetOptions.merge())
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to save session gpsSummary $sessionId", it) }

    // ---- User profile (single doc per Firebase Auth uid in `users` collection) ----

    fun observeUserProfile(uid: String): Flow<UserProfile?> = callbackFlow {
        if (uid.isBlank()) {
            trySend(null); awaitClose { }; return@callbackFlow
        }
        val reg = firestore.collection("users").document(uid)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    AuntieLog.e("observeUserProfile($uid) failed", err)
                    trySend(null)
                    return@addSnapshotListener
                }
                trySend(snap?.toObject(UserProfile::class.java))
            }
        awaitClose { reg.remove() }
    }

    /**
     * One-shot fetch of the signed-in admin's UserProfile (users/{uid}). Used by
     * the booking-envelope write-back to stamp auntieDisplayName/auntieAvatarUrl
     * onto the kinCare doc. Returns null inside a successful Result when the
     * profile doc doesn't exist yet.
     */
    suspend fun getCurrentUserProfile(): Result<UserProfile?> = runCatching {
        ensureAuthenticated()
        val uid = auth.currentUser?.uid
            ?: throw IllegalStateException("getCurrentUserProfile called without auth uid")
        firestore.collection("users").document(uid).get().await()
            .toObject(UserProfile::class.java)
    }.onFailure { AuntieLog.e("Failed to get current user profile", it) }

    // ---- Vet clinics shared catalog (matches web `vet_clinics` collection) ----

    fun observeVetClinics(): Flow<List<VetClinic>> = callbackFlow {
        val reg = firestore.collection("vet_clinics")
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    AuntieLog.e("observeVetClinics failed", err)
                    trySend(emptyList())
                    return@addSnapshotListener
                }
                trySend(snap?.toObjects(VetClinic::class.java).orEmpty())
            }
        awaitClose { reg.remove() }
    }

    suspend fun createVetClinic(clinic: VetClinic): Result<String> = runCatching {
        ensureAuthenticated()
        val ts = getCurrentTimestamp()
        val ref = firestore.collection("vet_clinics").document()
        val toWrite = clinic.copy(id = ref.id, createdAt = ts, updatedAt = ts)
        ref.set(toWrite).await()
        ref.id
    }.onFailure { AuntieLog.e("Failed to create vet clinic", it) }

    /**
     * Walk the activity_log SHA-256 hash chain server-side via the deployed
     * `verifyActivityLogChain` admin callable and return the integrity verdict
     * (parity with web FirestoreClient.verifyActivityLogChain). Result `.data` is
     * a Map; numbers may arrive as Int/Long/Double, so reads go through Number.
     */
    suspend fun verifyActivityLogChain(): Result<com.tribetails.auntieos.data.admin.ChainVerifyResult> = runCatching {
        ensureAuthenticated()
        val res = functions.getHttpsCallable("verifyActivityLogChain").call(emptyMap<String, Any?>()).await()
        @Suppress("UNCHECKED_CAST")
        val data = res.data as? Map<String, Any?> ?: emptyMap()
        val anomaly = data["anomaly"] as? Map<*, *>
        fun intOrNull(v: Any?): Int? = (v as? Number)?.toInt()
        com.tribetails.auntieos.data.admin.ChainVerifyResult(
            ok = data["ok"] as? Boolean ?: false,
            scanned = intOrNull(data["scanned"]) ?: 0,
            firstSeq = intOrNull(data["firstSeq"]),
            lastSeq = intOrNull(data["lastSeq"]),
            unchainedCount = intOrNull(data["unchainedCount"]) ?: 0,
            anomalyCode = anomaly?.get("code") as? String,
            anomalySeq = intOrNull(anomaly?.get("seq")),
        )
    }.onFailure { AuntieLog.e("verifyActivityLogChain failed", it) }

    /** Update an existing vet-clinic doc (parity with web updateVetClinic). */
    suspend fun updateVetClinic(clinic: VetClinic): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(clinic.id.isNotBlank()) { "VetClinic.id is required to update." }
        val ts = getCurrentTimestamp()
        val toWrite = clinic.copy(updatedAt = ts, createdAt = clinic.createdAt.ifBlank { ts })
        firestore.collection("vet_clinics").document(clinic.id).set(toWrite).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update vet clinic", it) }

    /** Hard-delete a vet-clinic doc (parity with web deleteVetClinic). */
    suspend fun deleteVetClinic(id: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(id.isNotBlank()) { "VetClinic id is required to delete." }
        firestore.collection("vet_clinics").document(id).delete().await()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete vet clinic", it) }

    suspend fun saveUserProfile(profile: UserProfile): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(profile.uid.isNotBlank()) { "UserProfile.uid is required to save." }
        val ts = getCurrentTimestamp()
        val toWrite = profile.copy(
            id = profile.uid,
            updatedAt = ts,
            createdAt = profile.createdAt.ifBlank { ts },
        )
        firestore.collection("users").document(profile.uid)
            .set(toWrite)
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to save user profile ${profile.uid}", it) }

    // ───────────────────────────────────────────────────────────────────────
    // FormSchemas - admin authoring surface for kinfolk-facing dynamic forms.
    // Backed by `saveFormSchema | listFormSchemas | deleteFormSchema` callables
    // and the `formSchemas/{schemaId}` Firestore collection. Server gates auth
    // via `isAuntieOperator`; client validation lives in FormSchemaValidator.
    // ───────────────────────────────────────────────────────────────────────

    suspend fun listFormSchemas(): Result<List<FormSchemaSummary>> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listFormSchemas")
            .call(emptyMap<String, Any>())
            .await().data as? Map<String, Any?>
            ?: error("listFormSchemas: non-map payload")
        val list = (raw["schemas"] as? List<*>).orEmpty()
        list.mapNotNull { item ->
            val m = item as? Map<*, *> ?: return@mapNotNull null
            FormSchemaSummary(
                id        = m["id"] as? String ?: return@mapNotNull null,
                name      = m["name"] as? String ?: "",
                appliesTo = (m["appliesTo"] as? String)?.ifBlank { null } ?: FormSchemaAppliesTo.NONE,
                version   = (m["version"] as? Number)?.toInt() ?: 0,
                updatedAt = m["updatedAt"] as? String ?: "",
                updatedBy = m["updatedBy"] as? String ?: "",
            )
        }
    }.onFailure { AuntieLog.e("Failed to list form schemas", it) }

    // ───────────────────────────────────────────────────────────────────────
    // Feature flags (0D-android). Shares the central `business_settings/feature_flags`
    // doc with web via the same `getFeatureFlags`/`setFeatureFlags` callables. setFeatureFlags
    // is admin-gated server-side. Response shape: { flags: { "<key>": <bool>, ... } }.
    // ───────────────────────────────────────────────────────────────────────

    suspend fun getFeatureFlags(): Result<Map<String, Boolean>> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getFeatureFlags")
            .call(emptyMap<String, Any>())
            .await().data as? Map<String, Any?>
            ?: error("getFeatureFlags: non-map payload")
        val flags = (raw["flags"] as? Map<*, *>).orEmpty()
        flags.entries.mapNotNull { (k, v) ->
            val key = k as? String ?: return@mapNotNull null
            val b = v as? Boolean ?: return@mapNotNull null
            key to b
        }.toMap()
    }.onFailure { AuntieLog.e("Failed to get feature flags", it) }

    suspend fun setFeatureFlags(flags: Map<String, Boolean>): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(flags.isNotEmpty()) { "setFeatureFlags: empty flag map" }
        functions.getHttpsCallable("setFeatureFlags")
            .call(mapOf("flags" to flags))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to set feature flags", it) }

    // ───────────────────────────────────────────────────────────────────────
    // Phase 15.2 - business notification overrides (type x channel matrix).
    // Shares the businessSettings/notifications doc + catalog with web via the
    // getBusinessNotificationOverrides / save / delete callables (admin-gated).
    // ───────────────────────────────────────────────────────────────────────

    suspend fun getBusinessNotificationOverrides(): Result<NotificationMatrix> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getBusinessNotificationOverrides")
            .call(emptyMap<String, Any>())
            .await().data as? Map<String, Any?>
            ?: error("getBusinessNotificationOverrides: non-map payload")
        // Parsing (incl. audiences + per-stream gates + lockReason) lives in pure,
        // unit-tested functions in NotificationMatrix.kt.
        val catalog = (raw["catalog"] as? List<*>).orEmpty().mapNotNull { item ->
            notificationCatalogEntryFromMap(item as? Map<*, *> ?: return@mapNotNull null)
        }
        val overrides = (raw["overrides"] as? Map<*, *>).orEmpty().entries.mapNotNull { (k, v) ->
            val key = k as? String ?: return@mapNotNull null
            val o = v as? Map<*, *> ?: return@mapNotNull null
            key to notificationOverrideFromMap(o)
        }.toMap()
        NotificationMatrix(
            catalog = catalog,
            overrides = overrides,
            updatedAtMs = (raw["updatedAtMs"] as? Number)?.toLong(),
        )
    }.onFailure { AuntieLog.e("Failed to load notification overrides", it) }

    suspend fun saveBusinessNotificationOverride(key: String, override: NotificationOverride): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(key.isNotBlank()) { "notification override key required" }
        // Serialization contract (only-true locks, per-stream gates, lockReason
        // empty-string-clears) lives in NotificationOverride.toCallablePayload().
        val payload = mapOf("key" to key, "override" to override.toCallablePayload())
        functions.getHttpsCallable("saveBusinessNotificationOverride").call(payload).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to save notification override", it) }

    suspend fun deleteBusinessNotificationOverride(key: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(key.isNotBlank()) { "notification override key required" }
        functions.getHttpsCallable("deleteBusinessNotificationOverride").call(mapOf("key" to key)).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete notification override", it) }

    // ───────────────────────────────────────────────────────────────────────
    // The ADMIN's OWN notification receive-prefs (staff/{uid}.notificationPrefs).
    // Mirrors the kinfolk portal prefs but for the operator; backs the admin
    // notification settings screen. getMyAdminNotificationPrefs /
    // saveMyAdminNotificationPrefs callables (admin-gated in MyTribe functions).
    // ───────────────────────────────────────────────────────────────────────

    suspend fun getMyAdminNotificationPrefs(): Result<AdminNotificationPrefs> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getMyAdminNotificationPrefs")
            .call(emptyMap<String, Any>())
            .await().data as? Map<String, Any?>
            ?: error("getMyAdminNotificationPrefs: non-map payload")
        val prefs = (raw["prefs"] as? Map<*, *>).orEmpty()
        AdminNotificationPrefs(
            byKey = parseChannelMaps(prefs["byKey"]),
            byCategory = parseChannelMaps(prefs["byCategory"]),
            marketingOptIn = (prefs["marketingOptIn"] as? Map<*, *>).orEmpty().entries.mapNotNull { (k, v) ->
                val kk = k as? String ?: return@mapNotNull null
                kk to (v as? Boolean ?: false)
            }.toMap(),
        )
    }.onFailure { AuntieLog.e("Failed to load admin notification prefs", it) }

    suspend fun saveMyAdminNotificationPrefs(prefs: AdminNotificationPrefs): Result<Unit> = runCatching {
        ensureAuthenticated()
        val prefsMap = buildMap<String, Any> {
            if (prefs.byKey.isNotEmpty()) put("byKey", prefs.byKey)
            if (prefs.byCategory.isNotEmpty()) put("byCategory", prefs.byCategory)
            if (prefs.marketingOptIn.isNotEmpty()) put("marketingOptIn", prefs.marketingOptIn)
        }
        functions.getHttpsCallable("saveMyAdminNotificationPrefs").call(mapOf("prefs" to prefsMap)).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to save admin notification prefs", it) }

    /** Parses a Firestore `{ key -> { email?, sms?, push? } }` map into typed Kotlin. */
    private fun parseChannelMaps(raw: Any?): Map<String, Map<String, Boolean>> =
        (raw as? Map<*, *>).orEmpty().entries.mapNotNull { (k, v) ->
            val key = k as? String ?: return@mapNotNull null
            val channels = (v as? Map<*, *>).orEmpty().entries.mapNotNull { (ck, cv) ->
                val cks = ck as? String ?: return@mapNotNull null
                val cvb = cv as? Boolean ?: return@mapNotNull null
                cks to cvb
            }.toMap()
            key to channels
        }.toMap()

    suspend fun getFormSchema(id: String): Result<FormSchema?> = runCatching {
        ensureAuthenticated()
        require(id.isNotBlank()) { "FormSchema id required" }
        val snap = firestore.collection("formSchemas").document(id).get().await()
        if (!snap.exists()) return@runCatching null
        val data = snap.data ?: return@runCatching null
        formSchemaFromMap(snap.id, data)
    }.onFailure { AuntieLog.e("Failed to get form schema $id", it) }

    suspend fun saveFormSchema(schema: FormSchema): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(schema.id.isNotBlank()) { "FormSchema.id required" }
        val payload = mapOf("schema" to formSchemaToMap(schema))
        functions.getHttpsCallable("saveFormSchema").call(payload).await()
        // Await the audit write - fire-and-forget on a detached CoroutineScope
        // would drop the entry if the app process is killed mid-flight (per
        // [[fail-loud-policy]] / reviewer finding). fireSync suspends until
        // the activity_log doc is committed before this function returns.
        com.tribetails.auntieos.data.admin.AuditLog.fireSync(
            repository       = this,
            actionType       = "SAVE_FORM_SCHEMA",
            description      = "Saved form schema ${schema.id}",
            targetId         = schema.id,
            targetCollection = "formSchemas",
        )
        Unit
    }.onFailure { AuntieLog.e("Failed to save form schema ${schema.id}", it) }

    suspend fun deleteFormSchema(id: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        require(id.isNotBlank()) { "FormSchema id required" }
        functions.getHttpsCallable("deleteFormSchema")
            .call(mapOf("id" to id))
            .await()
        // See comment on saveFormSchema: await the audit row so it doesn't drop
        // if the process is killed before the detached coroutine flushes.
        com.tribetails.auntieos.data.admin.AuditLog.fireSync(
            repository       = this,
            actionType       = "DELETE_FORM_SCHEMA",
            description      = "Deleted form schema $id",
            targetId         = id,
            targetCollection = "formSchemas",
        )
        Unit
    }.onFailure { AuntieLog.e("Failed to delete form schema $id", it) }

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
        ensureAuthenticated()
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

    // ---- Care-ops session callables (1E §A.9) + series approve/cancel (1G) ----

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
        ensureAuthenticated()
        val mode = requireTestMode()
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
        ensureAuthenticated()
        functions.getHttpsCallable("rescheduleBooking")
            .call(mapOf("sessionId" to sessionId, "startTime" to startTime, "endTime" to endTime))
            .await()
        Unit
    }.onFailure { AuntieLog.e("rescheduleBooking failed", it) }

    /**
     * Slice 7: server-bound "Set as profile photo". Flips MediaFile.isProfilePhoto
     * on the chosen media_files doc, clears it on siblings of the same entity, and
     * stamps the owning entity's photo URL field (kinfolk/kin.profilePictureUrl or
     * users/{uid}.photoUrl) in one atomic admin batch. The Cloud Function reads the
     * doc's own entity as the source of truth, so a cross-entity flip fails loud.
     */
    suspend fun setMediaProfilePhoto(
        mediaFileId: String,
        entityType: MediaEntityType,
        entityId: String,
    ): Result<Unit> = runCatching {
        ensureAuthenticated()
        functions.getHttpsCallable("setMediaProfilePhoto")
            .call(mapOf(
                "mediaFileId" to mediaFileId,
                "entityType" to entityType.name,
                "entityId" to entityId,
            ))
            .await()
        Unit
    }.onFailure { AuntieLog.e("setMediaProfilePhoto failed for $mediaFileId", it) }

    /** 1G: approve/cancel a whole booking series (parent envelope + all child
     *  visits). Returns the full [ManageSeriesResult] so the caller can fail loud
     *  on a partial failure (failedVisits > 0). A response missing the
     *  affectedVisits field is an error, not a silent 0. */
    suspend fun manageBookingSeries(action: String, kinfolkId: String, batchId: String): Result<ManageSeriesResult> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("manageBookingSeries")
            .call(mapOf("action" to action, "kinfolkId" to kinfolkId, "batchId" to batchId))
            .await().data as? Map<String, Any?> ?: error("manageBookingSeries: non-map payload")
        val affected = (raw["affectedVisits"] as? Number)?.toInt()
            ?: error("manageBookingSeries: response missing affectedVisits")
        ManageSeriesResult(
            affectedVisits = affected,
            failedVisits = (raw["failedVisits"] as? Number)?.toInt() ?: 0,
            sessionsCreated = (raw["sessionsCreated"] as? Number)?.toInt() ?: 0,
        )
    }.onFailure { AuntieLog.e("manageBookingSeries failed", it) }

    private fun formSchemaToMap(schema: FormSchema): Map<String, Any?> = mapOf(
        "id"          to schema.id,
        "name"        to schema.name,
        "description" to schema.description,
        "appliesTo"   to schema.appliesTo,
        "version"     to schema.version,
        "sections"    to schema.sections.map { section ->
            mapOf(
                "title"       to section.title,
                "description" to section.description,
                "fields"      to section.fields.map { field ->
                    mapOf(
                        "key"          to field.key,
                        "label"        to field.label,
                        "type"         to field.type,
                        "required"     to field.required,
                        "helperText"   to field.helperText,
                        "placeholder"  to field.placeholder,
                        "options"      to field.options,
                        "defaultValue" to field.defaultValue,
                        "group"        to field.group,
                    )
                },
            )
        },
    )

    private fun formSchemaFromMap(id: String, m: Map<String, Any?>): FormSchema {
        val sectionsRaw = (m["sections"] as? List<*>).orEmpty()
        val sections = sectionsRaw.mapNotNull { item ->
            val s = item as? Map<*, *> ?: return@mapNotNull null
            val fieldsRaw = (s["fields"] as? List<*>).orEmpty()
            FormSchemaSection(
                title       = s["title"] as? String ?: "",
                description = s["description"] as? String,
                fields      = fieldsRaw.mapNotNull { fi ->
                    val f = fi as? Map<*, *> ?: return@mapNotNull null
                    @Suppress("UNCHECKED_CAST")
                    val opts = (f["options"] as? List<*>)?.mapNotNull { it as? String }
                    FormSchemaField(
                        key          = f["key"] as? String ?: "",
                        label        = f["label"] as? String ?: "",
                        type         = f["type"] as? String ?: FormSchemaFieldType.TEXT.wire,
                        required     = f["required"] as? Boolean ?: false,
                        helperText   = f["helperText"] as? String,
                        placeholder  = f["placeholder"] as? String,
                        options      = opts,
                        defaultValue = f["defaultValue"] as? String,
                        group        = f["group"] as? String,
                    )
                },
            )
        }
        return FormSchema(
            id          = id,
            name        = m["name"] as? String ?: "",
            description = m["description"] as? String ?: "",
            appliesTo   = (m["appliesTo"] as? String)?.ifBlank { null } ?: FormSchemaAppliesTo.NONE,
            version     = (m["version"] as? Number)?.toInt() ?: 0,
            sections    = sections,
            createdAt   = m["createdAt"] as? String ?: "",
            updatedAt   = m["updatedAt"] as? String ?: "",
            updatedBy   = m["updatedBy"] as? String ?: "",
        )
    }

    // ── Phase 1: Communicate recipient-context comms reads ────────────────────

    /**
     * Recent comms for a kinfolk across all four channels: SMS, email, calls, voicemails.
     * Four concurrent one-shot Firestore reads, each limited to [perCollectionLimit] docs
     * ordered server-side by natural insertion order (no composite index needed for simple
     * whereEqualTo+limit). Fail-loud: any error from any channel surfaces through Result.
     */
    suspend fun recentCommsForKinfolk(
        kinfolkId: String,
        perCollectionLimit: Long = 25,
    ): Result<RecentComms> = runCatching {
        AuntieLog.d("Fetching recent comms for kinfolk: $kinfolkId")
        ensureAuthenticated()
        coroutineScope {
            val smsDeferred = async {
                firestore.collection("sms_messages")
                    .whereEqualTo("kinfolkId", kinfolkId)
                    .limit(perCollectionLimit)
                    .get().await()
                    .toObjects(SmsMessage::class.java)
            }
            val emailsDeferred = async {
                firestore.collection("emails")
                    .whereEqualTo("kinfolkId", kinfolkId)
                    .limit(perCollectionLimit)
                    .get().await()
                    .toObjects(EmailMessage::class.java)
            }
            val callsDeferred = async {
                firestore.collection("calls_log")
                    .whereEqualTo("kinfolkId", kinfolkId)
                    .limit(perCollectionLimit)
                    .get().await()
                    .toObjects(CallLog::class.java)
            }
            val voicemailsDeferred = async {
                firestore.collection("voicemails")
                    .whereEqualTo("kinfolkId", kinfolkId)
                    .limit(perCollectionLimit)
                    .get().await()
                    .toObjects(VoicemailLog::class.java)
            }
            RecentComms(
                sms        = smsDeferred.await(),
                emails     = emailsDeferred.await(),
                calls      = callsDeferred.await(),
                voicemails = voicemailsDeferred.await(),
            )
        }
    }.onFailure { AuntieLog.e("recentCommsForKinfolk failed for $kinfolkId", it) }

    /**
     * AI-generated recap of the most recent communications for a kinfolk, via the
     * admin-gated `recap_recent_comms` callable. Returns a [CommsRecap] with a short
     * prose summary, the ISO-8601 timestamp of the most recent source, and the number
     * of source documents considered. Fail-loud: errors surface through Result.
     */
    suspend fun recapRecentComms(kinfolkId: String): Result<CommsRecap> = runCatching {
        AuntieLog.i("Recapping recent comms for kinfolk: $kinfolkId")
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("recap_recent_comms")
            .call(mapOf("kinfolkId" to kinfolkId))
            .await().data as? Map<*, *>
        decodeCommsRecap(raw)
    }.onFailure { AuntieLog.e("recapRecentComms failed for $kinfolkId", it) }
}

// ── Phase 1: Communicate recipient-context data classes ──────────────────────────

/**
 * Recent communications for a single kinfolk fetched concurrently from all four
 * Firestore comms collections. Produced by [AuntieRepository.recentCommsForKinfolk].
 */
data class RecentComms(
    val sms: List<SmsMessage> = emptyList(),
    val emails: List<EmailMessage> = emptyList(),
    val calls: List<CallLog> = emptyList(),
    val voicemails: List<VoicemailLog> = emptyList(),
)

/**
 * AI-generated recap of recent communications for a kinfolk, returned by the
 * `recap_recent_comms` callable and decoded by [decodeCommsRecap].
 */
data class CommsRecap(
    val recap: String = "",        // short prose summary from the AI
    val lastAt: String = "",       // ISO-8601 timestamp of the most recent source doc
    val sourceCount: Int = 0,      // number of comms docs considered
)

/**
 * Pure decode of the `recap_recent_comms` callable payload into [CommsRecap].
 * Tolerant of a missing/short payload — all fields default to safe empty values.
 * Pure; unit-tested.
 */
internal fun decodeCommsRecap(raw: Map<*, *>?): CommsRecap = CommsRecap(
    recap       = (raw?.get("recap") as? String).orEmpty(),
    lastAt      = (raw?.get("lastAt") as? String).orEmpty(),
    sourceCount = (raw?.get("sourceCount") as? Number)?.toInt() ?: 0,
)

// ── Stage-2-tail callable decode helpers + result model (pure; unit-tested) ──────

/**
 * Result of the batchUpdateBookings callable: the applied action, how many visits
 * were updated, and the per-id failures. Mirrors the web BatchBookingResult so the
 * updated/failed summary reads identically across platforms.
 */
data class BatchBookingResult(
    val action: String,
    val updated: Int,
    val failed: List<BatchBookingFailure>,
) {
    val failedCount: Int get() = failed.size
}

data class BatchBookingFailure(val id: String, val error: String)

// ── Communicate external-send callable decode helpers + result models (pure; unit-tested) ──

/**
 * Result of the sendExternalMessage callable: the channel actually sent on, the
 * provider message id, and the server-REDACTED recipient (e.g. `j***@example.com`
 * or `+1******7890`). The plaintext recipient is never echoed back.
 */
data class ExternalSendResult(
    val channel: String,
    val providerMessageId: String,
    val recipientRedacted: String,
)

/** Result of the suppressExternalRecipient callable: channel + server-REDACTED recipient. */
data class ExternalSuppressResult(
    val channel: String,
    val recipientRedacted: String,
)

/**
 * Pure decode of the sendExternalMessage callable payload into [ExternalSendResult].
 * The echoed channel falls back to the requested [requestedChannel]; the provider id
 * and redacted recipient default to empty when the server omits them (the call still
 * succeeded). Pure; unit-tested.
 */
internal fun decodeExternalSendResult(raw: Map<String, Any?>?, requestedChannel: String): ExternalSendResult {
    val channel = (raw?.get("channel") as? String)?.ifBlank { requestedChannel } ?: requestedChannel
    val providerMessageId = (raw?.get("providerMessageId") as? String).orEmpty()
    val recipientRedacted = (raw?.get("recipientRedacted") as? String).orEmpty()
    return ExternalSendResult(
        channel = channel,
        providerMessageId = providerMessageId,
        recipientRedacted = recipientRedacted,
    )
}

/**
 * Pure decode of the suppressExternalRecipient callable payload into
 * [ExternalSuppressResult]. Echoed channel falls back to [requestedChannel]; the
 * redacted recipient defaults to empty when omitted. Pure; unit-tested.
 */
internal fun decodeExternalSuppressResult(raw: Map<String, Any?>?, requestedChannel: String): ExternalSuppressResult {
    val channel = (raw?.get("channel") as? String)?.ifBlank { requestedChannel } ?: requestedChannel
    val recipientRedacted = (raw?.get("recipientRedacted") as? String).orEmpty()
    return ExternalSuppressResult(channel = channel, recipientRedacted = recipientRedacted)
}

/**
 * Pure decode of the sendInvoiceReminder callable payload to the echoed invoiceId,
 * falling back to the requested id when the server omits it. Pure; unit-tested.
 */
internal fun decodeSentReminderInvoiceId(raw: Map<String, Any?>?, requested: String): String =
    (raw?.get("invoiceId") as? String)?.ifBlank { requested } ?: requested

/** Pure decode of the bulkMarkNotificationsRead callable's "marked" count. Pure; unit-tested. */
internal fun decodeMarkedCount(raw: Map<String, Any?>?): Int =
    (raw?.get("marked") as? Number)?.toInt() ?: 0

/**
 * Pure decode of the archiveNotification / bulkArchiveNotifications callable's
 * "archived" count. Tolerant of a missing/short payload (defaults to 0). Pure; unit-tested.
 */
internal fun decodeArchivedCount(raw: Map<String, Any?>?): Int =
    (raw?.get("archived") as? Number)?.toInt() ?: 0

/**
 * Pure decode of the batchUpdateBookings callable payload into [BatchBookingResult].
 * Tolerant of a missing/short payload: updated defaults to 0 and failed to empty,
 * and the echoed action falls back to the requested [requestedAction]. Pure; unit-tested.
 */
internal fun decodeBatchBookingResult(raw: Map<String, Any?>?, requestedAction: String): BatchBookingResult {
    val action = (raw?.get("action") as? String)?.ifBlank { requestedAction } ?: requestedAction
    val updated = (raw?.get("updated") as? Number)?.toInt() ?: 0
    val failed = (raw?.get("failed") as? List<*>).orEmpty().mapNotNull { item ->
        val m = item as? Map<*, *> ?: return@mapNotNull null
        val id = m["id"] as? String ?: return@mapNotNull null
        BatchBookingFailure(id = id, error = m["error"] as? String ?: "")
    }
    return BatchBookingResult(action = action, updated = updated, failed = failed)
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

