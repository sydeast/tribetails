package com.tribetails.auntieos.data.model

/**
 * What a `users/{uid}` save is allowed to write: the fields that ACTUALLY
 * CHANGED since the document was read, and nothing else.
 *
 * `saveUserProfile` used to write the whole [UserProfile] with a BARE `.set()`,
 * no merge option, which REPLACES the document: every field not on this Kotlin
 * model was DELETED. That is a step worse than the `.set(model, merge())` shape
 * PRs #312, #315, #327 and #332 removed elsewhere, where an unmodelled field at
 * least survived.
 *
 * THREE WRITERS SHARE THIS DOCUMENT, and the other two both use merge:
 *
 *  - `auntieos-admin/src/api/accountWrite.ts` (React) patches six profile fields
 *    plus `updatedAt` with `{ merge: true }`, and says why in its own comment:
 *    its narrower model "would silently erase every field this app doesn't
 *    model" under a plain overwrite.
 *  - `mytribe/functions/src/admin/saveDashboardLayout.ts` writes
 *    `dashboardWidgets` AND [USER_PROFILE_SERVER_WRITTEN]'s
 *    `dashboardWidgetsUpdatedAt`, a `serverTimestamp` this model has never
 *    declared. The android bare set deleted it on every theme change, every
 *    nav-bar rearrangement and every avatar upload.
 *  - `mytribe/functions/src/admin/setMediaProfilePhoto.ts` merges `photoUrl` and
 *    a `serverTimestamp` `updatedAt` when an operator picks an avatar. That
 *    serverTimestamp is why [UserProfile.updatedAt] is held as a raw `Any?`.
 *
 * WHAT THAT COST A PERSON, in plain terms. An operator arranges their Home
 * dashboard on the web, then changes the app theme on their phone. The phone
 * wrote back the whole profile it had loaded, so the web layout snapped back to
 * whatever the phone last saw, and the stamp recording when the layout changed
 * was deleted outright. `AdminSettingsViewModel.saveNavConfig` already carried a
 * hand-rolled re-read to dodge exactly this, and that workaround is removed here
 * because diffing against the loaded baseline is what actually fixes it: a
 * re-read before a whole-model write still loses anything written in the gap
 * between the re-read and the save.
 */

/**
 * Fields on `users/{uid}` this client may write, keyed by Firestore field name.
 *
 * Written out by hand rather than reflected, so it survives R8 and reads as the
 * contract it is.
 *
 * `dashboardWidgets` IS here even though the `saveDashboardLayout` callable owns
 * layout writes today (`HomeViewModel` routes through the callable and its test
 * asserts this path is never used for a layout). Keeping it in the diff costs
 * nothing - no screen edits it here, so it never differs and never gets written
 * - and leaving it out would mean a future screen's layout edit silently
 * stopped saving, which is the quiet failure this whole class of fix exists to
 * remove.
 */
internal val USER_PROFILE_DIFF_FIELDS: Map<String, (UserProfile) -> Any?> =
    linkedMapOf(
        "uid" to { it.uid },
        "email" to { it.email },
        "displayName" to { it.displayName },
        "firstName" to { it.firstName },
        "lastName" to { it.lastName },
        "phone" to { it.phone },
        "title" to { it.title },
        "photoUrl" to { it.photoUrl },
        "bio" to { it.bio },
        "dashboardWidgets" to { it.dashboardWidgets },
        "navConfig" to { it.navConfig },
        "themeMode" to { it.themeMode },
        "accentColor" to { it.accentColor },
        "density" to { it.density },
        "fontScale" to { it.fontScale },
    )

/**
 * `users/{uid}` fields on this model that a save must never round-trip.
 *
 * - `id`         the document id (`@DocumentId`, never serialised anyway)
 * - `createdAt`  stamped once at create; round-tripping it is how it gets lost
 * - `updatedAt`  stamped at write time by the repository, never round-tripped
 */
internal val USER_PROFILE_SERVER_OWNED = setOf("id", "createdAt", "updatedAt")

/**
 * Fields the server writes onto `users/{uid}` that [UserProfile] does not
 * declare, and must not start declaring.
 *
 * - `dashboardWidgetsUpdatedAt`  `mytribe/functions/src/admin/saveDashboardLayout.ts`,
 *   a `FieldValue.serverTimestamp()` recording when the operator last rearranged
 *   their Home board.
 *
 * Declaring it would be the wrong fix: this client has no clock the server
 * trusts, so it could only write a client instant over a server one, or freeze
 * the value at whatever it happened to read. Only a write that cannot NAME the
 * field can be trusted not to change it, and only merge preserves a field the
 * client cannot name. `UserProfileMergeTest` pins both halves.
 */
internal val USER_PROFILE_SERVER_WRITTEN = setOf("dashboardWidgetsUpdatedAt")

/**
 * The fields [edited] changes relative to [loaded], keyed by Firestore field
 * name. Empty when nothing changed, which the caller must treat as "do not
 * write" rather than "write the stamp".
 *
 * [loaded] must be the copy Firestore handed us, never a re-read: re-reading to
 * diff would hand back exactly the concurrent edit this is protecting.
 *
 * A field cleared to blank IS a change and is written as blank. Skipping it
 * would make "remove my job title" the one edit no screen can perform.
 */
internal fun userProfileFieldChanges(
    loaded: UserProfile,
    edited: UserProfile,
): Map<String, Any?> {
    val changes = LinkedHashMap<String, Any?>()
    for ((field, read) in USER_PROFILE_DIFF_FIELDS) {
        if (read(edited) != read(loaded)) changes[field] = read(edited)
    }
    return changes
}
