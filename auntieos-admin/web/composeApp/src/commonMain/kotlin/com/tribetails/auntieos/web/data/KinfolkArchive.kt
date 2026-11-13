package com.tribetails.auntieos.web.data

/**
 * #2161, operator ruling 2026-11-13: only the owner archives or restores a
 * Kinfolk household. The server enforces it (the owner-only
 * `setKinfolkArchived` callable, and rules that refuse a direct change to the
 * archive fields). Admin web (`api/kinfolkProfileWrite.ts`) and Android
 * (`ui/directory/KinfolkArchiveAccess.kt`) show the same sentence.
 */
const val KINFOLK_ARCHIVE_OWNER_ONLY = "Only the owner can archive or restore a Kinfolk household."

/** What the server gate says when it refuses a caller who is not the owner. */
private const val GATE_REFUSAL = "Admin claim required."

/**
 * The console's REST callable client hands back the refusal's message without
 * its code, so the gate's own words (and the plain permission sentence the
 * shared rule turns a bare code into) are read as the refusal. Any other
 * message is the server's or the transport's and is kept.
 */
fun kinfolkArchiveRefusalText(message: String): String {
    val text = message.trim()
    return if (text == GATE_REFUSAL || text == plainCallableMessage("PERMISSION_DENIED", "")) KINFOLK_ARCHIVE_OWNER_ONLY else message
}

/**
 * Whether this console session is offered Archive / Restore on a household. A
 * sandbox test admin is not: the server refuses it the callable. The console
 * admits only the owner's `admin` claim otherwise, so that is the owner.
 */
fun kinfolkArchiveOffered(testMode: TestMode): Boolean = !testMode.active
