package com.kinfolk.portal.firebase

import java.net.URI

/**
 * Emulator-aware endpoint config for every Firebase REST client on the JVM
 * target: RestAuthClient, RestFunctionsClient, RestFirestoreClient, and the
 * jvm SecureResetFetcher/ShareLinkFetcher.
 *
 * #889: sendPasswordReset and reportFailedLogin (RestAuthClient),
 * RestFunctionsClient.call, RestFirestoreClient, and the jvm
 * SecureResetFetcher/ShareLinkFetcher all used to hardcode a production
 * Firebase host directly, with no way to reach a local emulator. Every URL
 * now comes from one of the functions below, so there is exactly one place
 * that decides emulator vs. production.
 *
 * A class rather than a plain object, constructed with an injectable env
 * reader and warn sink, so a test can exercise the validation and the
 * partial-config warning without touching process environment variables (the
 * JVM cannot portably set those mid-process) or stderr. [FirebaseRestConfig]
 * is the production instance every call site defaults to.
 */
internal open class RestEndpoints(
    private val env: (String) -> String? = System::getenv,
    private val warn: (String) -> Unit = System.err::println,
) {
    val API_KEY = "AIzaSyBnR7D4gORVehTr_-WB42_NyFeNO7acDTo"
    val DATABASE_ID = "(default)"
    private val PROD_PROJECT_ID = "auntieos-ttpc"

    /**
     * #889 review: an emulator host env var is honored only when it names a
     * loopback or private address (see isLoopbackOrPrivateHost) so a
     * leftover FIRESTORE_EMULATOR_HOST=some.host in a shipped desktop build
     * cannot send a kinfolk's real ID token to an arbitrary host over plain
     * http. Parsed as a URI authority (java.net.URI) so host:port and the
     * bracketed IPv6 form [::1]:9099 both work; anything else is ignored
     * with a stderr warning rather than silently used or silently dropped.
     */
    private fun validatedEmulatorHost(varName: String): String? {
        val raw = env(varName)?.takeIf { it.isNotBlank() } ?: return null
        val host = try {
            URI("http://$raw").host
        } catch (_: Exception) {
            null
        }
        if (host == null || !isLoopbackOrPrivateHost(host)) {
            warn(
                "[FirebaseRestConfig] ignoring $varName=$raw: not a loopback or private " +
                    "address (localhost, 127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, " +
                    "fc00::/7). Calls that would use it go to production instead.",
            )
            return null
        }
        return raw
    }

    /** FIREBASE_AUTH_EMULATOR_HOST (host:port, e.g. "127.0.0.1:9099"), the
     *  variable the Firebase Auth emulator and every official Auth SDK read. */
    val AUTH_EMULATOR_HOST: String? = validatedEmulatorHost("FIREBASE_AUTH_EMULATOR_HOST")

    /** FUNCTIONS_EMULATOR_HOST (host:port, e.g. "127.0.0.1:5001"): the same
     *  switch name #867/#874 use for the admin desktop console's Firestore client. */
    val FUNCTIONS_EMULATOR_HOST: String? = validatedEmulatorHost("FUNCTIONS_EMULATOR_HOST")

    /** FIRESTORE_EMULATOR_HOST (host:port, e.g. "127.0.0.1:8080"), the
     *  variable the admin desktop console's JvmFirestoreRest (#829/#874) reads. */
    val FIRESTORE_EMULATOR_HOST: String? = validatedEmulatorHost("FIRESTORE_EMULATOR_HOST")

    val emulatorActive: Boolean =
        AUTH_EMULATOR_HOST != null || FUNCTIONS_EMULATOR_HOST != null || FIRESTORE_EMULATOR_HOST != null

    /**
     * #889 review, item 8: GCLOUD_PROJECT may stand in for the project id,
     * but only while an emulator is active and only when the value is a
     * demo-* id (the Firebase-documented convention for a project that
     * exists only for emulation, never a real one). A production run, or a
     * real project id set by accident, always uses the shipped project.
     */
    val PROJECT_ID: String = run {
        val override = env("GCLOUD_PROJECT")?.takeIf { it.isNotBlank() }
        if (emulatorActive && override != null && override.startsWith("demo-")) override else PROD_PROJECT_ID
    }

    init {
        val configuredCount = listOf(AUTH_EMULATOR_HOST, FUNCTIONS_EMULATOR_HOST, FIRESTORE_EMULATOR_HOST)
            .count { it != null }
        if (configuredCount in 1..2) {
            warn(
                "[FirebaseRestConfig] only $configuredCount of 3 Firebase emulator switches are " +
                    "set (FIREBASE_AUTH_EMULATOR_HOST, FUNCTIONS_EMULATOR_HOST, " +
                    "FIRESTORE_EMULATOR_HOST). Calls through the unset ones will reach production.",
            )
        }
    }

    fun identityToolkitBase(emulatorHost: String? = AUTH_EMULATOR_HOST): String =
        if (emulatorHost != null) "http://$emulatorHost/identitytoolkit.googleapis.com/v1"
        else "https://identitytoolkit.googleapis.com/v1"

    fun secureTokenBase(emulatorHost: String? = AUTH_EMULATOR_HOST): String =
        if (emulatorHost != null) "http://$emulatorHost/securetoken.googleapis.com/v1"
        else "https://securetoken.googleapis.com/v1"

    /** The base a callable/HTTP function lives under, with no function name appended. */
    fun functionsBase(region: String = "us-central1", emulatorHost: String? = FUNCTIONS_EMULATOR_HOST): String =
        if (emulatorHost != null) "http://$emulatorHost/$PROJECT_ID/$region"
        else "https://$region-$PROJECT_ID.cloudfunctions.net"

    /** One callable/HTTP function's URL, emulator-aware. */
    fun functionUrl(name: String, region: String = "us-central1", emulatorHost: String? = FUNCTIONS_EMULATOR_HOST): String =
        "${functionsBase(region, emulatorHost)}/$name"

    /**
     * The Firestore documents root, emulator-aware. RestFirestoreClient
     * (this package) is read-only and always sends the signed-in kinfolk's
     * real ID token, emulator or not, deliberately NOT the emulator's
     * Bearer owner admin-bypass credential, which the emulator also
     * accepts, so that firestore.rules still gates a read against the
     * emulator exactly as it does in production. owner would make an
     * emulator session silently permissive in a way production never is.
     */
    fun firestoreBase(emulatorHost: String? = FIRESTORE_EMULATOR_HOST): String =
        if (emulatorHost != null) "http://$emulatorHost/v1/projects/$PROJECT_ID/databases/$DATABASE_ID/documents"
        else "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/$DATABASE_ID/documents"
}

internal object FirebaseRestConfig : RestEndpoints()
