package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.BuildConfig
import com.tribetails.auntieos.data.contracts.BatchUpdateBookingsArgs
import com.tribetails.auntieos.data.contracts.ManageBookingSeriesArgs
import com.tribetails.auntieos.data.contracts.decodeBatchUpdateBookingsResult
import com.tribetails.auntieos.data.contracts.decodeManageBookingSeriesResult
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
import com.tribetails.auntieos.domain.hasBlankKinfolkId
import com.tribetails.auntieos.domain.kinfolkScopeFilter
import com.tribetails.auntieos.domain.scopedKinfolkId
import com.tribetails.auntieos.ui.admin.scheduling.CalendarSyncRun
import com.tribetails.auntieos.ui.admin.scheduling.calendarSyncRunFrom
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.voice.VoiceAccessToken
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.util.*

class AuntieRepository(
    private val n8n: N8nApi,
    /**
     * W4-2: the shared sign-in gate and `testTribeId` claim source, no longer
     * this file's to own. Defaults to [AuthGate.shared] so the god-file and every
     * carved domain repo read the claim through ONE cache; a rebuilt repository
     * (base-url change) keeps that cache rather than silently dropping it.
     * `internal` so a test can assert the single-instance wiring, which is the
     * whole invariant; the gate itself is public either way.
     */
    internal val authGate: AuthGate = AuthGate.shared,
    /**
     * Test seam only. Production call sites never pass this, so `functions`
     * below still resolves `FirebaseFunctions.getInstance(...)` lazily on
     * first callable use, same as before. A test supplies a mocked
     * [FirebaseFunctions] here to exercise a real repository method (e.g.
     * [batchUpdateBookings]) without Firebase's static init, the same seam
     * [BookingRepository] and [KinCareRepository] already take as a
     * constructor param.
     */
    functionsOverride: FirebaseFunctions? = null,
    /**
     * Test seam only, the same shape [KinCareRepository], [InvoiceRepository]
     * and [KinTaleCommentsRepository] already take. Production call sites pass
     * nothing, so `firestore` below still resolves
     * `FirebaseFirestore.getInstance()` lazily on first use.
     */
    firestoreProvider: () -> FirebaseFirestore = { FirebaseFirestore.getInstance() },
    /**
     * Test seam only, the same lazy-provider shape [AuthGate] already takes.
     * Production call sites pass nothing, so `auth` below still resolves
     * `FirebaseAuth.getInstance()` lazily on first use. A sign-in test passes
     * the SAME mocked [FirebaseAuth] here and to its [AuthGate], because the
     * thing worth testing about a session ending is that the Firebase sign-out
     * and the claim cache move together.
     */
    authProvider: () -> FirebaseAuth = { FirebaseAuth.getInstance() },
) {
    private val firestore by lazy(firestoreProvider)
    private val storage by lazy { FirebaseStorage.getInstance() }
    private val auth by lazy(authProvider)
    private val functions by lazy { functionsOverride ?: FirebaseFunctions.getInstance("us-central1") }
    private val authMutex = Mutex()

    data class SessionUser(
        val uid: String,
        val email: String?,
    )

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
                endSession()
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
        endSession()
        Unit
    }.onFailure { AuntieLog.e("Sign-out failed", it) }

    /**
     * How a session ends here, whatever ended it: the operator tapping Sign out,
     * or [signInAdmin] refusing an account that turned out not to be an admin.
     * Both of those really do sign a Firebase user out, so both owe the same
     * teardown.
     *
     * The two steps are one step. Signing out of Firebase while leaving the
     * [AuthGate] claim cache populated keeps the finished session's
     * `testTribeId` live for whoever signs in next, and a sandbox scope is what
     * decides which business's records a query is allowed to see. The refusal
     * path used to call `auth.signOut()` directly and skip the cache, which is
     * precisely that leak.
     *
     * The pair now lives in [endLocalSession] rather than here, because #573
     * added a THIRD way for a session to end — the backend refusing a callable
     * from a revoked or disabled account — and that path reaches no repository.
     * Two copies of a two-step teardown is how the leak above came back.
     */
    private fun endSession() = endLocalSession(auth, authGate)

    suspend fun currentAdminIdToken(forceRefresh: Boolean = false): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        val user = auth.currentUser ?: error("Admin sign-in required before requesting an ID token.")
        val token = user.getIdToken(forceRefresh).await().token
        if (token.isNullOrBlank()) error("No Firebase ID token available.")
        token
    }.onFailure { AuntieLog.e("Failed to fetch Firebase ID token", it) }

    /** Reads custom claim `admin` from current user's ID token. Forces refresh so server-side
     *  changes (e.g. setAdminClaim Cloud Function) are picked up without app restart. */
    suspend fun isCurrentUserAdmin(): Result<Boolean> = runCatching {
        authGate.ensureAuthenticated()
        val token = auth.currentUser?.getIdToken(true)?.await()
        val isAdmin = token?.claims?.get("admin") == true
        AuntieLog.d("isCurrentUserAdmin uid=${auth.currentUser?.uid} → $isAdmin")
        isAdmin
    }.onFailure { AuntieLog.e("Failed to read admin claim", it) }

    /** Defense-in-depth: forces an ID-token refresh and throws if the admin
     *  claim is missing. Use before any destructive admin action so that
     *  client-side state can't be tampered to bypass Firestore rules. */
    private suspend fun requireAdminClaim() {
        authGate.ensureAuthenticated()
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

    /**
     * Reads the `testTribeId` custom claim and returns [TestMode]. W4-2: the read
     * and its cache moved to [AuthGate], so this is now a pass-through kept for
     * the screens that already ask the repository (Navigation, the scheduling
     * ViewModels). Moving those callers onto the gate is the Auth domain carve,
     * not this PR.
     */
    suspend fun getTestMode(forceRefresh: Boolean = false): Result<TestMode> =
        authGate.testMode(forceRefresh)

    /**
     * True iff a Stage-0I test admin is signed in. Plain-Boolean wrapper around
     * [getTestMode] (defaults to false if the claim can't be read) so a caller — e.g.
     * a ViewModel deciding whether to suppress a cross-tenant permission banner — can
     * ask without unpacking a value-class `Result`. (Value-class returns also trip up
     * mockk-relaxed test doubles, so the plain Boolean keeps those green by default.)
     */
    suspend fun isTestAdminActive(): Boolean = getTestMode().getOrNull()?.active == true

    /**
     * The Stage-0I seam: every kinfolk-scoped read/count/query below goes
     * through [ScopedFirestore], which holds the mode source itself and applies
     * the sandbox constraint before any call-site code runs - so a new read
     * cannot forget it. Mode resolution is [AuthGate.requireTestMode] (cached,
     * fail-loud), exactly what the old hand-inlined forks used.
     *
     * The two seams meet here and only here: the gate SOURCES the mode, this
     * seam APPLIES it to a query shape. W4-1 had to widen `requireTestMode` on
     * this class so [InvoiceRepository] could borrow it; it now takes the gate
     * directly and this file has nothing left to lend.
     */
    private val scoped by lazy { ScopedFirestore(firestore, authGate::requireTestMode) }

    suspend fun getKinfolk(): Result<List<Kinfolk>> = runCatching {
        AuntieLog.d("Fetching kinfolk list")
        authGate.ensureAuthenticated()
        scoped.scopedRead(
            "kinfolk",
            // Test admin: the only reachable kinfolk doc is the one whose id ==
            // testTribeId. A broad collection read would be permission-denied, so
            // collapse to a single doc fetch (fail-loud: errors propagate).
            sandbox = { doc ->
                val k = doc.toObject(Kinfolk::class.java)
                listOfNotNull(k).filter { allowsKinfolkDoc(it.id) }
            },
            unscoped = { col ->
                col.get().await().toObjects(Kinfolk::class.java).also {
                    AuntieLog.d("Fetched ${it.size} kinfolk")
                }
            },
        )
    }.onFailure { AuntieLog.e("Failed to get kinfolk", it) }

    suspend fun findKinfolkByPhone(phone: String): Result<Kinfolk?> = runCatching {
        AuntieLog.d("Searching kinfolk by phone: ${AuntieLog.redactPhone(phone)}")
        authGate.ensureAuthenticated()
        scoped.scopedRead(
            "kinfolk",
            // Test admin can only reach kinfolk/{testTribeId}; a phone query across
            // the collection would be denied. Fetch the sandbox doc and match locally.
            sandbox = { doc ->
                doc.toObject(Kinfolk::class.java)?.takeIf { it.phoneNumber == phone }
            },
            unscoped = { col ->
                col.whereEqualTo("phoneNumber", phone)
                    .get().await()
                    .documents.firstOrNull()?.toObject(Kinfolk::class.java).also {
                        if (it != null) AuntieLog.d("Found kinfolk id=${it.id}")
                        else AuntieLog.d("No kinfolk found for phone ${AuntieLog.redactPhone(phone)}")
                    }
            },
        )
    }.onFailure { AuntieLog.e("Error finding kinfolk by phone", it) }

    suspend fun createKinfolk(firstName: String, lastName: String, phone: String): Result<Kinfolk> = runCatching {
        AuntieLog.i("Creating new kinfolk phone=${AuntieLog.redactPhone(phone)}")
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        val docRef = firestore.collection("kinfolk").add(kinfolk).await()
        kinfolk.copy(id = docRef.id).also {
            AuntieLog.i("Created kinfolk id=${it.id}")
        }
    }.onFailure { AuntieLog.e("Failed to create complete kinfolk", it) }

    /**
     * Writes ONLY the `kinfolk` fields that actually changed, plus the stamp.
     *
     * THIS REPLACED A WHOLE-MODEL `updateKinfolk(kinfolk)`. That one wrote
     * `kinfolk.copy(updatedAt = serverTimestamp())` under `SetOptions.merge()`,
     * and merge protects fields OUTSIDE the written map while doing NOTHING
     * about stale ones inside it. So every field the phone read went back at the
     * phone's value, reverting whatever had changed in between - including
     * `preferredContactMethod` and `bestTimeToContact`, which
     * `firestore.rules#onlyAllowedKinfolkFields` lets the KINFOLK edit from the
     * MyTribe portal. The React admin reached this conclusion first and names
     * this very function as the clobbering writer
     * (`auntieos-admin/src/api/kinfolkProfileWrite.ts:17-60`).
     *
     * Worse, the edit screen rebuilt `Kinfolk` from form state, so fields the
     * form did not carry were written at their Kotlin DEFAULTS: `uid` (the
     * MyTribe login linkage) blanked, `contactOverride` nulled, the `archived*`
     * audit trail blanked. [com.tribetails.auntieos.ui.directory.KINFOLK_DIFF_FIELDS]
     * names what this client may write; everything else is left to its owner.
     *
     * MERGE IS STILL RIGHT, for the reason the old function documented and this
     * one inherits: a bare `set()` would delete every field the backend writes
     * and no client models - `myTribeLinkedAt` (revokeKinfolkClaim.ts),
     * `isTestData` (the sandbox marker, familyProvision.ts), `businessName`
     * (read by getMyHome.ts). A named-field map plus merge cannot touch either
     * class of field.
     *
     * `updatedAt` is STAMPED here, never round-tripped, so it cannot freeze and
     * lie about when the record last changed. `serverTimestamp()` matches what
     * the React admin writes (api/directoryWrite.ts) so both clients produce a
     * Firestore Timestamp; an ISO String here would reintroduce type drift.
     *
     * An empty [changes] is a caller bug, not a no-op to absorb: such a write
     * could only move the stamp, claiming a change that never happened.
     */
    suspend fun updateKinfolkFields(
        documentId: String,
        changes: Map<String, Any>,
    ): Result<Unit> = runCatching {
        require(documentId.isNotBlank()) { "updateKinfolkFields needs a kinfolk document id" }
        require(changes.isNotEmpty()) { "updateKinfolkFields called with no changed fields" }
        AuntieLog.i("Updating kinfolk id=$documentId: ${changes.keys.joinToString()}")
        authGate.ensureAuthenticated()
        val payload: Map<String, Any> = changes + mapOf("updatedAt" to FieldValue.serverTimestamp())
        firestore.collection("kinfolk").document(documentId)
            .set(payload, com.google.firebase.firestore.SetOptions.merge()).await()
        AuntieLog.d("Update successful for kinfolk id=$documentId")
        Unit
    }.onFailure { AuntieLog.e("Failed to update kinfolk $documentId", it) }

    suspend fun deleteKinfolk(kinfolkId: String): Result<Unit> = runCatching {
        AuntieLog.w("Deleting kinfolk: $kinfolkId")
        authGate.ensureAuthenticated()
        firestore.collection("kinfolk").document(kinfolkId).delete().await()
        AuntieLog.i("Deleted kinfolk: $kinfolkId")
        Unit
    }.onFailure { AuntieLog.e("Failed to delete kinfolk $kinfolkId", it) }

    // Archive: reversible state flip (matches web ArchiveBlock semantics).
    // Sets status="archived" + archivedAt timestamp + archivedReason. Document
    // remains in Firestore; lists must filter status="archived" to hide it.
    suspend fun archiveKinfolk(kinfolkId: String, reason: String, archivedBy: String = "admin"): Result<Unit> = runCatching {
        AuntieLog.i("Archiving kinfolk: $kinfolkId (reason: $reason)")
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        val payload = buildMap<String, Any> {
            put("actionType", entry.actionType)
            if (entry.description.isNotBlank()) put("description", entry.description)
            if (entry.status.isNotBlank()) put("status", entry.status)
            val actor = entry.actorId.ifBlank { auth.currentUser?.uid.orEmpty() }
            if (actor.isNotBlank()) put("actorId", actor)
            if (entry.targetId.isNotBlank()) put("targetId", entry.targetId)
            if (entry.targetCollection.isNotBlank()) put("targetCollection", entry.targetCollection)
        }
        functions.getHttpsCallable("logActivity").call(payload).awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("Failed to write activity_log entry", it) }

    /**
     * #14 (2026-06-08): invite an existing kinfolk to the kinfolk portal. Calls the
     * admin-gated inviteKinfolkToPortal callable. Returns the status string:
     * "sent" | "already_active" | "no_email". Fail-loud via Result.
     */
    suspend fun inviteKinfolkToPortal(kinfolkId: String): Result<String> = runCatching {
        AuntieLog.i("inviteKinfolkToPortal: $kinfolkId")
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("inviteKinfolkToPortal")
            .call(mapOf("kinfolkId" to kinfolkId)).awaitCallable().data as? Map<String, Any?>
            ?: error("inviteKinfolkToPortal: non-map payload")
        raw["status"] as? String ?: error("inviteKinfolkToPortal: missing status")
    }.onFailure { AuntieLog.e("inviteKinfolkToPortal failed", it) }

    suspend fun unarchiveKinfolk(kinfolkId: String): Result<Unit> = runCatching {
        AuntieLog.i("Unarchiving kinfolk: $kinfolkId")
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("kinfolk").document(kinfolkId).get().await()
        snapshot.toObject(Kinfolk::class.java)
    }.onFailure { AuntieLog.e("Failed to get kinfolk $kinfolkId", it) }

    suspend fun getKin(kinfolkId: String): Result<List<Kin>> = runCatching {
        AuntieLog.d("Fetching kin for kinfolk: $kinfolkId")
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("kin")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get().await()
        snapshot.toObjects(Kin::class.java).also {
            AuntieLog.d("Fetched ${it.size} kin for $kinfolkId")
        }
    }.onFailure { AuntieLog.e("Failed to get kin for $kinfolkId", it) }

    suspend fun createKin(kin: Kin): Result<Kin> = runCatching {
        // Write stamp, not a query: in test mode the create is forced into the
        // sandbox scope; scopedKinfolkId passes the caller's own kinfolkId
        // through for the normal admin, so no mode fork is needed here.
        val mode = authGate.requireTestMode()
        val kin = kin.copy(kinfolkId = mode.scopedKinfolkId(kin.kinfolkId))
        AuntieLog.i("Creating kin: ${kin.name} for kinfolk: ${kin.kinfolkId}")
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        scoped.scopedQuery("kin").toObjects(Kin::class.java)
    }.onFailure { AuntieLog.e("Failed to get all kin", it) }

    /**
     * Writes ONLY the `kin` fields that actually changed, plus the stamp.
     *
     * Same fix, same reasoning, same collection pair as [updateKinfolkFields]:
     * this replaced a whole-model `updateKin(kin)` whose `SetOptions.merge()`
     * guarded fields outside the written map and wrote every stale field inside
     * it straight back over the React admin's edits (`api/directoryWrite.ts`
     * patches `kin` field-level for exactly this reason).
     *
     * The edit screen's from-scratch `Kin(...)` rebuild made it destructive as
     * well as stale: `tags` went back null - wiping the pet tag assignment the
     * model comment claims declaring the field had already fixed - `photos` went
     * back empty, `ownerEmail` / `ownerPhone` blank, and `status` was hardcoded
     * to "active", quietly un-archiving an archived pet.
     * [com.tribetails.auntieos.ui.directory.KIN_DIFF_FIELDS] names what may be
     * written.
     *
     * [kinfolkId] is passed separately from [changes] because the mirror FK has
     * to be stamped on EVERY save, not only the ones that reassigned the pet:
     * `familyKinPath` is derived, not edited, so it never appears in a diff.
     */
    suspend fun updateKinFields(
        documentId: String,
        kinfolkId: String,
        changes: Map<String, Any>,
    ): Result<Unit> = runCatching {
        require(documentId.isNotBlank()) { "updateKinFields needs a kin document id" }
        require(changes.isNotEmpty()) { "updateKinFields called with no changed fields" }
        AuntieLog.i("Updating kin: $documentId: ${changes.keys.joinToString()}")
        authGate.ensureAuthenticated()
        val payload: Map<String, Any> = changes + mapOf("updatedAt" to FieldValue.serverTimestamp())
        firestore.collection("kin").document(documentId)
            .set(payload, com.google.firebase.firestore.SetOptions.merge()).await()
        // Additive FK for the MyTribe pet mirror (onFlatKinWrite). Same fields as
        // createKin; re-stamped on edit in case the pet was reassigned to a
        // kinfolk. Leaves the field writes above untouched.
        stampFamilyKinPath(kinId = documentId, kinfolkId = kinfolkId)
        AuntieLog.d("Update successful for kin: $documentId")
        Unit
    }.onFailure { AuntieLog.e("Failed to update kin $documentId", it) }

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
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("dossiers")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get().await()
        snapshot.documents.firstOrNull()?.toObject(Dossier::class.java).also {
            AuntieLog.d("Dossier found: ${it != null}")
        }
    }.onFailure { AuntieLog.e("Failed to get dossier for $kinfolkId", it) }

    /**
     * The household's bank (issue #461), read the same way [getDossier] reads a
     * dossier: a field query rather than a point read, so a legacy auto-id doc is
     * still found. A household with nothing household-targeted on file yet has no
     * bank, and null is the honest answer for it, not an error.
     */
    suspend fun getHouseholdBank(householdId: String): Result<HouseholdBank?> = runCatching {
        AuntieLog.d("Fetching household bank for household: $householdId")
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("household_bank")
            .whereEqualTo("householdId", householdId)
            .get().await()
        snapshot.documents.firstOrNull()?.toObject(HouseholdBank::class.java).also {
            AuntieLog.d("Household bank found: ${it != null}")
        }
    }.onFailure { AuntieLog.e("Failed to get household bank for $householdId", it) }

    suspend fun get411ForKin(kinId: String): Result<Kin411?> = runCatching {
        AuntieLog.d("Fetching 411 for kin: $kinId")
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        withContext(Dispatchers.IO) {
            functions.getHttpsCallable("synthesize_kinfolk_profile")
                .call(mapOf("kinfolkId" to kinfolkId))
                .awaitCallable()
        }
        Unit
    }.onFailure { AuntieLog.e("Failed to synthesize profile for $kinfolkId", it) }

    suspend fun clearDossierHouseholdNotes(kinfolkId: String): Result<Unit> = runCatching {
        AuntieLog.i("Clearing dossier household notes for kinfolk: $kinfolkId")
        authGate.ensureAuthenticated()
        withContext(Dispatchers.IO) {
            functions.getHttpsCallable("clear_dossier_household_notes")
                .call(mapOf("kinfolkId" to kinfolkId))
                .awaitCallable()
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
        mirrorToChannel: Boolean = false,
    ): Result<ExternalSendResult> = runCatching {
        authGate.ensureAuthenticated()
        val payload = buildMap<String, Any?> {
            put("channel", channel)
            put("to", to)
            put("body", body)
            if (channel == "email" && !subject.isNullOrBlank()) put("subject", subject)
            put("transactional", transactional)
            // Sent only when asked AND only on sms: the server REJECTS this flag on
            // the email channel with invalid-argument rather than ignoring it, so
            // passing it there would fail a send that would otherwise work.
            if (mirrorToChannel && channel == "sms") put("mirrorToChannel", true)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("sendExternalMessage")
            .call(payload)
            .awaitCallable().data as? Map<String, Any?>
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
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("suppressExternalRecipient")
            .call(mapOf("channel" to channel, "to" to to))
            .awaitCallable().data as? Map<String, Any?>
        decodeExternalSuppressResult(raw, channel)
    }.onFailure { AuntieLog.e("suppressExternalRecipient failed (channel=$channel)", it) }

    /**
     * Communicate "Recent": recent external sends + engagement counts via the
     * admin-gated listRecentSends callable (external_messages has no client read
     * rule). Counts are bumped by the SendGrid/Twilio webhooks. Fail-loud on error.
     */
    suspend fun listRecentSends(): Result<List<RecentSend>> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listRecentSends")
            .call(emptyMap<String, Any?>())
            .awaitCallable().data as? Map<String, Any?>
        decodeRecentSends(raw)
    }.onFailure { AuntieLog.e("listRecentSends failed", it) }

    /**
     * Run-4 #6: dog + cat breed name banks for the Kin breed dropdown, from the
     * `getBreeds` callable (reads the seeded dog_breeds / cat_breeds collections).
     * Fail-loud: a failure propagates via Result so the UI falls back to free-text
     * rather than showing a silent empty dropdown. Mirrors web FirestoreClient.breeds().
     */
    suspend fun getBreeds(): Result<BreedBank> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getBreeds")
            .call(emptyMap<String, Any?>())
            .awaitCallable().data as? Map<String, Any?>
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
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getLocalWeather")
            .call(emptyMap<String, Any?>())
            .awaitCallable().data as? Map<String, Any?>
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
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listChecklistBank")
            .call(emptyMap<String, Any?>())
            .awaitCallable().data as? Map<String, Any?>
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
        authGate.ensureAuthenticated()
        functions.getHttpsCallable("saveChecklistBankItem")
            .call(mapOf("text" to text, "scope" to scope))
            .awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("saveChecklistBankItem failed", it) }

    // ── Stage 2 step 6 (Communicate broadcast) ──────────────────────────────
    // Saved audience segments + a multichannel broadcast, all via admin-gated
    // callables (MyTribe functions/src/admin/{audienceSegments,broadcastMessage}).
    // Fail-loud: the no_recipients / broadcast_all_failed sentinels and provider
    // errors surface verbatim through the Result failure.

    suspend fun listAudienceSegments(): Result<List<com.tribetails.auntieos.ui.communicate.AudienceSegment>> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listAudienceSegments")
            .call(emptyMap<String, Any?>())
            .awaitCallable().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.communicate.decodeSegments(raw)
    }.onFailure { AuntieLog.e("listAudienceSegments failed", it) }

    suspend fun saveAudienceSegment(
        id: String?,
        name: String,
        criteria: com.tribetails.auntieos.ui.communicate.BroadcastCriteria,
    ): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        val payload = buildMap<String, Any?> {
            if (!id.isNullOrBlank()) put("id", id)
            put("name", name)
            put("criteria", criteria.toPayload())
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("saveAudienceSegment").call(payload).awaitCallable().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.communicate.decodeSavedSegmentId(raw)
    }.onFailure { AuntieLog.e("saveAudienceSegment failed", it) }

    suspend fun deleteAudienceSegment(id: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        functions.getHttpsCallable("deleteAudienceSegment").call(mapOf("id" to id)).awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("deleteAudienceSegment failed", it) }

    suspend fun broadcastMessage(
        segmentId: String?,
        criteria: com.tribetails.auntieos.ui.communicate.BroadcastCriteria?,
        channels: List<com.tribetails.auntieos.ui.communicate.BroadcastChannel>,
        subject: String?,
        body: String,
    ): Result<com.tribetails.auntieos.ui.communicate.BroadcastResult> = runCatching {
        authGate.ensureAuthenticated()
        val payload = buildMap<String, Any?> {
            if (!segmentId.isNullOrBlank()) put("segmentId", segmentId)
            if (criteria != null) put("criteria", criteria.toPayload())
            put("channels", channels.distinct().map { it.wire })
            if (!subject.isNullOrBlank()) put("subject", subject)
            put("body", body)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("broadcastMessage").call(payload).awaitCallable().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.communicate.decodeBroadcastResult(raw)
    }.onFailure { AuntieLog.e("broadcastMessage failed", it) }

    // ── Stage 2 step 7 (Inbox conversations / Message Auntie 16.4) ────────────
    // Two-way kinfolk<->auntie threads via admin-gated callables. Fail-loud:
    // errors surface verbatim through the Result failure.

    suspend fun listConversations(): Result<List<com.tribetails.auntieos.ui.inbox.ConversationSummary>> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listConversations").call(emptyMap<String, Any?>()).awaitCallable().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.inbox.decodeConversations(raw)
    }.onFailure { AuntieLog.e("listConversations failed", it) }

    suspend fun getConversationThread(kinfolkId: String): Result<List<com.tribetails.auntieos.ui.inbox.ThreadMessage>> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getConversationThread").call(mapOf("kinfolkId" to kinfolkId)).awaitCallable().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.inbox.decodeThread(raw)
    }.onFailure { AuntieLog.e("getConversationThread failed", it) }

    suspend fun replyToConversation(kinfolkId: String, body: String): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("replyToConversation").call(mapOf("kinfolkId" to kinfolkId, "body" to body)).awaitCallable().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.inbox.decodeReplyMessageId(raw)
    }.onFailure { AuntieLog.e("replyToConversation failed", it) }

    suspend fun markConversationRead(kinfolkId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        functions.getHttpsCallable("markConversationRead").call(mapOf("kinfolkId" to kinfolkId)).awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("markConversationRead failed", it) }

    /**
     * Clears the admin-side unread flag on EVERY thread waiting on a reply and
     * returns how many the server actually cleared.
     *
     * The count is the server's own, never a local guess: the callable bounds
     * one call, so a long backlog can leave threads still unread, and the caller
     * re-reads the list rather than assuming an empty inbox. A response with no
     * `cleared` field fails the Result instead of degrading to zero.
     */
    suspend fun markAllThreadsRead(): Result<Int> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("markAllThreadsRead").call(emptyMap<String, Any?>()).awaitCallable().data as? Map<String, Any?>
        com.tribetails.auntieos.ui.inbox.decodeClearedCount(raw)
            ?: error("markAllThreadsRead returned no count")
    }.onFailure { AuntieLog.e("markAllThreadsRead failed", it) }

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
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("optimizeRoute")
            .call(mapOf("date" to dateYmd)).awaitCallable().data as? Map<String, Any?>
            ?: error("optimizeRoute: non-map payload")
        decodeRouteResult(raw)
    }.onFailure { AuntieLog.e("optimizeRoute failed", it) }

    /** AO-40: recent expenses + server week/month totals via listExpenses (default last 30 days). */
    suspend fun listExpenses(sinceIso: String? = null): Result<ExpenseSummary> = runCatching {
        authGate.ensureAuthenticated()
        val payload = buildMap<String, Any?> { if (!sinceIso.isNullOrBlank()) put("sinceIso", sinceIso) }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listExpenses")
            .call(payload).awaitCallable().data as? Map<String, Any?>
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
        authGate.ensureAuthenticated()
        val payload = buildMap<String, Any?> {
            put("kind", kind)
            put("amountCents", amountCents)
            if (!note.isNullOrBlank()) put("note", note)
            if (!occurredAt.isNullOrBlank()) put("occurredAt", occurredAt)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("logExpense").call(payload).awaitCallable().data as? Map<String, Any?>
            ?: error("logExpense: non-map payload")
        raw["id"] as? String ?: error("logExpense: missing id")
    }.onFailure { AuntieLog.e("logExpense failed", it) }

    /** AO-41: supplies + low count (onHand <= par) via listSupplies. */
    suspend fun listSupplies(): Result<SuppliesResult> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listSupplies")
            .call(emptyMap<String, Any?>()).awaitCallable().data as? Map<String, Any?>
            ?: error("listSupplies: non-map payload")
        decodeSuppliesResult(raw)
    }.onFailure { AuntieLog.e("listSupplies failed", it) }

    /** AO-41: bump a supply's on-hand by [delta] via adjustSupply (server clamps at 0); returns the new onHand. */
    suspend fun adjustSupply(supplyId: String, delta: Int): Result<Int> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("adjustSupply")
            .call(mapOf("supplyId" to supplyId, "delta" to delta)).awaitCallable().data as? Map<String, Any?>
            ?: error("adjustSupply: non-map payload")
        (raw["onHand"] as? Number)?.toInt() ?: error("adjustSupply: missing onHand")
    }.onFailure { AuntieLog.e("adjustSupply failed", it) }

    /** AO-39: upcoming expirations via listExpirations (server sorts by dateIso asc). */
    suspend fun listExpirations(): Result<List<ExpirationItem>> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listExpirations")
            .call(emptyMap<String, Any?>()).awaitCallable().data as? Map<String, Any?>
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
        authGate.ensureAuthenticated()
        scoped.scopedQuery(
            "generated_drafts",
            field = "kinfolk_id",
            // Stage-0I sandbox: rules DENY an unfiltered list of generated_drafts, so
            // constrain to this tribe's own drafts (the doc's snake_case `kinfolk_id`
            // field == testScope; see generate.js). Sort + cap client-side to avoid a
            // composite (kinfolk_id, createdOn) index; the sandbox draft set is tiny.
            sandbox = { q ->
                q.get().await()
                    .toObjects(Draft::class.java)
                    .sortedByDescending { it.createdOn }
                    .take(3)
            },
            unscoped = { col ->
                col.orderBy("createdOn", com.google.firebase.firestore.Query.Direction.DESCENDING)
                    .limit(3)
                    .get().await()
                    .toObjects(Draft::class.java)
            },
        )
    }.onFailure { AuntieLog.e("Failed to get recent drafts", it) }

    suspend fun getKinfolkCount(): Result<Int> = runCatching {
        authGate.ensureAuthenticated()
        scoped.scopedRead(
            "kinfolk",
            // Only kinfolk/{testTribeId} is reachable; count is 0 or 1.
            sandbox = { doc -> if (doc.exists()) 1 else 0 },
            unscoped = { col -> col.get().await().size() },
        )
    }.onFailure { AuntieLog.e("Failed to get kinfolk count", it) }

    suspend fun getKinCount(): Result<Int> = runCatching {
        authGate.ensureAuthenticated()
        scoped.scopedCount("kin")
    }.onFailure { AuntieLog.e("Failed to get kin count", it) }

    suspend fun getPendingDraftCount(): Result<Int> = runCatching {
        authGate.ensureAuthenticated()
        scoped.scopedCount(
            "generated_drafts",
            field = "kinfolk_id",
            // Stage-0I sandbox: scope to this tribe (kinfolk_id == testScope) and count
            // 'pending' client-side to avoid a composite (kinfolk_id, status) index. An
            // unfiltered read is denied by rules for a test admin.
            sandbox = { snap -> snap.documents.count { it.getString("status") == "pending" } },
            unscoped = { whereEqualTo("status", "pending") },
        )
    }.onFailure { AuntieLog.e("Failed to get pending draft count", it) }

    // Business/Operational Settings
    suspend fun getBusinessSettings(): Result<BusinessSettings> = runCatching {
        AuntieLog.d("Fetching business settings")
        authGate.ensureAuthenticated()
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

    /**
     * The Google Calendar sync's last-run receipt, read straight off the same
     * business_settings doc. Null when no sync has ever been stamped.
     *
     * Read from the RAW snapshot rather than through [BusinessSettings], on
     * purpose: a receipt field living on that model could be rewritten from
     * stale in-memory state, silently replacing a newer stamp. That used to be
     * the immediate hazard, because settings saves wrote the model as a whole
     * object; [updateBusinessSettingsFields] now writes only changed fields, and
     * only fields `BUSINESS_SETTINGS_DIFF_FIELDS` names. Keeping the receipt off
     * the model therefore still holds, and now holds by construction rather than
     * by everyone remembering. Only `syncGoogleCalendarBusyEvents` writes these
     * four fields. See `mytribe/functions/CALLABLE_CONTRACT.md`.
     */
    suspend fun getCalendarSyncRun(): Result<CalendarSyncRun?> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("business_settings")
            .document("business_settings")
            .get()
            .await()
        calendarSyncRunFrom(
            ranAt = snapshot.getString("calendarSyncLastRunAt"),
            status = snapshot.getString("calendarSyncLastStatus"),
            imported = snapshot.getLong("calendarSyncLastImported")?.toInt(),
            error = snapshot.getString("calendarSyncLastError"),
        )
    }.onFailure { AuntieLog.e("Failed to read calendar sync receipt", it) }

    /**
     * Writes ONLY the settings fields that actually changed, plus the stamp.
     *
     * THIS REPLACES a whole-model `.set(settings, merge())`, whose own comment
     * admitted the defect and left the fix for its own change:
     *
     *   "KNOWN GAP ... 'Never clobbers the rest of the union' is only true of
     *   DELETION. Every field of [BusinessSettings] is INSIDE this written map,
     *   so a screen that loaded the doc an hour ago writes all ~50 of them back
     *   at the values it read, reverting whatever changed since."
     *
     * `SetOptions.merge()` protects fields OUTSIDE the written map and does
     * nothing about stale fields inside it. This is the one document every
     * settings editor shares, so that gap was the widest on the app: the React
     * admin patches it PER SECTION (`auntieos-admin/src/api/settingsWrite.ts`,
     * which sends only the touched fields for exactly this reason), and the
     * union holds `calendarSyncId`, the venmo/paypal/cashapp handles and both
     * tag vocabularies. [businessSettingsFieldChanges] builds the map; each
     * caller diffs against the copy it loaded and advances that baseline only
     * after a save the server accepted.
     *
     * `updatedAt` / `updatedBy` are STAMPED here, never round-tripped from what
     * was read, so they cannot freeze and lie about when the doc last changed
     * (the rule [updateKinfolkFields] and [updateHouseholdFields] follow). ISO
     * String rather than `serverTimestamp()`, because `BusinessSettings.updatedAt`
     * is a `String` and the React Settings screen parses it as one.
     *
     * An empty [changes] is a caller bug, not a no-op to absorb: such a write
     * could only move the stamp, claiming a change that never happened. Every
     * caller skips the call outright when the diff is empty.
     *
     * The calendar-sync receipt fields stay unreachable from here, which is what
     * `CalendarSyncId.kt` relies on when it keeps `CalendarSyncRun` off
     * [BusinessSettings]. They were merely absent from the model before; now a
     * write can only name a field `BUSINESS_SETTINGS_DIFF_FIELDS` names, so
     * [getCalendarSyncRun]'s raw-snapshot read has nothing that can overwrite it.
     */
    suspend fun updateBusinessSettingsFields(
        changes: Map<String, Any?>,
        updatedBy: String = "admin",
    ): Result<Unit> = runCatching {
        require(changes.isNotEmpty()) { "updateBusinessSettingsFields called with no changed fields" }
        AuntieLog.i("Updating business settings by $updatedBy: ${changes.keys.joinToString()}")
        authGate.ensureAuthenticated()
        val payload: Map<String, Any?> = changes + mapOf(
            "updatedAt" to getCurrentTimestamp(),
            "updatedBy" to updatedBy,
        )
        firestore.collection("business_settings")
            .document("business_settings")
            .set(payload, com.google.firebase.firestore.SetOptions.merge())
            .await()
        AuntieLog.d("Business settings saved successfully")
        Unit
    }.onFailure { AuntieLog.e("Failed to save business settings", it) }

    // Coverage Package Builder config (visit menu + coverage rules). Single doc
    // coverage_package_config/config, same posture as business_settings: direct
    // client SDK get/set gated by firestore.rules (write: isAuntie). A missing
    // doc (or an empty menu) resolves to the shipped defaults via withDefaults().
    suspend fun getCoveragePackageConfig(): Result<CoveragePackageConfig> = runCatching {
        AuntieLog.d("Fetching coverage package config")
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("coverage_package_config")
            .document("config")
            .get()
            .await()

        if (snapshot.exists()) {
            (snapshot.toObject(CoveragePackageConfig::class.java) ?: CoveragePackageConfig()).withDefaults()
        } else {
            AuntieLog.i("Coverage package config not found, returning defaults")
            CoveragePackageConfig().withDefaults()
        }
    }.onFailure { AuntieLog.e("Failed to get coverage package config", it) }

    /**
     * Writes ONLY the coverage-config fields that actually changed, plus the stamp.
     *
     * This replaced a whole-model `saveCoveragePackageConfig(config)` whose
     * `.set(config, merge())` carried the whole [CoveragePackageConfig] on every
     * save — the shape [updateHouseholdFields], [updateKinfolkFields] and
     * [updateBusinessSettingsFields] each removed from their own collection.
     * `CoveragePackageConfigDiff.kt` says which fields exist, why the blast radius
     * on THIS document was small, and which two losses the diff actually closes.
     *
     * `updatedAt` is STAMPED here, never round-tripped from the value that was
     * read. ISO-8601 String rather than `serverTimestamp()`, because
     * `CoveragePackageConfig.updatedAt` is a `String` and the React admin parses it
     * as one (`auntieos-admin/src/api/coveragePackage.ts`).
     *
     * MERGE STAYS, and now earns its comment. It is what leaves the legacy `rules`
     * field on an old document alone — neither client models it, so neither can
     * name it, and only merge preserves a field the client cannot name. It was
     * never what made a whole-model write safe.
     *
     * An empty [changes] is a caller bug, not a no-op to absorb: such a write could
     * only move the stamp, claiming a change that never happened. The ViewModel
     * skips the call outright when the diff is empty.
     */
    suspend fun updateCoveragePackageConfigFields(
        changes: Map<String, Any?>,
        updatedBy: String = "admin",
    ): Result<Unit> = runCatching {
        require(changes.isNotEmpty()) { "updateCoveragePackageConfigFields called with no changed fields" }
        AuntieLog.i("Updating coverage package config by $updatedBy: ${changes.keys.joinToString()}")
        authGate.ensureAuthenticated()
        val payload: Map<String, Any?> = changes + mapOf(
            "updatedAt" to getCurrentTimestamp(),
            "updatedBy" to updatedBy,
        )
        firestore.collection("coverage_package_config")
            .document("config")
            .set(payload, com.google.firebase.firestore.SetOptions.merge())
            .await()
        AuntieLog.d("Coverage package config saved successfully")
        Unit
    }.onFailure { AuntieLog.e("Failed to save coverage package config", it) }

    // Business Hours - single source of truth lives in ServiceRepository.
    // AuntieRepository delegates so AdminSettings + ServiceManagement screens
    // never diverge on the `business_hours` collection.
    private val serviceRepo by lazy { ServiceRepository() }

    suspend fun getBusinessHours(): Result<List<BusinessHours>> {
        authGate.ensureAuthenticated()
        return serviceRepo.getBusinessHours()
    }

    suspend fun saveBusinessHours(hours: List<BusinessHours>): Result<Unit> {
        authGate.ensureAuthenticated()
        return serviceRepo.updateBusinessHours(hours)
    }

    private fun getCurrentTimestamp(): String {
        return java.time.Instant.now().toString()
    }

    // --- Media Storage Management ---

    suspend fun getMediaFiles(entityId: String, entityType: MediaEntityType): Result<List<MediaFile>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("media_files")
            .whereEqualTo("entityId", entityId)
            .whereEqualTo("entityType", entityType.name)
            .orderBy("uploadedAt", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .get()
            .await()
        snapshot.toObjects(MediaFile::class.java)
    }.onFailure { AuntieLog.e("Failed to get media files", it) }

    /** #13 Gallery: ALL business media (every entity). Test-admin sandbox: scoped to the
     *  test kinfolk's media via [ScopedFirestore.scopedQuery]; the operator gets the full collection. */
    suspend fun getAllMedia(): Result<List<MediaFile>> = runCatching {
        authGate.ensureAuthenticated()
        scoped.scopedQuery("media_files").toObjects(MediaFile::class.java)
    }.onFailure { AuntieLog.e("Failed to get all media", it) }

    /**
     * #13 Gallery / #447: set the kin tagged in a media file.
     *
     * SERVER-BOUND since #447. This used to be a bare
     * `.update("taggedKinIds", ids)` straight onto the document, which meant
     * nothing checked that a tagged kin existed, or even belonged to the
     * household whose photo it is, and no audit entry was written. The
     * `saveMediaTags` callable enforces both, `firestore.rules` now REFUSES any
     * client update that touches the key, and the React admin's tag dialog
     * calls the same callable with the same payload, so the two clients cannot
     * drift apart again.
     *
     * The payload is the COMPLETE list after the edit, never a delta; an empty
     * list clears every tag. Returns the list AS STORED (the server
     * de-duplicates), so the caller reflects what actually landed rather than
     * what it hoped to send.
     */
    suspend fun updateMediaTags(mediaFileId: String, taggedKinIds: List<String>): Result<List<String>> = runCatching {
        authGate.ensureAuthenticated()
        val raw = functions.getHttpsCallable("saveMediaTags")
            .call(mapOf("mediaFileId" to mediaFileId, "taggedKinIds" to taggedKinIds))
            .awaitCallable().data as? Map<*, *>
        // Fall back to the sent list rather than to EMPTY on an unreadable
        // response: the write succeeded (no exception reached here), and
        // reporting "no tags" would repaint the grid as though it had failed.
        (raw?.get("taggedKinIds") as? List<*>)?.mapNotNull { it as? String } ?: taggedKinIds
    }.onFailure { AuntieLog.e("Failed to update media tags", it) }

    suspend fun saveMediaFile(mediaFile: MediaFile): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        val mode = authGate.requireTestMode()
        val docRef = firestore.collection("media_files").document()
        // Stage 0I: a test admin must stamp kinfolkId == testTribeId so the sandbox
        // rules (testOwnsIncoming) allow the write; the operator writes no scope.
        // kinfolkId is now a typed MediaFile field, so a single set() carries it
        // (replaces the prior second SetOptions.merge write from before the field existed).
        val newMediaFile = mediaFile
            .copy(id = docRef.id, uploadedAt = getCurrentTimestamp())
            .withSandboxScope(mode.kinfolkScopeFilter())
        docRef.set(newMediaFile).await()
        // Operator ruling 2026-07-31: Kinfolk do not "own" media, so a KIN/BUSINESS/
        // ... upload's kinfolkId must be ABSENT, never blank. MediaFile#kinfolkId is
        // a non-nullable `var kinfolkId: String = ""`, so the set() above always
        // WRITES the key -- a data class field cannot omit itself. Delete it right
        // after create when blank (hasBlankKinfolkId, domain/MediaScope.kt) rather
        // than leave "": that is the exact equality-on-empty-string Firestore trap
        // HANDOFF_2026-07-25 documents for invoiceId (a doc stamped "" and one that
        // never had the field read as two different things to a future query).
        // Never fires for a sandbox test-admin write: withSandboxScope above always
        // stamps a real, non-blank testTribeId when that mode is active.
        if (newMediaFile.hasBlankKinfolkId()) {
            docRef.update("kinfolkId", FieldValue.delete()).await()
        }
        docRef.id
    }.onFailure { AuntieLog.e("Failed to save media file", it) }

    /**
     * #397 S2: server-bound delete, the destructive twin of setMediaProfilePhoto.
     *
     * This used to be a raw `document(mediaFileId).delete()`, and that left a
     * DANGLING PROFILE PHOTO: setMediaProfilePhoto stamps kinfolk/kin
     * .profilePictureUrl (or users/{uid}.photoUrl) with this doc's storageUrl,
     * so dropping the row alone left the profile rendering a photo the gallery
     * had forgotten, with nothing left in the app able to clear it. The callable
     * deletes the row and clears that field in one atomic batch, and only when
     * it actually points at this file. It also writes the audit entry a client
     * delete never could, which matters more here than anywhere, because the
     * deleted row is otherwise the only record that the file existed.
     *
     * The Cloudinary asset itself is deliberately left in place; see the
     * function's own header for why.
     */
    suspend fun deleteMediaFile(mediaFileId: String, entityId: String = ""): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        val args = mutableMapOf<String, Any>("mediaFileId" to mediaFileId)
        // Sent only when the caller is entity-scoped. Blank would fail the
        // server's own min(1) validation, so it is omitted rather than padded.
        if (entityId.isNotBlank()) args["entityId"] = entityId
        functions.getHttpsCallable("deleteMediaFile").call(args).awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete media file", it) }

    /**
     * #397 S3: rewrite one media file's caption.
     *
     * NEITHER CLIENT COULD DO THIS BEFORE. `description` was written once, at
     * upload, and never again, so a typo or the wrong pet's name was permanent.
     *
     * A TARGETED SINGLE-FIELD UPDATE, never a `set(mediaFile)` rebuilt from
     * screen state. That is the trap this codebase has hit repeatedly: an edit
     * screen rebuilds the model from the fields it renders and silently blanks
     * every field it has no control for. `media_files` docs carry width/height/
     * cloudinaryPublicId/tags/taggedKinIds that no caption editor shows, and
     * `taggedKinIds` is server-bound, so a whole-document write would be REFUSED
     * by firestore.rules outright.
     *
     * No callable: the rules already allow an isAuntie() update on every key
     * except taggedKinIds, and a caption has no cross-collection consequence
     * (unlike delete and set-profile, which do, and therefore are callables).
     * The web client writes the identical single-key update.
     */
    suspend fun updateMediaFileDescription(mediaFileId: String, description: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("media_files").document(mediaFileId)
            .update("description", description.trim())
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update media caption for $mediaFileId", it) }

    // --- Location Tracking Management ---

    suspend fun saveVisitRoute(route: VisitRoute): Result<String> = runCatching {
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("visit_routes").document(routeId).get().await()
        snapshot.toObject(VisitRoute::class.java)
    }.onFailure { AuntieLog.e("Failed to get visit route", it) }

    suspend fun getVisitRoutesForKinfolk(kinfolkId: String): Result<List<VisitRoute>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("visit_routes")
            .whereEqualTo("kinfolkId", kinfolkId)
            .orderBy("startTime", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .get()
            .await()
        snapshot.toObjects(VisitRoute::class.java)
    }.onFailure { AuntieLog.e("Failed to get visit routes", it) }

    suspend fun saveLocationCheckpoint(checkpoint: LocationCheckpoint): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        val docRef = firestore.collection("location_checkpoints").document()
        val newCheckpoint = checkpoint.copy(
            id = docRef.id,
            timestamp = if (checkpoint.timestamp.isBlank()) getCurrentTimestamp() else checkpoint.timestamp
        )
        docRef.set(newCheckpoint).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to save location checkpoint", it) }

    suspend fun getCheckpointsForRoute(routeId: String): Result<List<LocationCheckpoint>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("location_checkpoints")
            .whereEqualTo("routeId", routeId)
            .orderBy("timestamp")
            .get()
            .await()
        snapshot.toObjects(LocationCheckpoint::class.java)
    }.onFailure { AuntieLog.e("Failed to get checkpoints", it) }

    suspend fun getLocationSharingPreferences(kinfolkId: String): Result<LocationSharingPreferences?> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("location_sharing_preferences")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get()
            .await()
        snapshot.toObjects(LocationSharingPreferences::class.java).firstOrNull()
    }.onFailure { AuntieLog.e("Failed to get location sharing preferences", it) }

    suspend fun saveLocationSharingPreferences(preferences: LocationSharingPreferences): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("visit_routes")
            .whereEqualTo("kinCareSessionId", sessionId)
            .orderBy("startTime", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .get()
            .await()
        snapshot.toObjects(VisitRoute::class.java)
    }.onFailure { AuntieLog.e("Failed to get visit routes for session $sessionId", it) }

    // --- Household Data ---

    /**
     * Every household record, for the vet clinics manager's per-clinic usage
     * badge. Bounded at 500, the same cap the other admin catalogs use.
     *
     * KNOWN LIMIT, logged as follow-up rather than papered over: this is a
     * full-collection scan and the cap silently under-reports once a tribe
     * passes it, on the one screen whose job is saying how far a correction
     * travels. A server-side count is the real answer; a bigger cap would be
     * the same defect further away.
     */
    suspend fun getAllHouseholdData(): Result<List<HouseholdData>> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("household_data").limit(500).get().await()
            .toObjects(HouseholdData::class.java)
    }.onFailure { AuntieLog.e("Failed to read household data", it) }
    suspend fun getHouseholdData(kinfolkId: String): Result<HouseholdData?> = runCatching {
        AuntieLog.d("Fetching household data for kinfolk: $kinfolkId")
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("household_data")
            .whereEqualTo("kinfolkId", kinfolkId)
            .limit(1)
            .get()
            .await()
        snapshot.documents.firstOrNull()?.toObject(HouseholdData::class.java)
    }.onFailure { AuntieLog.e("Failed to get household data for $kinfolkId", it) }

    /**
     * CREATES the household's first record. Whole-document write, which is
     * correct exactly here: there is no document yet, so there is nothing to
     * clobber, and a complete one keeps `toObject(HouseholdData::class.java)`
     * and the React reader happy. Same reasoning as the web port's create branch
     * (`auntieos-admin/src/api/householdData.ts:141-150`).
     *
     * EDITING an existing record goes through [updateHouseholdFields]. This used
     * to take that path too, `.set(loadedModel.copy(updatedAt = now), merge())`,
     * and that whole-model write is what silently reverted concurrent web edits.
     * The non-blank id now fails loud rather than quietly re-opening it.
     *
     * RETURNS THE NEW DOCUMENT ID, and that return value is load-bearing. It
     * used to be `Result<Unit>`: the id was minted here and died here, so the
     * caller's in-memory record kept a blank id and a second press of Save took
     * this create branch AGAIN, writing a SECOND `household_data` document for
     * the same household. [getHouseholdData] reads
     * `whereEqualTo("kinfolkId").limit(1)`, so which of the two duplicates the
     * app then shows is arbitrary, and every edit after that lands on whichever
     * one the screen happened to hold. Handing the id back is what lets the
     * caller switch to the edit path on the second save.
     */
    suspend fun saveHouseholdData(data: HouseholdData): Result<String> = runCatching {
        require(data.id.isBlank()) {
            "saveHouseholdData creates; edit ${data.id} through updateHouseholdFields"
        }
        authGate.ensureAuthenticated()
        val timestamp = getCurrentTimestamp()
        val docRef = firestore.collection("household_data").document()
        docRef.set(data.copy(
            id = docRef.id,
            createdAt = if (data.createdAt.isBlank()) timestamp else data.createdAt,
            updatedAt = timestamp
        )).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to save household data for ${data.kinfolkId}", it) }

    /**
     * Writes ONLY the household fields that actually changed, plus the stamp.
     *
     * `SetOptions.merge()` protects fields OUTSIDE the written map and does
     * NOTHING about stale fields inside it, so handing it a model read minutes
     * ago writes every one of those fields back at its old value. That silently
     * reverted whatever the React admin changed in between - including
     * `primaryVetClinicId`, the clinic a sitter phones in an emergency. React
     * reached the same conclusion first and says why
     * (`auntieos-admin/src/api/householdData.ts:110-127`, citing the 2026-07-20
     * `familyKinPath` loss). [householdFieldChanges] builds the map.
     *
     * `updatedAt` is STAMPED here, never round-tripped from the value that was
     * read, so it cannot freeze and lie about when the record last changed (the
     * rule [updateKinfolk] documents). It stays an ISO-8601 String rather than
     * `serverTimestamp()`: `HouseholdData.updatedAt` is a `String` and the React
     * port parses it as one, so a Timestamp here would be type drift, not a fix.
     *
     * An empty [changes] is a caller bug, not a no-op to absorb: such a write
     * could only move the stamp, claiming a change that never happened. The
     * ViewModel skips the call outright when nothing was edited.
     */
    suspend fun updateHouseholdFields(
        documentId: String,
        changes: Map<String, String>,
    ): Result<Unit> = runCatching {
        require(documentId.isNotBlank()) { "updateHouseholdFields needs a household_data document id" }
        require(changes.isNotEmpty()) { "updateHouseholdFields called with no changed fields" }
        authGate.ensureAuthenticated()
        val payload: Map<String, Any> = changes + mapOf("updatedAt" to getCurrentTimestamp())
        firestore.collection("household_data").document(documentId)
            .set(payload, com.google.firebase.firestore.SetOptions.merge())
            .await()
        AuntieLog.d("Household $documentId updated: ${changes.keys.joinToString()}")
        Unit
    }.onFailure { AuntieLog.e("Failed to update household data $documentId", it) }

    // --- Media Albums ---

    suspend fun getMediaAlbums(entityId: String, entityType: MediaEntityType): Result<List<MediaAlbum>> = runCatching {
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        firestore.collection("field_definitions").document(field.id)
            .set(field.copy(updatedAt = getCurrentTimestamp()))
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update field definition ${field.id}", it) }

    suspend fun deleteFieldDefinition(fieldId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("field_definitions").document(fieldId).delete().await()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete field definition $fieldId", it) }

    // --- Dynamic Field Values ---

    suspend fun getDynamicFieldValues(entityId: String, entityType: TargetEntity): Result<List<DynamicFieldValue>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("dynamic_field_values")
            .whereEqualTo("entityId", entityId)
            .whereEqualTo("entityType", entityType.name)
            .get()
            .await()
        snapshot.toObjects(DynamicFieldValue::class.java)
    }.onFailure { AuntieLog.e("Failed to get dynamic field values", it) }

    suspend fun saveDynamicFieldValue(value: DynamicFieldValue): Result<String> = runCatching {
        authGate.ensureAuthenticated()
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

    /**
     * Stage 2 tail: apply ONE booking transition (APPROVE/REJECT/CANCEL) to many
     * individual visit ids at once via the batchUpdateBookings callable. Returns the
     * updated count + per-id failures. Fail-loud: per-id failures are surfaced in
     * [BatchBookingResult.failed] so callers can show updated/failed honestly.
     */
    suspend fun batchUpdateBookings(ids: List<String>, action: String): Result<BatchBookingResult> = runCatching {
        authGate.ensureAuthenticated()
        val args = BatchUpdateBookingsArgs(ids = ids, action = action)
        val raw = functions.getHttpsCallable("batchUpdateBookings").call(args.toPayload()).awaitCallable().data
        @Suppress("UNCHECKED_CAST")
        decodeBatchBookingResult(raw as? Map<String, Any?>, action)
    }.onFailure { AuntieLog.e("batchUpdateBookings ($action) failed for ${ids.size} id(s)", it) }

    /**
     * Stage 2 tail: mark MANY notifications read at once via the
     * bulkMarkNotificationsRead callable. Returns the number actually marked (ids
     * not owned/missing are skipped server-side).
     */
    suspend fun bulkMarkNotificationsRead(ids: List<String>): Result<Int> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("bulkMarkNotificationsRead")
            .call(mapOf("ids" to ids))
            .awaitCallable().data as? Map<String, Any?>
        decodeMarkedCount(raw)
    }.onFailure { AuntieLog.e("bulkMarkNotificationsRead failed for ${ids.size} id(s)", it) }

    /**
     * Step 4 quick-action: mark ONE notification read via the markNotificationRead
     * callable (writes a readAt server timestamp). Fail-loud: server preconditions
     * (not-found / not-your-notification) surface verbatim.
     */
    suspend fun markNotificationRead(id: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(id.isNotBlank()) { "markNotificationRead requires a notification id" }
        functions.getHttpsCallable("markNotificationRead")
            .call(mapOf("notificationId" to id))
            .awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("markNotificationRead failed for $id", it) }

    /**
     * Step 4 quick-action: clear ONE notification's read markers via the
     * markNotificationUnread callable (inverse of markNotificationRead).
     */
    suspend fun markNotificationUnread(id: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(id.isNotBlank()) { "markNotificationUnread requires a notification id" }
        functions.getHttpsCallable("markNotificationUnread")
            .call(mapOf("notificationId" to id))
            .awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("markNotificationUnread failed for $id", it) }

    /**
     * Step 4 quick-action: archive ONE notification out of the active inbox via the
     * archiveNotification callable (writes an archivedAt server timestamp; nothing
     * is deleted). Returns the number actually archived (0 when the id is stale or
     * not the caller's). Fail-loud.
     */
    suspend fun archiveNotification(id: String): Result<Int> = runCatching {
        authGate.ensureAuthenticated()
        require(id.isNotBlank()) { "archiveNotification requires a notification id" }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("archiveNotification")
            .call(mapOf("id" to id))
            .awaitCallable().data as? Map<String, Any?>
        decodeArchivedCount(raw)
    }.onFailure { AuntieLog.e("archiveNotification failed for $id", it) }

    /**
     * Step 4 quick-action: archive MANY notifications at once via the
     * bulkArchiveNotifications callable. Returns the number actually archived (ids
     * not owned/missing are skipped server-side).
     */
    suspend fun bulkArchiveNotifications(ids: List<String>): Result<Int> = runCatching {
        authGate.ensureAuthenticated()
        require(ids.isNotEmpty()) { "bulkArchiveNotifications requires at least one id" }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("bulkArchiveNotifications")
            .call(mapOf("ids" to ids))
            .awaitCallable().data as? Map<String, Any?>
        decodeArchivedCount(raw)
    }.onFailure { AuntieLog.e("bulkArchiveNotifications failed for ${ids.size} id(s)", it) }

    // --- Visit Logs ---

    suspend fun getVisitLogs(): Result<List<VisitLog>> = runCatching {
        authGate.ensureAuthenticated()
        scoped.scopedQuery("visit_logs").toObjects(VisitLog::class.java)
    }.onFailure { AuntieLog.e("Failed to get visit logs", it) }

    suspend fun getVisitLogsForKinfolk(kinfolkId: String): Result<List<VisitLog>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("visit_logs")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get()
            .await()
        snapshot.toObjects(VisitLog::class.java)
    }.onFailure { AuntieLog.e("Failed to get visit logs for $kinfolkId", it) }

    suspend fun createVisitLog(log: VisitLog): Result<String> = runCatching {
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
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
        val raw = functions.getHttpsCallable("createTrainingDocument").call(payload).awaitCallable().data as? Map<String, Any?>
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
        authGate.ensureAuthenticated()
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
        functions.getHttpsCallable("updateTrainingDocument").call(payload).awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("Failed to update training document $docId", it) }

    /** Spec 23: delete a Tribal Intel note. Does NOT unmerge already-folded dossier/411 text. */
    suspend fun deleteTrainingDocument(docId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(docId.isNotBlank()) { "docId required" }
        functions.getHttpsCallable("deleteTrainingDocument").call(mapOf("docId" to docId)).awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete training document $docId", it) }

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
        authGate.ensureAuthenticated()
        val payload = hashMapOf(
            "token" to token,
            "platform" to "android",
            "appVersion" to BuildConfig.VERSION_NAME,
        )
        functions.getHttpsCallable("registerFcmToken").call(payload).awaitCallable()
        AuntieLog.i("FCM token registered via callable")
        Unit
    }.onFailure { AuntieLog.e("Failed to register FCM device token", it) }

    // --- Twilio Voice access token ---

    /**
     * Mint a Twilio Voice SDK access token for this signed-in admin.
     *
     * Replaces a Retrofit GET against `https://tribetailsattendant-8587.twil.io/get-token`,
     * which was PUBLIC (no arguments, no check, a token granting `incomingAllow`
     * for the `auntie` identity to anyone who knew the URL) and which 404s today.
     * The `mintVoiceAccessToken` callable is admin gated and derives the identity
     * server side, so neither the caller nor this method can name one.
     *
     * NO PAYLOAD ON PURPOSE. Everything the server needs is the caller's own auth
     * context. Sending an identity here is the hole the callable exists to close,
     * so this is the no-argument `call()` overload and must stay that way.
     *
     * The failure stays a raw `FirebaseFunctionsException` rather than being
     * flattened to a message: the callable throws `failed-precondition` with
     * `details.secret` naming the Twilio secret that is missing or malformed, and
     * `VoiceTokenManager.classifyTokenFailure` turns that into a banner naming
     * it. A message-only failure would throw that away.
     */
    suspend fun mintVoiceAccessToken(): Result<VoiceAccessToken> = runCatching {
        authGate.ensureAuthenticated()
        val raw = functions.getHttpsCallable("mintVoiceAccessToken").call().awaitCallable().data
        val data = raw as? Map<*, *>
            ?: throw IllegalStateException("mintVoiceAccessToken returned no data")
        // Every field is required and none is guessed. A token assembled out of a
        // half-read response fails later, at Twilio registration, where the cause
        // is no longer visible.
        val token = (data["token"] as? String)?.takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("mintVoiceAccessToken returned no token")
        val identity = (data["identity"] as? String)?.takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("mintVoiceAccessToken returned no identity")
        // Read as Number, not as Long: the callable wire hands small integers back
        // as Integer, so `as Long` would ClassCastException on a 3600 second TTL.
        val expiresInSeconds = (data["expiresInSeconds"] as? Number)?.toLong()
            ?: throw IllegalStateException("mintVoiceAccessToken returned no expiresInSeconds")
        VoiceAccessToken(token = token, identity = identity, expiresInSeconds = expiresInSeconds)
    }.onFailure { AuntieLog.e("Failed to mint a Twilio Voice access token", it) }

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
     * Email, as a bounded live stream, matching its three sibling channels.
     *
     * Replaces the Inbox's use of [getEmails], which was an UNBOUNDED
     * `collection("emails").get()`: no orderBy, no limit, the whole collection
     * on every screen open. That is the AO-29 shape the other three channels
     * were already written away from, and it was also the reason email was the
     * one channel that did not update until the screen was reopened.
     *
     * Ordered on `timestamp` DESCENDING, an ISO-8601 STRING on this collection
     * (see `EmailMessage.timestamp` and the Twilio inbound writers), so the sort
     * is lexical. A Firestore Timestamp bound against this field would match
     * nothing and would NOT error. Note also that ORDER BY skips documents that
     * lack the field entirely, so a writer that forgets `timestamp` makes its
     * rows invisible here rather than raising; every current writer sets it.
     *
     * [getEmails] stays for callers that genuinely want one shot; the Inbox is
     * not one of them.
     */
    fun observeEmails(limit: Long = 200): Flow<List<EmailMessage>> = callbackFlow {
        if (!checkAuthOrCloseFlow("observeEmails")) return@callbackFlow
        val reg = firestore.collection("emails")
            .orderBy("timestamp", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .limit(limit)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    close(error)
                    return@addSnapshotListener
                }
                trySend(snapshot?.toObjects(EmailMessage::class.java).orEmpty())
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

    /**
     * Records an inbound call from the FCM push that raised the incoming-call
     * screen, onto the document Twilio's webhook also writes.
     *
     * TWO WRITERS, ONE DOCUMENT. `mytribe/functions/src/twilio/twilioInbound.ts`
     * (`twilioInboundCallHandler`) merge-upserts `calls_log/{CallSid}` with the
     * call's `recordingUrl`, `durationSec`, `status` and the
     * `kinfolkId`/`kinfolkName` it resolved from the caller's number. This client
     * knows none of those. It knows who called, what the push transcribed, and
     * the popup link.
     *
     * IT IS ONE TRANSACTION, not a read and then a write. The old shape read the
     * document with a plain `get()`, rebuilt the whole [CallLog] from it and
     * bare-`set()` that back, so a webhook landing in the gap was fully REVERTED
     * - recording, duration, status and the kinfolk match all snapped back to
     * what the phone had read a moment earlier. A transaction closes that gap
     * rather than narrowing it: Firestore re-runs the block if the document
     * changed underneath it.
     *
     * THE RECORDING URL IS WRITTEN ONLY WHEN THE PUSH CARRIES ONE. It used to be
     * assigned unconditionally (`recordingUrl = popupUrl`), so a push without a
     * popup link wrote a blank straight over the recording URL Twilio had
     * already stored. There is no second copy of that link on this system, so
     * losing it loses the way back to the recording.
     *
     * `status` and `timestamp` are written only when the stored document does not
     * already carry them. Restating a value read a moment ago is how the other
     * writer's work gets undone, and inside a transaction there is nothing to be
     * gained by it.
     */
    suspend fun upsertInboundCallLog(
        callSid: String,
        callerNumber: String,
        transcript: String,
        popupUrl: String = ""
    ): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        val id = callSid.ifBlank { UUID.randomUUID().toString() }
        val doc = firestore.collection("calls_log").document(id)
        val now = getCurrentTimestamp()
        firestore.runTransaction { txn ->
            val snapshot = txn.get(doc)
            val existing = if (snapshot.exists()) snapshot.toObject(CallLog::class.java) else null
            val payload = linkedMapOf<String, Any?>(
                "counterpartNumber" to callerNumber,
                "direction" to "inbound",
                "transcript" to transcript,
                "twilioCallSid" to callSid,
            )
            if (popupUrl.isNotBlank()) payload["recordingUrl"] = popupUrl
            if (existing?.status.isNullOrBlank()) payload["status"] = "ringing"
            if (existing?.timestamp.isNullOrBlank()) payload["timestamp"] = now
            txn.set(doc, payload, com.google.firebase.firestore.SetOptions.merge())
        }.await()
        id
    }.onFailure { AuntieLog.e("Failed to upsert inbound call", it) }

    suspend fun createInboundVoicemailLog(
        callerNumber: String,
        transcript: String,
        audioUrl: String
    ): Result<String> = runCatching {
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
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

    /**
     * Marks a voicemail READ: the operator listened to it and is not replying
     * right now. Parity with the web admin's `markVoicemail` (React
     * `src/api/inboxChannelsWrite.ts`), which writes the same three keys.
     *
     * `repliedAt` is cleared rather than stamped, because reading is not
     * replying and a reply timestamp on a merely-heard voicemail would make the
     * field a lie. Without this action the only way off `unread` was to send a
     * text, so a voicemail that needed no answer stayed in the waiting count
     * forever.
     */
    suspend fun markVoicemailRead(voicemailId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("voicemails").document(voicemailId).update(
            mapOf(
                "replyStatus" to "read",
                "repliedAt" to "",
                "replyLogId" to ""
            )
        ).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to mark voicemail read $voicemailId", it) }

    /**
     * Marks a voicemail DISMISSED: it never needed an answer from anyone. A
     * robocall, a misdial, ten seconds of somebody's pocket.
     *
     * `dismissed` has been in `VoicemailLog.replyStatus` and in every reader on
     * both clients since launch, and until now no client could write it, so the
     * only way to clear one of these off the waiting count was to call it
     * `read` — which quietly redefines that word as "seen and ignored" for
     * every other row too. Same three keys as `markVoicemailRead`, and the same
     * blank `repliedAt`: dismissing is not replying either.
     *
     * Parity with the web admin's `markVoicemail({ status: 'dismissed' })`
     * (React `src/api/inboxChannelsWrite.ts`) and the wasm admin's
     * `FirestoreClient.markVoicemailDismissed`.
     */
    suspend fun markVoicemailDismissed(voicemailId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("voicemails").document(voicemailId).update(
            mapOf(
                "replyStatus" to "dismissed",
                "repliedAt" to "",
                "replyLogId" to ""
            )
        ).await()
        Unit
    }.onFailure { AuntieLog.e("Failed to dismiss voicemail $voicemailId", it) }

    suspend fun markVoicemailReplied(voicemailId: String, replyLogId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        firestore.collection("voicemails").get().await()
            .toObjects(VoicemailLog::class.java)
    }.onFailure { AuntieLog.e("Failed to get voicemails", it) }

    suspend fun getCalls(): Result<List<CallLog>> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("calls_log").get().await()
            .toObjects(CallLog::class.java)
    }.onFailure { AuntieLog.e("Failed to get calls", it) }

    suspend fun getSmsMessages(): Result<List<SmsMessage>> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("sms_messages").get().await()
            .toObjects(SmsMessage::class.java)
    }.onFailure { AuntieLog.e("Failed to get SMS messages", it) }

    suspend fun getEmails(): Result<List<EmailMessage>> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("emails").get().await()
            .toObjects(EmailMessage::class.java)
    }.onFailure { AuntieLog.e("Failed to get emails", it) }

    // --- Activity log (audit trail) ---

    suspend fun getActivityLog(): Result<List<com.tribetails.auntieos.data.admin.ActivityLogEntry>> = runCatching {
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
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

    // --- KinTale Templates ---

    suspend fun getKinTaleTemplates(): Result<List<KinTaleTemplate>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("kintale_templates").get().await()
        snapshot.toObjects(KinTaleTemplate::class.java)
    }.onFailure { AuntieLog.e("Failed to get KinTale templates", it) }

    suspend fun getKinTaleTemplate(templateId: String): Result<KinTaleTemplate?> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("kintale_templates").document(templateId).get().await()
        snapshot.toObject(KinTaleTemplate::class.java)
    }.onFailure { AuntieLog.e("Failed to get KinTale template $templateId", it) }

    suspend fun createKinTaleTemplate(template: KinTaleTemplate): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        val docRef = firestore.collection("kintale_templates").document()
        val ts = getCurrentTimestamp()
        docRef.set(template.copy(id = docRef.id, createdAt = ts, updatedAt = ts)).await()
        docRef.id
    }.onFailure { AuntieLog.e("Failed to create KinTale template", it) }

    /**
     * Writes ONLY the template fields that actually changed, plus the stamp.
     *
     * This replaced a whole-model `updateKinTaleTemplate(template)` whose BARE
     * `.set()` - no merge option at all - REPLACED the document. This collection
     * has already paid for that shape: `ChecklistItem.required` was stripped
     * from every template for as long as the field was missing from the Kotlin
     * model. `KinTaleTemplateDiff.kt` names the fields, their other writers, and
     * what each loss costs a person.
     *
     * MERGE IS THE LOAD-BEARING PART HERE, not the diff. Merge is the only thing
     * that can preserve a field this client cannot name, and the desktop admin's
     * `deleted` soft-delete flag is exactly that. The diff is what stops the
     * secondary loss: the React admin is a concurrent writer of the fields this
     * model DOES own, and `mytribe/functions/src/portal/getMyKinTales.ts` reads
     * `checklistItems` server-side to label the rows a kinfolk sees, so putting
     * a stale copy back deletes rows from a family's visit recap.
     *
     * `updatedAt` is STAMPED here, never round-tripped from the value that was
     * read, so it cannot freeze and lie about when the template last changed.
     *
     * An empty [changes] is a caller bug, not a no-op to absorb: such a write
     * could only move the stamp, claiming a change that never happened. The
     * ViewModel skips the call outright when the diff is empty.
     */
    suspend fun updateKinTaleTemplateFields(
        templateId: String,
        changes: Map<String, Any?>,
    ): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(templateId.isNotBlank()) { "updateKinTaleTemplateFields needs a kintale_templates document id" }
        require(changes.isNotEmpty()) { "updateKinTaleTemplateFields called with no changed fields" }
        val payload: Map<String, Any?> = changes + mapOf("updatedAt" to getCurrentTimestamp())
        firestore.collection("kintale_templates").document(templateId)
            .set(payload, com.google.firebase.firestore.SetOptions.merge())
            .await()
        Unit
    }.onFailure { AuntieLog.e("Failed to update KinTale template $templateId", it) }

    suspend fun deleteKinTaleTemplate(templateId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        firestore.collection("kintale_templates").document(templateId).delete().await()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete KinTale template $templateId", it) }

    /** Pick the best template for a service type. Falls back to the default template if no match. */
    suspend fun getActiveTemplateForService(serviceType: String): Result<KinTaleTemplate?> = runCatching {
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        val uid = auth.currentUser?.uid
            ?: throw IllegalStateException("getCurrentUserProfile called without auth uid")
        firestore.collection("users").document(uid).get().await()
            .toObject(UserProfile::class.java)
    }.onFailure { AuntieLog.e("Failed to get current user profile", it) }

    // ---- Vet clinics shared catalog (matches web `vet_clinics` collection) ----

    /** Ordered/capped exactly like the web `VET_CLINICS_QUERY` (name ascending, 500). */
    private fun vetClinicsQuery() = firestore.collection("vet_clinics").orderBy("name").limit(500)

    fun observeVetClinics(): Flow<List<VetClinic>> = observeVetClinicsOrFail().map { it.clinics }

    /**
     * One-shot catalog read, for callers that need a clinic's details once
     * rather than a live listener. Household Data uses it to resolve the
     * OPENING HOURS of the clinic a household is linked to: hours live on the
     * clinic, so the household record alone cannot answer for them.
     */
    suspend fun getVetClinicsOnce(): Result<List<VetClinic>> = runCatching {
        authGate.ensureAuthenticated()
        vetClinicsQuery().get().await().toObjects(VetClinic::class.java)
    }.onFailure { AuntieLog.e("Failed to read vet clinics", it) }

    /**
     * Same underlying `vet_clinics` listener as [observeVetClinics], but keeps a
     * load FAILURE distinguishable from a genuinely empty catalog -- exactly the
     * distinction [observeVetClinics] collapses (both become `emptyList()`),
     * which is fine for [com.tribetails.auntieos.ui.admin.VetClinicsViewModel]'s
     * settings screen (there is no household vet field there for a network blip
     * to look like it blanked). The Kinfolk edit screen's picker has that field,
     * so it uses this instead: an operator who cannot tell "no clinics on file"
     * from "the read is broken" may save a household believing there truly is no
     * vet on file, when the truth is the catalog never loaded.
     */
    fun observeVetClinicsOrFail(): Flow<VetClinicsSnapshot> = callbackFlow {
        val reg = vetClinicsQuery()
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    AuntieLog.e("observeVetClinicsOrFail failed", err)
                    trySend(VetClinicsSnapshot(failed = true))
                    return@addSnapshotListener
                }
                trySend(VetClinicsSnapshot(clinics = snap?.toObjects(VetClinic::class.java).orEmpty()))
            }
        awaitClose { reg.remove() }
    }

    /**
     * Add a clinic to the shared catalog through the deployed `submitVetClinic`
     * callable rather than a direct `vet_clinics` write.
     *
     * The rules would permit the direct write (`write: if isAuntie()`), and this
     * used to do exactly that. The callable is preferred because it already owns
     * the piece a client cannot: it dedupes on a NORMALIZED clinic name and
     * returns the EXISTING id on a match, which is what keeps three spellings of
     * one hospital out of a bank shared with the kinfolk portal. A direct write
     * reimplements that check on the client, where it races and drifts. Kinfolk
     * submissions already flow through this callable; sending the admin's
     * through it too means one dedupe rule for the whole product.
     *
     * A staff caller lands `verified: true` server-side (RULING O-6 `isStaff`),
     * so a clinic the operator adds is live for households immediately rather
     * than queued for the operator's own approval.
     *
     * Returns the clinic id, whether newly created or matched.
     */
    suspend fun submitVetClinic(clinic: VetClinic): Result<String> =
        submitVetClinicDetailed(clinic).map { it.clinicId }

    /**
     * Same call as [submitVetClinic], but keeps the whole callable response.
     *
     * A NEAR MATCH IS A CHOICE, NOT A SUBSTITUTION (operator ruling
     * 2026-08-01). The callable used to return the id of a clinic already in
     * the bank; it now returns `status: "needs_choice"` with `candidates` and
     * writes NOTHING, so the caller must show them and let the user decide.
     *
     * [acknowledgedMatchIds] echoes back the ids the caller was just shown, and
     * is what authorizes creating over the top of a match. It is deliberately
     * not a boolean: a boolean could be sent by a client that rendered nothing,
     * whereas these ids can only have come from the previous response.
     */
    suspend fun submitVetClinicDetailed(
        clinic: VetClinic,
        acknowledgedMatchIds: List<String> = emptyList(),
    ): Result<SubmitVetClinicResult> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("submitVetClinic")
            .call(
                mapOf(
                    "name" to clinic.name.trim(),
                    "phone" to clinic.phone.trim(),
                    "address" to clinic.address.trim(),
                    "website" to clinic.website.trim(),
                    "isEmergency" to clinic.isEmergency,
                    "acknowledgedMatchIds" to acknowledgedMatchIds,
                )
            )
            .awaitCallable().data as? Map<String, Any?>
            ?: error("submitVetClinic: non-map payload")
        val status = (raw["status"] as? String).orEmpty()
        @Suppress("UNCHECKED_CAST")
        val candidates = (raw["candidates"] as? List<Map<String, Any?>>).orEmpty().map { c ->
            VetClinicCandidate(
                id = (c["id"] as? String).orEmpty(),
                name = (c["name"] as? String).orEmpty(),
                address = (c["address"] as? String).orEmpty(),
                phone = (c["phone"] as? String).orEmpty(),
                isEmergency = c["isEmergency"] as? Boolean ?: false,
                verified = c["verified"] as? Boolean ?: true,
            )
        }
        if (status == "needs_choice") {
            // No id, and that is correct: nothing was written. Erroring on the
            // blank id here (as the old parser did) would turn a question into
            // a failure and hide the choice from the operator entirely.
            return@runCatching SubmitVetClinicResult(
                clinicId = "",
                created = false,
                pending = false,
                needsChoice = true,
                candidates = candidates,
            )
        }
        val clinicId = (raw["clinicId"] as? String).orEmpty().ifBlank { error("submitVetClinic: no clinicId") }
        SubmitVetClinicResult(
            clinicId = clinicId,
            created = raw["created"] as? Boolean ?: true,
            pending = raw["pending"] as? Boolean ?: false,
            needsChoice = false,
            candidates = emptyList(),
        )
    }.onFailure { AuntieLog.e("Failed to submit vet clinic", it) }

    // ---- Mapbox Search Box, proxied (no Mapbox key ships in this app) ----

    /**
     * Address suggestions via the deployed `mapboxSearch` callable, which holds
     * MAPBOX_ACCESS_TOKEN as a Functions secret. See [MapboxClient] for the
     * session-token billing rule callers must honor.
     */
    suspend fun mapboxSuggest(
        query: String,
        sessionToken: String,
        limit: Int = 5,
    ): Result<List<com.tribetails.auntieos.data.api.MapboxSuggestion>> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("mapboxSearch")
            .call(
                mapOf(
                    "query" to query,
                    "sessionToken" to sessionToken,
                    "limit" to limit,
                    // One metro. Unfiltered results put a same-named street in
                    // another country at the top of the list.
                    "country" to "us",
                )
            )
            .awaitCallable().data as? Map<String, Any?>
            ?: error("mapboxSearch: non-map payload")
        (raw["suggestions"] as? List<*>).orEmpty().mapNotNull { row ->
            val o = row as? Map<*, *> ?: return@mapNotNull null
            com.tribetails.auntieos.data.api.MapboxSuggestion(
                name = (o["name"] as? String).orEmpty(),
                fullAddress = (o["full_address"] as? String).orEmpty(),
                mapboxId = (o["mapbox_id"] as? String).orEmpty(),
                placeFormatted = (o["place_formatted"] as? String).orEmpty(),
            )
        }
    }.onFailure { AuntieLog.e("mapboxSearch failed", it) }

    /**
     * Resolve a picked suggestion via `mapboxRetrieve`. Must carry the SAME
     * session token the suggests used, or Mapbox bills a second session.
     *
     * A feature with no usable address FAILS rather than resolving to blank:
     * writing an empty string back would erase the address the operator typed.
     */
    suspend fun mapboxRetrieve(
        mapboxId: String,
        sessionToken: String,
    ): Result<com.tribetails.auntieos.data.api.MapboxFeature> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("mapboxRetrieve")
            .call(mapOf("mapboxId" to mapboxId, "sessionToken" to sessionToken))
            .awaitCallable().data as? Map<String, Any?>
            ?: error("mapboxRetrieve: non-map payload")
        val feature = raw["feature"] as? Map<*, *> ?: error("Mapbox returned no address for that suggestion.")
        val props = feature["properties"] as? Map<*, *>
        val geometry = feature["geometry"] as? Map<*, *>
        val coords = geometry?.get("coordinates") as? List<*>
        val parsed = com.tribetails.auntieos.data.api.MapboxFeature(
            name = (props?.get("name") as? String).orEmpty(),
            fullAddress = (props?.get("full_address") as? String).orEmpty(),
            placeFormatted = (props?.get("place_formatted") as? String).orEmpty(),
            longitude = (coords?.getOrNull(0) as? Number)?.toDouble() ?: 0.0,
            latitude = (coords?.getOrNull(1) as? Number)?.toDouble() ?: 0.0,
        )
        if (parsed.resolvedAddress.isBlank()) error("Mapbox returned no address for that suggestion.")
        parsed
    }.onFailure { AuntieLog.e("mapboxRetrieve failed", it) }

    /**
     * Walk the activity_log SHA-256 hash chain server-side via the deployed
     * `verifyActivityLogChain` admin callable and return the integrity verdict
     * (parity with web FirestoreClient.verifyActivityLogChain). Result `.data` is
     * a Map; numbers may arrive as Int/Long/Double, so reads go through Number.
     */
    suspend fun verifyActivityLogChain(): Result<com.tribetails.auntieos.data.admin.ChainVerifyResult> = runCatching {
        authGate.ensureAuthenticated()
        val res = functions.getHttpsCallable("verifyActivityLogChain").call(emptyMap<String, Any?>()).awaitCallable()
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

    /**
     * Correct a clinic in the shared catalog, through the `updateVetClinic`
     * callable (punchlist B4).
     *
     * This WAS a direct `firestore.collection("vet_clinics").set(clinic)`. That
     * write is now refused by `firestore.rules` (`allow write: if false`), and
     * closing it was the point: the direct path had no validation, no check
     * against the normalized-name dedupe that `submitVetClinic` enforces on
     * create, and no audit entry, on a catalog shared with the kinfolk portal.
     *
     * It also could not do the thing that makes correcting a clinic worth
     * anything. A household stores the clinic's name, phone and address
     * denormalized beside `vetClinicId`, so fixing the catalog row alone left
     * every household still holding the wrong number. The callable rewrites
     * those copies in the same call and returns how many it reached, which is
     * why this returns a count rather than Unit.
     *
     * WHOLE-RECORD SAVE: an omitted field is CLEARED server-side. The panel
     * seeds its form from the current row and sends every field back, so
     * clearing a wrong address works.
     */
    suspend fun updateVetClinic(clinic: VetClinic): Result<Int> = runCatching {
        authGate.ensureAuthenticated()
        require(clinic.id.isNotBlank()) { "VetClinic.id is required to update." }
        val payload = mutableMapOf<String, Any?>(
            "clinicId" to clinic.id.trim(),
            "name" to clinic.name.trim(),
            "phone" to clinic.phone.trim(),
            "address" to clinic.address.trim(),
            "website" to clinic.website.trim(),
            "hours" to clinic.hours.trim(),
            "notes" to clinic.notes.trim(),
            "isEmergency" to clinic.isEmergency,
        )
        // `verified` is sent ONLY when approving. Omitted leaves the stored
        // approval state alone, so an ordinary edit of a pending row cannot
        // silently publish it to every household.
        if (clinic.verified) payload["verified"] = true
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("updateVetClinic")
            .call(payload)
            .awaitCallable().data as? Map<String, Any?>
            ?: error("updateVetClinic: non-map payload")
        (raw["householdsUpdated"] as? Number)?.toInt() ?: 0
    }.onFailure { AuntieLog.e("Failed to update vet clinic", it) }

    /**
     * Retire a clinic from the shared catalog, or restore it, through the
     * `archiveVetClinic` callable.
     *
     * REPLACES A HARD DELETE. This was `.document(id).delete()`. Households
     * point at a clinic by id, Firestore has no referential integrity, and
     * nothing in this repo sweeps for orphans, so deleting the row (1) dropped
     * those households out of `updateVetClinic`'s fan-out permanently, so their
     * vet could never be corrected in bulk again, and (2) destroyed the record
     * of what households had been told to dial.
     *
     * Archiving touches no household. Their stored name, phone and address stay
     * exactly as they were, so tidying the catalog never blanks a number at a
     * doorstep. Returns how many households still reference the clinic.
     */
    suspend fun archiveVetClinic(id: String, archived: Boolean): Result<Int> = runCatching {
        authGate.ensureAuthenticated()
        require(id.isNotBlank()) { "VetClinic id is required to archive." }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("archiveVetClinic")
            .call(mapOf("clinicId" to id.trim(), "archived" to archived))
            .awaitCallable().data as? Map<String, Any?>
            ?: error("archiveVetClinic: non-map payload")
        (raw["householdCount"] as? Number)?.toInt() ?: 0
    }.onFailure { AuntieLog.e("Failed to archive vet clinic", it) }

    /**
     * Saves the operator's own `users/{uid}` profile.
     *
     * [loaded] is the document as Firestore handed it over, or null when there
     * is none yet, and that distinction picks the write:
     *
     * NULL, so the document does not exist: a whole-model write is correct, and
     * correct only here. There is nothing to clobber and none of
     * [USER_PROFILE_SERVER_WRITTEN] exists to delete.
     *
     * NON-NULL: writes ONLY the fields that changed, plus the stamp, under
     * merge. This replaced a BARE `.set(profile)` - no merge option, so the
     * write REPLACED the document and deleted `dashboardWidgetsUpdatedAt`, which
     * the `saveDashboardLayout` callable stamps and this model has never
     * declared. `UserProfileDiff.kt` names the three writers of this document
     * and what the whole-model write cost each of them.
     *
     * Merge is the load-bearing half: it is the only thing that can preserve a
     * field the client cannot name. The diff closes the second loss, the one
     * `merge()` alone would leave open: the profile this screen read minutes ago
     * carries a stale `dashboardWidgets` and stale display fields, and writing
     * them back reverted the layout the operator arranged on the web and the
     * six fields the React account editor patches.
     *
     * `updatedAt` is STAMPED here, never round-tripped from the value that was
     * read (the rule [updateHouseholdFields] and [updateBusinessSettingsFields]
     * follow). ISO-8601 String, matching what this app has always written;
     * `setMediaProfilePhoto` merges a `serverTimestamp` into the same field,
     * which is why [UserProfile.updatedAt] is held raw and read through
     * `updatedAtIso()`.
     *
     * Nothing changed means nothing is written, not even the stamp: such a write
     * could only claim an edit that never happened. That is reported as success,
     * because from the caller's side the profile does now hold what they asked
     * for - unlike the diff-empty cases elsewhere, this one is reachable by an
     * operator pressing Save on an untouched form rather than only by a bug.
     */
    suspend fun saveUserProfile(loaded: UserProfile?, edited: UserProfile): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(edited.uid.isNotBlank()) { "UserProfile.uid is required to save." }
        val ts = getCurrentTimestamp()
        val docRef = firestore.collection("users").document(edited.uid)

        if (loaded == null) {
            docRef.set(
                edited.copy(
                    id = edited.uid,
                    updatedAt = ts,
                    createdAt = edited.createdAtIso().ifBlank { ts },
                )
            ).await()
            AuntieLog.d("Created user profile ${edited.uid}")
            return@runCatching
        }

        val changes = userProfileFieldChanges(loaded, edited)
        if (changes.isEmpty()) {
            AuntieLog.d("User profile ${edited.uid} unchanged; nothing written")
            return@runCatching
        }
        val payload: Map<String, Any?> = changes + mapOf("updatedAt" to ts)
        docRef.set(payload, com.google.firebase.firestore.SetOptions.merge()).await()
        AuntieLog.d("User profile ${edited.uid} updated: ${changes.keys.joinToString()}")
    }.onFailure { AuntieLog.e("Failed to save user profile ${edited.uid}", it) }

    /**
     * 17.3 Dashboard: persist THIS operator's Home widget layout, and nothing else.
     *
     * Deliberately not [saveUserProfile]. That writes the WHOLE users/{uid} document,
     * so a caller has to re-read the profile first and hope no other screen saved a
     * theme or nav pref in the gap. The saveDashboardLayout callable writes the one
     * field it owns with merge, validates the token shape server-side, and takes the
     * uid from req.auth, so there is no read before the write and nothing to clobber.
     * Same callable and same field the React admin writes, so a board arranged here
     * opens arranged there (mytribe/functions/src/admin/saveDashboardLayout.ts).
     *
     * Returns the tokens the SERVER stored so the caller can reconcile the board
     * against what actually landed instead of trusting its own optimistic copy. A
     * reply without them is a failure: a save that cannot be confirmed is not a save.
     */
    suspend fun saveDashboardLayout(tokens: List<String>): Result<List<String>> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("saveDashboardLayout")
            .call(mapOf("tokens" to tokens)).awaitCallable().data as? Map<String, Any?>
            ?: error("saveDashboardLayout: non-map payload")
        val stored = raw["tokens"] as? List<*>
            ?: error("saveDashboardLayout answered without the stored layout, so the save cannot be confirmed.")
        stored.mapNotNull { it as? String }
    }.onFailure { AuntieLog.e("saveDashboardLayout failed", it) }

    // ───────────────────────────────────────────────────────────────────────
    // FormSchemas - admin authoring surface for kinfolk-facing dynamic forms.
    // Backed by `saveFormSchema | listFormSchemas | deleteFormSchema` callables
    // and the `formSchemas/{schemaId}` Firestore collection. Server gates auth
    // via `isAuntieOperator`; client validation lives in FormSchemaValidator.
    // ───────────────────────────────────────────────────────────────────────

    suspend fun listFormSchemas(): Result<List<FormSchemaSummary>> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listFormSchemas")
            .call(emptyMap<String, Any>())
            .awaitCallable().data as? Map<String, Any?>
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
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getFeatureFlags")
            .call(emptyMap<String, Any>())
            .awaitCallable().data as? Map<String, Any?>
            ?: error("getFeatureFlags: non-map payload")
        val flags = (raw["flags"] as? Map<*, *>).orEmpty()
        flags.entries.mapNotNull { (k, v) ->
            val key = k as? String ?: return@mapNotNull null
            val b = v as? Boolean ?: return@mapNotNull null
            key to b
        }.toMap()
    }.onFailure { AuntieLog.e("Failed to get feature flags", it) }

    suspend fun setFeatureFlags(flags: Map<String, Boolean>): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(flags.isNotEmpty()) { "setFeatureFlags: empty flag map" }
        functions.getHttpsCallable("setFeatureFlags")
            .call(mapOf("flags" to flags))
            .awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("Failed to set feature flags", it) }

    // ───────────────────────────────────────────────────────────────────────
    // Phase 15.2 - business notification overrides (type x channel matrix).
    // Shares the businessSettings/notifications doc + catalog with web via the
    // getBusinessNotificationOverrides / save / delete callables (admin-gated).
    // ───────────────────────────────────────────────────────────────────────

    suspend fun getBusinessNotificationOverrides(): Result<NotificationMatrix> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getBusinessNotificationOverrides")
            .call(emptyMap<String, Any>())
            .awaitCallable().data as? Map<String, Any?>
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
            // #396: who receives it, what fires it, which template renders it,
            // and the mail this gate does NOT govern. Every field defaults to
            // empty, so a build talking to functions that predate the
            // projection still parses and simply shows nothing.
            ungated = ungatedSendsFromRaw(raw["ungated"]),
            businessAdminCount = (raw["businessAdminCount"] as? Number)?.toInt(),
            businessAdminRosterPath = raw["businessAdminRosterPath"] as? String ?: "",
            updatedAtMs = (raw["updatedAtMs"] as? Number)?.toLong(),
        )
    }.onFailure { AuntieLog.e("Failed to load notification overrides", it) }
    /**
     * #396: the last few real sends of one catalog key, or of every key when
     * [key] is null.
     *
     * The first reader `notificationDispatch` has ever had on this client. It
     * reports what the pipeline recorded and nothing more: "sent" means a
     * provider accepted the message, not that it arrived, because no webhook in
     * the platform writes a receipt back to a notification's channel subdoc.
     */
    suspend fun listNotificationDeliveries(
        key: String? = null,
        limit: Int = 10,
    ): Result<NotificationDeliveryEvidence> = runCatching {
        authGate.ensureAuthenticated()
        val args = buildMap<String, Any> {
            key?.takeIf { it.isNotBlank() }?.let { put("key", it) }
            put("limit", limit)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listNotificationDeliveries")
            .call(args)
            .awaitCallable().data as? Map<String, Any?>
            ?: error("listNotificationDeliveries: non-map payload")
        notificationDeliveryEvidenceFromMap(raw)
    }.onFailure { AuntieLog.e("Failed to load notification deliveries", it) }

    /**
     * WHO "every business admin" is, by name (issue #450).
     *
     * Loaded per opened gate row rather than with the matrix: it is one extra
     * read, and it is only worth making for a row that actually reaches
     * business admins and that somebody opened.
     *
     * The callable is READ ONLY. It walks the server's recipient order without
     * the dispatch path's self-heal write, so opening the gate cannot change
     * who receives business mail. Editing the roster is `setBusinessAdmins`.
     */
    suspend fun listBusinessAdmins(): Result<BusinessAdminRoster> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listBusinessAdmins")
            .call(emptyMap<String, Any>())
            .awaitCallable().data as? Map<String, Any?>
            ?: error("listBusinessAdmins: non-map payload")
        businessAdminRosterFromMap(raw)
    }.onFailure { AuntieLog.e("Failed to load the business admin roster", it) }
    suspend fun saveBusinessNotificationOverride(key: String, override: NotificationOverride): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(key.isNotBlank()) { "notification override key required" }
        // Serialization contract (only-true locks, per-stream gates, lockReason
        // empty-string-clears) lives in NotificationOverride.toCallablePayload().
        val payload = mapOf("key" to key, "override" to override.toCallablePayload())
        functions.getHttpsCallable("saveBusinessNotificationOverride").call(payload).awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("Failed to save notification override", it) }

    suspend fun deleteBusinessNotificationOverride(key: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(key.isNotBlank()) { "notification override key required" }
        functions.getHttpsCallable("deleteBusinessNotificationOverride").call(mapOf("key" to key)).awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("Failed to delete notification override", it) }

    // ───────────────────────────────────────────────────────────────────────
    // The ADMIN's OWN notification receive-prefs (staff/{uid}.notificationPrefs).
    // Mirrors the kinfolk portal prefs but for the operator; backs the admin
    // notification settings screen. getMyAdminNotificationPrefs /
    // saveMyAdminNotificationPrefs callables (admin-gated in MyTribe functions).
    // ───────────────────────────────────────────────────────────────────────

    suspend fun getMyAdminNotificationPrefs(): Result<AdminNotificationPrefs> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getMyAdminNotificationPrefs")
            .call(emptyMap<String, Any>())
            .awaitCallable().data as? Map<String, Any?>
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
        authGate.ensureAuthenticated()
        // All three maps, always, empty ones as {}. The handler writes this subtree
        // with mergeFields (functions/src/notifications/prefsSchema.ts), so a top-level
        // map left OUT here is DELETED on the server rather than left alone the way it
        // was under merge. Omitting an empty byCategory would wipe whatever another
        // device had put there.
        val prefsMap = mapOf<String, Any>(
            "byKey" to prefs.byKey,
            "byCategory" to prefs.byCategory,
            "marketingOptIn" to prefs.marketingOptIn,
        )
        functions.getHttpsCallable("saveMyAdminNotificationPrefs").call(mapOf("prefs" to prefsMap)).awaitCallable()
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
        authGate.ensureAuthenticated()
        require(id.isNotBlank()) { "FormSchema id required" }
        val snap = firestore.collection("formSchemas").document(id).get().await()
        if (!snap.exists()) return@runCatching null
        val data = snap.data ?: return@runCatching null
        formSchemaFromMap(snap.id, data)
    }.onFailure { AuntieLog.e("Failed to get form schema $id", it) }

    suspend fun saveFormSchema(schema: FormSchema): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(schema.id.isNotBlank()) { "FormSchema.id required" }
        val payload = mapOf("schema" to formSchemaToMap(schema))
        functions.getHttpsCallable("saveFormSchema").call(payload).awaitCallable()
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
        authGate.ensureAuthenticated()
        require(id.isNotBlank()) { "FormSchema id required" }
        functions.getHttpsCallable("deleteFormSchema")
            .call(mapOf("id" to id))
            .awaitCallable()
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
        authGate.ensureAuthenticated()
        functions.getHttpsCallable("setMediaProfilePhoto")
            .call(mapOf(
                "mediaFileId" to mediaFileId,
                "entityType" to entityType.name,
                "entityId" to entityId,
            ))
            .awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("setMediaProfilePhoto failed for $mediaFileId", it) }

    /**
     * 1G: approve/cancel a whole booking series (parent envelope + all child
     * visits). Returns the full [ManageSeriesResult] so the caller can fail loud
     * on a partial failure (failedVisits > 0).
     *
     * DRIFT FIX (ADR-0003 follow-up): `ok`, `action` and `batchId` used to be
     * decoded off the raw map and then never looked at again; this used to
     * also throw specifically when `affectedVisits` was absent. Both are
     * replaced by the generated fail-soft decoder plus explicit checks below,
     * the same posture every other generated decoder in this app takes (see
     * ADR-0001): `ok` is checked (`false` fails the call, same as
     * [KinCareRepository.rescheduleBooking]); `action`/`batchId` are verified
     * to echo what was sent, since that echo is the only thing that tells this
     * repository a response belongs to the request it just made. The server's
     * OWN `Result` schema still requires `affectedVisits`
     * (`admin/manageBookingSeries.ts`) and logs+alerts server-side
     * (`callable.response.contractViolation`) on any response that ships
     * without it, so a client-side throw on that one field bought nothing a
     * write that already committed needed.
     */
    suspend fun manageBookingSeries(action: String, kinfolkId: String, batchId: String): Result<ManageSeriesResult> = runCatching {
        authGate.ensureAuthenticated()
        val args = ManageBookingSeriesArgs(action = action, kinfolkId = kinfolkId, batchId = batchId)
        val raw = functions.getHttpsCallable("manageBookingSeries").call(args.toPayload()).awaitCallable().data
        @Suppress("UNCHECKED_CAST")
        val result = decodeManageBookingSeriesResult(raw as? Map<String, Any?>)
        check(result.ok) { "manageBookingSeries did not confirm the $action (ok=false) for series $batchId" }
        check(result.action == action) {
            "manageBookingSeries confirmed action '${result.action}' but '$action' was requested"
        }
        check(result.batchId == batchId) {
            "manageBookingSeries confirmed a different series (${result.batchId}) than requested ($batchId)"
        }
        ManageSeriesResult(
            affectedVisits = result.affectedVisits.toInt(),
            failedVisits = result.failedVisits.toInt(),
            sessionsCreated = result.sessionsCreated.toInt(),
            // #536: what the household actually heard, carried through rather
            // than inferred from a clean result. See ManageSeriesResult.
            householdNotified = result.householdNotified,
            newlyConfirmed = result.newlyConfirmed.toInt(),
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
        authGate.ensureAuthenticated()
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
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("recap_recent_comms")
            .call(mapOf("kinfolkId" to kinfolkId))
            .awaitCallable().data as? Map<*, *>
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
    /**
     * True only when the server really wrote an outbound row into `sms_messages`,
     * so the Inbox thread now shows this reply. Requesting the mirror does not
     * make it true: the server refuses unless the number is already a known
     * channel counterpart, because that row holds the number in the clear while
     * everything else this callable writes holds it redacted. Defaults false,
     * which is also how an older deployed function that omits the field reads.
     */
    val mirrored: Boolean = false,
    /**
     * Why no row was written: `not_requested`, `no_existing_thread` or
     * `write_failed`. Empty when [mirrored] is true. A code, never message text,
     * so a caller branches on it rather than on wording.
     */
    val mirrorSkippedReason: String = "",
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
    // Believed only on a literal `true`. Anything else, including the field being
    // absent because the deployed function predates it, means no row was written,
    // and the UI must keep telling the operator the reply is not in the list.
    val mirrored = raw?.get("mirrored") == true
    val mirrorSkippedReason = if (mirrored) "" else (raw?.get("mirrorSkippedReason") as? String).orEmpty()
    return ExternalSendResult(
        channel = channel,
        providerMessageId = providerMessageId,
        recipientRedacted = recipientRedacted,
        mirrored = mirrored,
        mirrorSkippedReason = mirrorSkippedReason,
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
 * Decode of the batchUpdateBookings callable payload into [BatchBookingResult],
 * delegating to the generated `decodeBatchUpdateBookingsResult`
 * (ADR-0003 follow-up) rather than re-parsing the raw map by hand. [BatchBookingResult]
 * stays a distinct, app-facing type (its `failedCount` convenience getter has
 * callers this generated type does not need to know about), but nothing here
 * re-derives a cast or a fallback the generated decoder already gets right.
 *
 * Two things this wrapper still does that the generated decoder alone would
 * not: the echoed `action` falls back to the requested [requestedAction] when
 * the server's is blank (a resilience carve predating the generated decoder,
 * kept because REJECT/CANCEL currently share one stored status server-side and
 * a caller branching on `action` needs its own request echoed if the server
 * ever regresses on this), and a failure entry with no `id` is dropped rather
 * than kept as an empty string, because an id the operator never sees is an id
 * they cannot act on.
 */
internal fun decodeBatchBookingResult(raw: Map<String, Any?>?, requestedAction: String): BatchBookingResult {
    val generated = decodeBatchUpdateBookingsResult(raw)
    val action = generated.action.ifBlank { requestedAction }
    val failed = generated.failed
        .filter { it.id.isNotBlank() }
        .map { BatchBookingFailure(id = it.id, error = it.error) }
    return BatchBookingResult(action = action, updated = generated.updated.toInt(), failed = failed)
}

