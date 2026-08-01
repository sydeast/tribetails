package com.tribetails.auntieos.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.ui.admin.IntegrationLiveness
import com.tribetails.auntieos.ui.admin.IntegrationSecretState
import com.tribetails.auntieos.ui.admin.IntegrationStatus
import com.tribetails.auntieos.ui.admin.IntegrationsHealth
import com.tribetails.auntieos.ui.admin.ServerIntegration
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.tasks.await

/**
 * Settings > Integrations, the read half.
 *
 * ONE CALLABLE, `getIntegrationsHealth`, admin-gated in
 * `mytribe/functions/src/admin/getIntegrationsHealth.ts`. Its request and
 * response shapes are frozen in `mytribe/functions/test/callableContract.test.ts`
 * and written down in `CALLABLE_CONTRACT.md`, so a backend rename fails a test
 * rather than this decode quietly.
 *
 * THIS REPLACES A HARD-CODED LIST. Until now the panel decided integration
 * health on the device from four rows written into the ViewModel's default
 * state, which is how it went on showing "n8n Webhooks: CONFIGURED" more than a
 * year after n8n was retired, and how it stated "Twilio Studio: CONFIGURED"
 * having checked nothing. A handset cannot see a Cloud Functions secret, so
 * every server-side fact on that panel was a guess. Now the server answers and
 * this file transcribes.
 *
 * NO SECRET VALUE ARRIVES HERE. The response carries booleans and a character
 * count per credential, guarded by a server test that searches the whole
 * serialised response for any value or 4-character prefix. Nothing in this file
 * should ever grow a field for a value.
 *
 * THE DECODE IS FAIL-SOFT PER FIELD, NOT PER RESPONSE. A missing `integrations`
 * array is an error (there is nothing to show and pretending otherwise would put
 * a blank panel where a warning belongs), but an unknown `status` string decodes
 * to [IntegrationStatus.UNKNOWN] rather than throwing: an older APK meeting a
 * newer server must degrade to "we cannot tell" on one row, not lose the other
 * six.
 */
class IntegrationsRepository(
    // A PROVIDER, resolved lazily, not a `FirebaseFunctions` default argument.
    // `AdminSettingsViewModel` default-constructs this repository, and a default
    // argument is evaluated at construction, so `getInstance` would run inside
    // every JVM test that builds that ViewModel and throw "Default FirebaseApp
    // is not initialized". Same shape as `AuntieRepository.functions`.
    functionsProvider: () -> FirebaseFunctions = { FirebaseFunctions.getInstance("us-central1") },
) {
    private val functions by lazy(functionsProvider)

    suspend fun getIntegrationsHealth(): Result<IntegrationsHealth> = runCatching {
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getIntegrationsHealth")
            .call(emptyMap<String, Any?>())
            .await()
            .data as? Map<String, Any?>
            ?: error("getIntegrationsHealth: non-map payload")

        @Suppress("UNCHECKED_CAST")
        val rows = raw["integrations"] as? List<Map<String, Any?>>
            ?: error("getIntegrationsHealth: response carried no integrations")

        IntegrationsHealth(
            checkedAt = raw["checkedAt"] as? String ?: "",
            declaredKnown = raw["declaredKnown"] as? Boolean ?: false,
            declaredError = raw["declaredError"] as? String ?: "",
            integrations = rows.map(::decodeIntegration),
        )
    }.onFailure { AuntieLog.e("Error reading integrations health", it) }
}

private fun decodeIntegration(raw: Map<String, Any?>): ServerIntegration {
    @Suppress("UNCHECKED_CAST")
    val secrets = raw["secrets"] as? List<Map<String, Any?>> ?: emptyList()
    @Suppress("UNCHECKED_CAST")
    val liveness = raw["liveness"] as? Map<String, Any?> ?: emptyMap()
    return ServerIntegration(
        key = raw["key"] as? String ?: "",
        name = raw["name"] as? String ?: "",
        purpose = raw["purpose"] as? String ?: "",
        status = IntegrationStatus.from(raw["status"] as? String),
        summary = raw["summary"] as? String ?: "",
        secrets = secrets.map(::decodeSecret),
        liveness = IntegrationLiveness(
            outcome = liveness["outcome"] as? String ?: "none",
            detail = liveness["detail"] as? String ?: "",
        ),
        remediation = raw["remediation"] as? String ?: "",
        externalStep = raw["externalStep"] as? String ?: "",
        ownedBySection = raw["ownedBySection"] as? String ?: "",
    )
}

private fun decodeSecret(raw: Map<String, Any?>): IntegrationSecretState = IntegrationSecretState(
    name = raw["name"] as? String ?: "",
    required = raw["required"] as? Boolean ?: true,
    purpose = raw["purpose"] as? String ?: "",
    declared = raw["declared"] as? Boolean ?: false,
    resolves = raw["resolves"] as? Boolean ?: false,
    // Callable numbers arrive as Double through the Firebase SDK's JSON decode,
    // so the cast has to go through Number or every length reads as 0.
    length = (raw["length"] as? Number)?.toInt() ?: 0,
)
