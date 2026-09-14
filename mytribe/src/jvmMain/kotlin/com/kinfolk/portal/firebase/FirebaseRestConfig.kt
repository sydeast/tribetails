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

    /**
     * `FIRESTORE_EMULATOR_HOST` (host:port, e.g. "127.0.0.1:8080"): the same
     * variable the admin desktop console's `JvmFirestoreRest` (#829/#874)
     * reads. Set, [firestoreBase] routes through the documented emulator REST
     * shape — http://<host>/v1/projects/<project>/databases/(default)/documents
     * (https://firebase.google.com/docs/emulator-suite/connect_firestore).
     * Unset, production. Was left out of the first #889 pass (its to-do
     * named the callable + Auth REST URLs only); RestFirestoreClient reached
     * production Firestore under an emulator session until this landed.
     */
    val FIRESTORE_EMULATOR_HOST: String? = System.getenv("FIRESTORE_EMULATOR_HOST")?.takeIf { it.isNotBlank() }

    /**
     * The Firestore documents root, emulator-aware. `RestFirestoreClient`
     * (this package) is read-only and always sends the signed-in kinfolk's
     * real ID token, emulator or not — deliberately NOT the emulator's
     * `Bearer owner` admin-bypass credential, which the emulator also
     * accepts, so that `firestore.rules` still gates a read against the
     * emulator exactly as it does in production. `owner` would make an
     * emulator session silently permissive in a way production never is.
     */
    fun firestoreBase(emulatorHost: String? = FIRESTORE_EMULATOR_HOST): String =
        if (emulatorHost != null) "http://$emulatorHost/v1/projects/$PROJECT_ID/databases/$DATABASE_ID/documents"
        else "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/$DATABASE_ID/documents"
}
