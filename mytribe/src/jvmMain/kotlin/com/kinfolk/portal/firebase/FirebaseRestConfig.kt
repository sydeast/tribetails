package com.kinfolk.portal.firebase

/**
 * Static config for Firebase REST clients on the JVM target, plus the one
 * place every callable/Auth REST URL is built.
 *
 * #889: `sendPasswordReset` and `reportFailedLogin` (RestAuthClient) and
 * `RestFunctionsClient.call` used to hardcode
 * `https://us-central1-$PROJECT_ID.cloudfunctions.net/...` directly, with no
 * way to reach a local Functions emulator. Every callable URL now comes from
 * [functionUrl], and the Auth REST bases from [identityToolkitBase] /
 * [secureTokenBase], so there is exactly one place that decides emulator vs.
 * production for this client.
 *
 * Each builder takes its emulator host as a defaulted parameter — read from
 * the matching env var — rather than a bare top-level `val`, so a test can
 * pass an explicit host (or null) without mutating process environment
 * variables, which the JVM does not support portably mid-process.
 */
internal object FirebaseRestConfig {
    const val PROJECT_ID = "auntieos-ttpc"
    const val API_KEY = "AIzaSyBnR7D4gORVehTr_-WB42_NyFeNO7acDTo"
    const val DATABASE_ID = "(default)"

    /**
     * `FIREBASE_AUTH_EMULATOR_HOST` (host:port, e.g. "127.0.0.1:9099") is the
     * variable the Firebase Auth emulator and every official Auth SDK read.
     * Set, [identityToolkitBase] and [secureTokenBase] route through it in the
     * documented emulator REST shape —
     * http://<host>/identitytoolkit.googleapis.com/... and
     * http://<host>/securetoken.googleapis.com/...
     * (https://firebase.google.com/docs/emulator-suite/connect_auth).
     * Unset, production.
     */
    val AUTH_EMULATOR_HOST: String? = System.getenv("FIREBASE_AUTH_EMULATOR_HOST")?.takeIf { it.isNotBlank() }

    /**
     * `FUNCTIONS_EMULATOR_HOST` (host:port, e.g. "127.0.0.1:5001"): the same
     * switch name #867/#874 use for the admin desktop console's Firestore
     * client (`FIRESTORE_EMULATOR_HOST` there). Set, [functionUrl] routes
     * through the local Functions emulator's documented HTTP shape —
     * http://<host>/<project>/<region>/<name>
     * (https://firebase.google.com/docs/emulator-suite/connect_functions).
     * Unset, production.
     */
    val FUNCTIONS_EMULATOR_HOST: String? = System.getenv("FUNCTIONS_EMULATOR_HOST")?.takeIf { it.isNotBlank() }

    fun identityToolkitBase(emulatorHost: String? = AUTH_EMULATOR_HOST): String =
        if (emulatorHost != null) "http://$emulatorHost/identitytoolkit.googleapis.com/v1"
        else "https://identitytoolkit.googleapis.com/v1"

    fun secureTokenBase(emulatorHost: String? = AUTH_EMULATOR_HOST): String =
        if (emulatorHost != null) "http://$emulatorHost/securetoken.googleapis.com/v1"
        else "https://securetoken.googleapis.com/v1"

    /** One callable/HTTP function's URL, emulator-aware. */
    fun functionUrl(name: String, region: String = "us-central1", emulatorHost: String? = FUNCTIONS_EMULATOR_HOST): String =
        if (emulatorHost != null) "http://$emulatorHost/$PROJECT_ID/$region/$name"
        else "https://$region-$PROJECT_ID.cloudfunctions.net/$name"

    // NOT emulator-aware: no FIRESTORE_EMULATOR_HOST switch on this path.
    // RestFirestoreClient (this package) always reads production Firestore.
    // Out of scope for #889 (its to-do names the callable + Auth REST URLs
    // only); flagged in the #889 report as a defect for a follow-up issue.
    const val FIRESTORE_BASE = "https://firestore.googleapis.com/v1"

    fun firestoreDocumentsRoot() =
        "$FIRESTORE_BASE/projects/$PROJECT_ID/databases/$DATABASE_ID/documents"
}
