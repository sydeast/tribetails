package com.tribetails.auntieos.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.util.AuntieLog

/**
 * Household members and invites. (B1)
 *
 * Five callables, four of which had no caller on either client until now:
 * `listMembers` (portal, admin-or-primary), and the admin-gated `listInvites`,
 * `mintInvite`, `revokeInvite`, `setMemberPermissions` and `removeMember`.
 * Their request and response shapes are written down in
 * `mytribe/functions/CALLABLE_CONTRACT.md` under "Household members and
 * invites", and the React mirror is `auntieos-admin/src/api/members.ts` +
 * `membersWrite.ts`. The three files have to move together.
 *
 * NOT HERE, ON PURPOSE: `inviteKinfolkToPortal`. It already ships on this
 * client as [AuntieRepository.inviteKinfolkToPortal], driven by the button on
 * the household profile that this screen is opened from. A second identical
 * button one tap away would be duplication, not coverage.
 *
 * THE DECODE IS FAIL-SOFT PER FIELD, NOT PER RESPONSE, matching
 * [IntegrationsRepository]: a non-map payload or a missing top-level array is
 * an error, because there is nothing to show and a blank list would read as
 * "this household has nobody". But an unknown `role` or `status` string decodes
 * to the conservative member of its closed set rather than dropping the row: an
 * older APK meeting a newer server must degrade on one field, not lose a member
 * it is being asked to manage.
 *
 * `effectiveStatus` and `redeemable`, not `status`, decide what an invite looks
 * like. `expireStaleInvites` sweeps at 02:00, so a lapsed invite still READS as
 * EMAIL_SENT in Firestore for up to a day; the server reconciles that at read
 * time and this client obeys it. `redeemable` defaults FALSE when absent,
 * because offering Revoke on an invite the server considers dead is a button
 * that fails when tapped.
 *
 * THE INVITE ID IS A BEARER TOKEN. The claim link is `?invite=<inviteId>`, so
 * the document id doubles as the secret. It is carried because `revokeInvite`
 * takes it, and it is NEVER logged here and never rendered as a URL. See
 * `mytribe/functions/src/admin/listInvites.ts`.
 */
class MembersRepository(
    // A PROVIDER, resolved lazily, not a `FirebaseFunctions` default argument:
    // a default argument is evaluated at construction, so `getInstance` would
    // run inside every JVM test that builds a ViewModel holding this repo and
    // throw "Default FirebaseApp is not initialized". Same reasoning as
    // IntegrationsRepository.
    functionsProvider: () -> FirebaseFunctions = { FirebaseFunctions.getInstance("us-central1") },
    private val authGate: AuthGate = AuthGate.shared,
) {
    private val functions by lazy(functionsProvider)

    // ── models ──────────────────────────────────────────────────────────────

    enum class MemberRole { PRIMARY, SECONDARY }

    enum class MemberStatus { INVITED, ACTIVE, SUSPENDED }

    enum class InviteStatus { PENDING, EMAIL_SENT, ACCEPTED, REVOKED, EXPIRED }

    /** Mirrors `MemberPermissions` in `mytribe/functions/src/lib/schema.ts`. */
    data class MemberPermissions(
        val billingFull: Boolean = false,
        val messagingDirect: Boolean = false,
        val messagingGroup: Boolean = false,
        val kinEdit: Boolean = false,
        val kintalesOnly: Boolean = false,
        val homeAccess: Boolean = false,
    )

    data class Member(
        val uid: String,
        val secondaryLabel: String?,
        val role: MemberRole,
        val status: MemberStatus,
        val permissions: MemberPermissions,
        val invitedEmail: String?,
    ) {
        /** Never blank: email, then label, then the uid. */
        val label: String
            get() = invitedEmail?.ifBlank { null } ?: secondaryLabel?.ifBlank { null } ?: uid
    }

    data class Invite(
        val inviteId: String,
        val invitedEmail: String,
        val secondaryLabel: String?,
        val proposedRole: MemberRole,
        /** Exactly what the document says, unreconciled. */
        val status: InviteStatus,
        /** [status], except a lapsed PENDING/EMAIL_SENT reads EXPIRED. */
        val effectiveStatus: InviteStatus,
        /** True only when `acceptInvite` would still accept this invite today. */
        val redeemable: Boolean,
        // `requiresAuntieAck` used to live here. The server set it true only when
        // an invite carried billing_full, and nothing ever acknowledged it or
        // gated on it. Per the operator ruling a household PRIMARY may grant a
        // SECONDARY any permission except admin, billing included, so there is no
        // acknowledgement to render. `listInvites` no longer returns the field.
        /** ISO-8601 or null. Null means the server had nothing, not "today". */
        val createdAt: String?,
        val sentToInviteeAt: String?,
        val expiresAt: String?,
        val revokedAt: String?,
    )

    /**
     * One [Invite] plus the household it belongs to, as `listAllInvites`
     * returns it.
     *
     * COMPOSITION, not a parallel data class: the wire row IS `listInvites`'s
     * row (the callable imports the projection from its sibling), and copying
     * fourteen fields into a second shape is how two mirrors drift. Kotlin data
     * classes cannot inherit, so this says what it means — the same invite,
     * seen from outside its household.
     *
     * `householdName` is computed SERVER-side and is never blank. An unnameable
     * household arrives as `(household not found: <id>)` rather than as an
     * empty string, because that row is the one an operator most needs to see.
     */
    data class AdminInvite(
        val invite: Invite,
        /** The kinfolk / family doc id. One value, three names in this codebase. */
        val tribeId: String,
        val householdName: String,
    )

    /**
     * The five permission keys `setMemberPermissions` accepts. `kintales_only`
     * is deliberately absent: the server's argument schema does not carry it,
     * so no caller on any path can turn it off.
     */
    enum class PermissionKey(val wireName: String) {
        BILLING_FULL("billing_full"),
        MESSAGING_DIRECT("messaging_direct"),
        MESSAGING_GROUP("messaging_group"),
        KIN_EDIT("kin_edit"),
        HOME_ACCESS("home_access"),
    }

    // ── reads ───────────────────────────────────────────────────────────────

    suspend fun listMembers(kinfolkId: String): Result<List<Member>> = runCatching {
        require(kinfolkId.isNotBlank()) { "listMembers requires a household id" }
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listMembers")
            .call(mapOf("kinfolkId" to kinfolkId)).awaitCallable().data as? Map<String, Any?>
            ?: error("listMembers: non-map payload")
        decodeMembers(raw)
    }.onFailure { AuntieLog.e("MembersRepository.listMembers failed", it) }

    suspend fun listInvites(familyId: String): Result<List<Invite>> = runCatching {
        require(familyId.isNotBlank()) { "listInvites requires a household id" }
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listInvites")
            .call(mapOf("familyId" to familyId)).awaitCallable().data as? Map<String, Any?>
            ?: error("listInvites: non-map payload")
        decodeInvites(raw)
    }.onFailure { AuntieLog.e("MembersRepository.listInvites failed", it) }

    /**
     * Every invite across every household, newest first.
     *
     * `listInvites` above is scoped to one household, so "who never accepted"
     * meant opening every household by hand. This is that question in one call.
     * It takes no argument: the every-household read is what it IS, and an
     * optional filter would only be a slower way to ask the other one.
     *
     * READ ONLY, permanently. Per the invite ruling the admin's only invite is
     * inviting a PRIMARY to the portal, and both callables that do it are
     * household-scoped; the PRIMARY invites the secondary from MyTribe. There
     * is no admin-wide write to pair with this and there must never be one.
     */
    suspend fun listAllInvites(): Result<List<AdminInvite>> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listAllInvites")
            .call(emptyMap<String, Any?>()).awaitCallable().data as? Map<String, Any?>
            ?: error("listAllInvites: non-map payload")
        decodeAllInvites(raw)
    }.onFailure { AuntieLog.e("MembersRepository.listAllInvites failed", it) }

    // ── writes ──────────────────────────────────────────────────────────────

    /**
     * Mints a PRIMARY claim for this household and emails the link. Returns the
     * new invite id.
     *
     * RULING (2026-08-04): the primary kinfolk invites the secondary; the admin
     * does not, and the admin's only invite is inviting the primary to the
     * portal. So there is no role parameter, no label and no starting
     * permission set: the server writes `FULL_PERMISSIONS` because a primary's
     * entitlements come with the role, and it now REFUSES
     * `proposedRole: "SECONDARY"` rather than defaulting to it as it did. The
     * secondary is invited from MyTribe, by their own primary, through
     * `addSecondaryContact`.
     */
    suspend fun mintInvite(
        familyId: String,
        invitedEmail: String,
    ): Result<String> = runCatching {
        require(familyId.isNotBlank()) { "mintInvite requires a household id" }
        val email = invitedEmail.trim()
        require(email.isNotBlank()) { "An email address is required to send an invite." }
        // Cheap shape check only; the server's z.string().email() is the real
        // gate. This exists so an obvious typo does not cost a round trip.
        require(email.contains("@")) { "\"$email\" is not an email address." }
        authGate.ensureAuthenticated()
        val payload = mapOf(
            "familyId" to familyId,
            "invitedEmail" to email,
            // Sent explicitly though the server defaults it: this is the one
            // grant the call can make, and it should read that way here.
            "proposedRole" to MemberRole.PRIMARY.name,
        )
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("mintInvite").call(payload).awaitCallable().data
            as? Map<String, Any?> ?: error("mintInvite: non-map payload")
        raw["inviteId"] as? String ?: error("mintInvite: response carried no inviteId")
    }.onFailure { AuntieLog.e("MembersRepository.mintInvite failed", it) }

    suspend fun revokeInvite(inviteId: String): Result<Unit> = runCatching {
        require(inviteId.isNotBlank()) { "revokeInvite requires an invite id" }
        authGate.ensureAuthenticated()
        functions.getHttpsCallable("revokeInvite").call(mapOf("inviteId" to inviteId)).awaitCallable()
        Unit
    }.onFailure {
        // The id is the claim-link bearer token; the message names the callable,
        // not the invite.
        AuntieLog.e("MembersRepository.revokeInvite failed", it)
    }

    /**
     * Changes one permission flag on an existing SECONDARY.
     *
     * SECONDARY, not "member": the server answers `failed-precondition` /
     * `target not SECONDARY` for a primary target, because a primary's
     * entitlements come from the role and no enforcement path reads their
     * flags. Callers must not render a primary a toggle; this function takes no
     * role and cannot check it for them.
     *
     * One flag per call on purpose: the server audits each flag separately
     * (`billing_full` at severity `warn`), and a per-row toggle is the only
     * gesture the UI offers, so a batch API would have no caller.
     */
    suspend fun setMemberPermission(
        familyId: String,
        targetUid: String,
        key: PermissionKey,
        value: Boolean,
    ): Result<Unit> = runCatching {
        require(familyId.isNotBlank()) { "setMemberPermissions requires a household id" }
        require(targetUid.isNotBlank()) { "setMemberPermissions requires a member uid" }
        authGate.ensureAuthenticated()
        val payload = mapOf(
            "familyId" to familyId,
            "targetUid" to targetUid,
            "permissions" to mapOf(key.wireName to value),
        )
        functions.getHttpsCallable("setMemberPermissions").call(payload).awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("MembersRepository.setMemberPermissions failed", it) }

    /**
     * Removes a member. SOFT on the server: the member doc goes SUSPENDED, the
     * household id is pulled off `clients/{uid}.kinfolkIds`, and the user's
     * refresh tokens are revoked. The row stays in the roster afterwards,
     * marked Suspended, so no caller may claim the member is gone.
     */
    suspend fun removeMember(familyId: String, targetUid: String): Result<Unit> = runCatching {
        require(familyId.isNotBlank()) { "removeMember requires a household id" }
        require(targetUid.isNotBlank()) { "removeMember requires a member uid" }
        authGate.ensureAuthenticated()
        functions.getHttpsCallable("removeMember")
            .call(mapOf("familyId" to familyId, "targetUid" to targetUid)).awaitCallable()
        Unit
    }.onFailure { AuntieLog.e("MembersRepository.removeMember failed", it) }

    companion object {
        /** `INVITE_TTL_DAYS` in `mytribe/functions/src/lib/schema.ts`. */
        const val INVITE_TTL_DAYS = 14

        // SECONDARY_LABEL_MAX and DEFAULT_SECONDARY_LABEL lived here for the
        // admin invite form's label field. Both went with it: a label names a
        // secondary's place in a household, and this client no longer mints a
        // secondary invite. `Member.secondaryLabel` is still read and displayed.
    }
}

// ── pure decoders, unit-tested directly ─────────────────────────────────────

internal fun decodeMembers(raw: Map<*, *>?): List<MembersRepository.Member> {
    val rows = (raw?.get("members") as? List<*>)
        ?: error("listMembers: response carried no members")
    return rows.mapNotNull { item ->
        val m = item as? Map<*, *> ?: return@mapNotNull null
        // No uid means no member the UI could address, so the row is dropped
        // rather than rendered as an unactionable one.
        val uid = (m["uid"] as? String)?.ifBlank { null } ?: return@mapNotNull null
        MembersRepository.Member(
            uid = uid,
            secondaryLabel = (m["secondaryLabel"] as? String)?.ifBlank { null },
            role = decodeRole(m["role"]),
            status = decodeMemberStatus(m["status"]),
            permissions = decodePermissions(m["permissions"]),
            invitedEmail = (m["invitedEmail"] as? String)?.ifBlank { null },
        )
    }
}

/**
 * One invite row, or null when it carries no id and so nothing could act on it.
 *
 * Shared by both invite reads. `listAllInvites` returns the SAME row shape
 * (its callable imports `mapInviteDoc` from `listInvites`), so a second
 * hand-kept decoder would be a second place for `redeemable`'s default to drift.
 */
internal fun decodeInviteRow(m: Map<*, *>): MembersRepository.Invite? {
    val id = (m["inviteId"] as? String)?.ifBlank { null } ?: return null
    val status = decodeInviteStatus(m["status"])
    return MembersRepository.Invite(
        inviteId = id,
        invitedEmail = (m["invitedEmail"] as? String).orEmpty(),
        secondaryLabel = (m["secondaryLabel"] as? String)?.ifBlank { null },
        proposedRole = decodeRole(m["proposedRole"]),
        status = status,
        // Falls back to the raw status only when the server sent none;
        // it never re-derives expiry on the device.
        effectiveStatus = m["effectiveStatus"]?.let { decodeInviteStatus(it) } ?: status,
        // Absent reads NOT redeemable: see the class kdoc.
        redeemable = m["redeemable"] as? Boolean ?: false,
        createdAt = (m["createdAt"] as? String)?.ifBlank { null },
        sentToInviteeAt = (m["sentToInviteeAt"] as? String)?.ifBlank { null },
        expiresAt = (m["expiresAt"] as? String)?.ifBlank { null },
        revokedAt = (m["revokedAt"] as? String)?.ifBlank { null },
    )
}

internal fun decodeInvites(raw: Map<*, *>?): List<MembersRepository.Invite> {
    val rows = (raw?.get("invites") as? List<*>)
        ?: error("listInvites: response carried no invites")
    return rows.mapNotNull { item -> (item as? Map<*, *>)?.let(::decodeInviteRow) }
}

/**
 * `listAllInvites`'s rows: the same invite plus the household it belongs to.
 *
 * A missing top-level array is an ERROR, not an empty list, matching
 * [decodeInvites]: rendering "nobody has been invited" off a payload we could
 * not read is the one claim this screen must never make.
 */
internal fun decodeAllInvites(raw: Map<*, *>?): List<MembersRepository.AdminInvite> {
    val rows = (raw?.get("invites") as? List<*>)
        ?: error("listAllInvites: response carried no invites")
    return rows.mapNotNull { item ->
        val m = item as? Map<*, *> ?: return@mapNotNull null
        val invite = decodeInviteRow(m) ?: return@mapNotNull null
        val tribeId = (m["tribeId"] as? String).orEmpty()
        MembersRepository.AdminInvite(
            invite = invite,
            tribeId = tribeId,
            // The server always sends one, its own loud markers included, and
            // those pass through verbatim. This branch covers an older APK
            // meeting a payload without the field: it names what is missing,
            // rather than drawing a card with a blank heading that would read
            // as "no household".
            householdName = (m["householdName"] as? String)?.ifBlank { null }
                ?: "(household name missing: ${tribeId.ifBlank { "?" }})",
        )
    }
}

/** Unknown reads SECONDARY, the least-privileged member of the set. */
internal fun decodeRole(v: Any?): MembersRepository.MemberRole =
    if (v == "PRIMARY") MembersRepository.MemberRole.PRIMARY
    else MembersRepository.MemberRole.SECONDARY

/** Unknown reads INVITED: not yet in, rather than assumed active. */
internal fun decodeMemberStatus(v: Any?): MembersRepository.MemberStatus = when (v) {
    "ACTIVE" -> MembersRepository.MemberStatus.ACTIVE
    "SUSPENDED" -> MembersRepository.MemberStatus.SUSPENDED
    else -> MembersRepository.MemberStatus.INVITED
}

/** Unknown reads PENDING, which keeps the row visible and revocable. */
internal fun decodeInviteStatus(v: Any?): MembersRepository.InviteStatus = when (v) {
    "EMAIL_SENT" -> MembersRepository.InviteStatus.EMAIL_SENT
    "ACCEPTED" -> MembersRepository.InviteStatus.ACCEPTED
    "REVOKED" -> MembersRepository.InviteStatus.REVOKED
    "EXPIRED" -> MembersRepository.InviteStatus.EXPIRED
    else -> MembersRepository.InviteStatus.PENDING
}

/** Every absent flag reads false, so the shape is always complete. */
internal fun decodePermissions(v: Any?): MembersRepository.MemberPermissions {
    val p = v as? Map<*, *> ?: emptyMap<String, Any?>()
    fun flag(key: String) = p[key] as? Boolean ?: false
    return MembersRepository.MemberPermissions(
        billingFull = flag("billing_full"),
        messagingDirect = flag("messaging_direct"),
        messagingGroup = flag("messaging_group"),
        kinEdit = flag("kin_edit"),
        kintalesOnly = flag("kintales_only"),
        homeAccess = flag("home_access"),
    )
}

/** `2026-05-20` from an ISO-8601 string; null in, null out, never today. */
internal fun inviteDate(iso: String?): String? =
    iso?.takeIf { it.length >= 10 }?.substring(0, 10)

/**
 * A short, non-reversible handle for an invite, for matching a row against the
 * activity log. Truncated on purpose: the full id is the claim token.
 */
internal fun inviteHandle(inviteId: String): String =
    if (inviteId.length <= 8) inviteId else inviteId.take(8) + "…"
