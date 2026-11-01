package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FirestoreClient

/**
 * #1282: the household's kin roster, read straight from
 * `families/{kinfolkId}/kin` instead of through the `getMyKin` callable.
 *
 * `getMyKin` carries no `minInstances`, so the first open of any screen that
 * lists pets waited on a Cloud Run cold start (5 to 13 s on the 2026-11-01
 * walk). The operator ruled on 2026-09-12 that the portal moves to direct
 * reads, and `mytribe/firestore.rules` already grants this one:
 * `match /families/{fid}/kin/{kinId}` reads on `activeMember(fid) || isStaff()`.
 * `functions/test/rules/kin.test.ts` pins who passes and who does not.
 *
 * The mapping is a field-for-field copy of `functions/src/portal/getMyKin.ts`
 * and of the web portal's `lib/kinDirectRead.ts`: the two legacy admin
 * statuses are hidden, anything that is not `noLongerWithUs` is active, an
 * empty string is missing, and a numeric-string age is parsed.
 */

/** Same set as `LEGACY_INACTIVE_KIN_STATUSES` in functions/src/lib/kinStatus.ts. */
private val PORTAL_HIDDEN_KIN_STATUSES = setOf("inactive", "archived")

private fun stringOrNull(v: Any?): String? = (v as? String)?.takeIf { it.isNotEmpty() }

/** JavaScript's `parseFloat` prefix rule, which the server applies: "4 years" is 4, "old" is null. */
private val LEADING_NUMBER = Regex("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?")

private fun numericOrNull(v: Any?): Double? = when (v) {
    is Number -> v.toDouble()
    is String -> LEADING_NUMBER.find(v.trimStart())?.value?.toDoubleOrNull()
    else -> null
}

/** One `families/{fid}/kin/{id}` document as the portal's [Kin], or null when the portal hides it. */
fun kinFromDocument(id: String, fields: Map<String, Any?>): Kin? {
    val status = fields["status"]
    if (status is String && status in PORTAL_HIDDEN_KIN_STATUSES) return null
    return Kin(
        id = id,
        name = stringOrNull(fields["name"]),
        species = stringOrNull(fields["species"]),
        breed = stringOrNull(fields["breed"]),
        ageYears = numericOrNull(fields["ageYears"]),
        photoUrl = stringOrNull(fields["photoUrl"]),
        status = if (stringOrNull(status) == "noLongerWithUs") KinStatus.NoLongerWithUs else KinStatus.Active,
        feedingInstructions = stringOrNull(fields["feedingInstructions"]),
        walkingInstructions = stringOrNull(fields["walkingInstructions"]),
        medications = stringOrNull(fields["medications"]),
        allergies = stringOrNull(fields["allergies"]),
        emergencyNotes = stringOrNull(fields["emergencyNotes"]),
        sitterNotes = stringOrNull(fields["sitterNotes"]),
        sex = stringOrNull(fields["sex"]),
        weight = stringOrNull(fields["weight"]),
        colorMarkings = stringOrNull(fields["colorMarkings"]),
        spayedNeutered = fields["spayedNeutered"] == true,
        vetInfo = stringOrNull(fields["vetInfo"]),
    )
}

/** Reads the roster for one household. Throws whatever the client throws; the caller decides the fallback. */
suspend fun readKinDirect(firestore: FirestoreClient, kinfolkId: String): KinResult =
    KinResult(kin = firestore.listDocuments("families/$kinfolkId/kin").mapNotNull { kinFromDocument(it.id, it.fields) })
