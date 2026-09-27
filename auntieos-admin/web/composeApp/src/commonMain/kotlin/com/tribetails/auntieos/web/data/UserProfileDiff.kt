package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject

/**
 * #897: what a desktop save of `users/{uid}` is allowed to write. The fields that
 * changed since the profile was read, and nothing else.
 *
 * The old save serialised the whole [UserProfile] and PATCHed it with no
 * `updateMask`. That replaced the document: any field the model does not carry
 * was deleted, and when the profile read had failed the form was blank, so Save
 * wrote blanks over the operator's name, phone and the rest.
 *
 * This is the profile twin of [businessSettingsChangedFields], and works the same
 * way: both copies go through the write path's `Json`, and keys are compared one
 * by one. `_id` is the document id alias and `createdAt`/`updatedAt` are never
 * round-tripped; the save stamps its own `updatedAt` next to real changes.
 *
 * [loaded] null means the document does not exist (the read answered, and there
 * was nothing). The diff then runs against a blank [UserProfile], so only the
 * fields the operator filled in are written. It never means "the read failed":
 * a failed read never reaches a save (see ProfileLoad).
 *
 * A field cleared to blank is a change and is written as `""`.
 *
 * #994: the comparison itself is the shared [fieldChanges] (FieldChanges.kt).
 */
internal val USER_PROFILE_SERVER_OWNED: Set<String> = setOf("_id", "createdAt", "updatedAt")

internal fun userProfileChangedFields(
    loaded: UserProfile?,
    edited: UserProfile,
    codec: Json,
): Map<String, JsonElement> {
    // #994: the key-by-key comparison is the shared [fieldChanges]; no field of
    // the profile is diffed per map key, so every change is one top-level set.
    val before = codec.encodeToJsonElement(UserProfile.serializer(), loaded ?: UserProfile()).jsonObject
    val after = codec.encodeToJsonElement(UserProfile.serializer(), edited).jsonObject
    return fieldChanges(before, after, excluded = USER_PROFILE_SERVER_OWNED, perKeyMaps = emptySet())
        .associate { it.path.single() to it.value!! }
}
