package com.tribetails.auntieos.domain

/**
 * The `staffRole` claim value that means an Auntie. The owner carries
 * `admin: true` and no `staffRole` at all.
 */
const val STAFF_ROLE_AUNTIE = "auntie"

/**
 * The owner gate, read the way admin web (`lib/access.ts`), `firestore.rules`
 * (`isOwner()`) and the callables (`lib/staffGate.ts#isOwnerClaim`) read it:
 * the `admin` claim, and NOT the Auntie role. An account that carries the
 * Auntie role is on the Auntie's side of the line whatever else its token
 * carries, so this app, which has no Auntie screens, does not let it in.
 *
 * Pure, so the rule is tested without Firebase.
 */
fun isOwnerClaims(claims: Map<String, Any?>?): Boolean {
    if (claims == null) return false
    return claims["admin"] == true && claims["staffRole"] != STAFF_ROLE_AUNTIE
}
