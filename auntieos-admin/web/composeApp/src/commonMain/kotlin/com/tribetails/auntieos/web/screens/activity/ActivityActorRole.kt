package com.tribetails.auntieos.web.screens.activity

import com.tribetails.auntieos.web.data.ActivityLogEntry
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/** The owner, in the word the admin web header uses for that account. */
internal const val OWNER_ROLE_LABEL = "Operator"

/** A caretaker, in the word the admin web header uses for that account. */
internal const val AUNTIE_ROLE_LABEL = "Auntie"

/**
 * The audit trail's stored actor role in words. The server writes `AUNTIE` for
 * every staff caller, the owner included, so on its own it reads "Staff";
 * PRIMARY and SECONDARY are the household's Kinfolk. Blank stays blank. The
 * same table as the admin web's `actorRoleLabel` and Android's.
 */
internal fun actorRoleLabel(role: String): String = when (val key = role.trim().uppercase()) {
    "" -> ""
    "AUNTIE" -> "Staff"
    "PRIMARY" -> "Primary kinfolk"
    "SECONDARY" -> "Secondary kinfolk"
    "SYSTEM" -> "System"
    else -> key.lowercase().split('_', ' ').filter { it.isNotEmpty() }.joinToString(" ")
        .replaceFirstChar { it.uppercaseChar() }
}

/**
 * The role an entry's actor held (#1820): "Operator" for the owner, "Auntie"
 * for a caretaker. Mirrors `actorRoleFor` in the admin web's
 * `lib/activityDetail.ts` and Android's `OperatorWords.kt`; change all three
 * together.
 *
 * The stored role cannot say that on its own. The server files the owner and a
 * caretaker under one value, and until #1820 every line a client asked for was
 * stored as PRIMARY, so the owner's clock taps read "Primary kinfolk". Three
 * sources, in order:
 *
 *   1. What the server stamped on the entry when it wrote it (`payload.admin`,
 *      `payload.staffRole`), on a staff entry. The role held at the time wins.
 *   2. The staff roster ([roles], uid -> "owner" | "auntie"), whatever role is
 *      stored. This corrects the entries already stored with the wrong role.
 *   3. The stored role, through [actorRoleLabel].
 *
 * A System entry is never relabelled, and an actor the roster does not hold
 * keeps the stored role. Display only: the entry is sealed and never rewritten.
 */
internal fun actorRoleFor(
    storedRole: String,
    actorId: String,
    payload: JsonElement? = null,
    roles: Map<String, String> = emptyMap(),
): String {
    val stored = storedRole.trim().uppercase()
    if (stored == "SYSTEM") return actorRoleLabel(stored)
    if (stored == "AUNTIE") {
        val facts = payload as? JsonObject
        if ((facts?.get("staffRole") as? JsonPrimitive)?.contentOrNull == "auntie") return AUNTIE_ROLE_LABEL
        if ((facts?.get("admin") as? JsonPrimitive)?.booleanOrNull == true) return OWNER_ROLE_LABEL
    }
    return when (roles[actorId.trim()]) {
        "owner" -> OWNER_ROLE_LABEL
        "auntie" -> AUNTIE_ROLE_LABEL
        else -> actorRoleLabel(stored)
    }
}

/** [actorRoleFor] for one entry. */
internal fun actorRoleFor(entry: ActivityLogEntry, roles: Map<String, String> = emptyMap()): String =
    actorRoleFor(entry.actorRole, entry.actorId, entry.payload, roles)
