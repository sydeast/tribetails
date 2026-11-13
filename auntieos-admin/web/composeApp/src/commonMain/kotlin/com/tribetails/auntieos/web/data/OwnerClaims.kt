package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/** The `staffRole` claim value that means an Auntie. The owner carries `admin: true` and no `staffRole`. */
const val STAFF_ROLE_AUNTIE = "auntie"

private fun JsonObject.stringClaim(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

/** True when the decoded ID-token claims carry the Auntie role. */
fun auntieFromClaims(claims: JsonObject): Boolean = claims.stringClaim("staffRole") == STAFF_ROLE_AUNTIE

/**
 * The owner gate matches the web role rule (`lib/access.ts`), `firestore.rules`
 * `isOwner()` and the callables' `isOwnerClaim`: the `admin` claim, and NOT the
 * Auntie role. The desktop console has no Auntie screens, so an account on the
 * Auntie's side of the line is not let in.
 */
fun ownerFromClaims(claims: JsonObject): Boolean {
    val admin = (claims["admin"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true
    return admin && !auntieFromClaims(claims)
}

/**
 * The Stage 0I sandbox tribe, or null. An Auntie gets no sandbox, as on web
 * (`accessFromClaims` resolves her first and pins no test scope), so the claim
 * on her token admits nothing here either.
 */
fun sandboxTribeIdFromClaims(claims: JsonObject): String? {
    if (auntieFromClaims(claims)) return null
    return claims.stringClaim("testTribeId")?.ifBlank { null }
}
