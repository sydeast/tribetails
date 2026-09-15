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
 * reader and warn sink, so a test can exercise the validation, the
 * partial-config warning, and the rejected-config state without touching
 * process environment variables (the JVM cannot portably set those
 * mid-process) or stderr. [FirebaseRestConfig] is the production instance
 * every call site defaults to.
 */
internal open class RestEndpoints(
    private val env: (String) -> String? = System::getenv,
    private val warn: (String) -> Unit = System.err::println,
) {
    val API_KEY = "AIzaSyBnR7D4gORVehTr_-WB42_NyFeNO7acDTo"
    val DATABASE_ID = "(default)"
    private val PROD_PROJECT_ID = "auntieos-ttpc"

    private class HostCheck(val host: String?, val rejected: Boolean)

    /**
     * #889 review: an emulator host env var is honored only when it names a
     * loopback or private address (see isLoopbackOrPrivateHost), and only
     * when it is nothing but that address plus a port: no userinfo, path,
     * query or fragment, and a port is required. Rebuilt from the parsed
     * host and port, not the raw string, so a value that merely LOOKS
     * acceptable at a glance (a trailing "#@evil.com", a leading "user@")
     * cannot smuggle a different destination through. Anything rejected is
     * reported with a stderr warning, and [rejected] on the result records
     * that the variable was set but not honored, for [emulatorConfigRejected].
     */
    private fun validatedEmulatorHost(varName: String): HostCheck {
        val raw = env(varName)?.takeIf { it.isNotBlank() } ?: return HostCheck(null, false)
        val rejected = HostCheck(null, true)
        val uri = try {
            URI("http://$raw")
        } catch (_: Exception) {
            null
        } ?: return warnRejected(varName, raw).let { rejected }
        val host = uri.host
        val port = uri.port
        val hasExtras = !uri.rawUserInfo.isNullOrEmpty() ||
            !uri.rawPath.isNullOrEmpty() ||
            !uri.rawQuery.isNullOrEmpty() ||
            !uri.rawFragment.isNullOrEmpty()
        if (host == null || port == -1 || hasExtras || !isLoopbackOrPrivateHost(host)) {
            warnRejected(varName, raw)
            return rejected
        }
        // java.net.URI.getHost() already returns an IPv6 literal bracketed
        // ("[::1]"); strip any existing brackets before deciding whether to
        // add them back, so this never double-brackets.
        val bareHost = host.removePrefix("[").removeSuffix("]")
        val authority = if (bareHost.contains(':')) "[$bareHost]:$port" else "$bareHost:$port"
        return HostCheck(authority, false)
    }

    private fun warnRejected(varName: String, raw: String) {
        warn(
            "[FirebaseRestConfig] ignoring $varName=$raw: expected just a loopback or " +
                "private address (localhost, 127.0.0.0/8, ::1, 10/8, 172.16/12, " +
                "192.168/16, fc00::/7) and a port, nothing else. Calls that would use it " +
                "go to production instead.",
        )
    }

    private val authCheck = validatedEmulatorHost("FIREBASE_AUTH_EMULATOR_HOST")
    private val functionsCheck = validatedEmulatorHost("FUNCTIONS_EMULATOR_HOST")
    private val firestoreCheck = validatedEmulatorHost("FIRESTORE_EMULATOR_HOST")

    /** FIREBASE_AUTH_EMULATOR_HOST (host:port, e.g. "127.0.0.1:9099"), the
     *  variable the Firebase Auth emulator and every official Auth SDK read. */
    val AUTH_EMULATOR_HOST: String? = authCheck.host

    /** FUNCTIONS_EMULATOR_HOST (host:port, e.g. "127.0.0.1:5001"): the same
     *  switch name #867/#874 use for the admin desktop console's Firestore client. */
    val FUNCTIONS_EMULATOR_HOST: String? = functionsCheck.host

    /** FIRESTORE_EMULATOR_HOST (host:port, e.g. "127.0.0.1:8080"), the
     *  variable the admin desktop console's JvmFirestoreRest (#829/#874) reads. */
    val FIRESTORE_EMULATOR_HOST: String? = firestoreCheck.host

    val emulatorActive: Boolean =
        AUTH_EMULATOR_HOST != null || FUNCTIONS_EMULATOR_HOST != null || FIRESTORE_EMULATOR_HOST != null

    /**
     * #889 review round 3, item 7: true when at least one of the three
     * switches was set but rejected by [validatedEmulatorHost] (a bad
     * address, or extra userinfo/path/query/fragment). The stderr warning
     * above never reaches a desktop app launched from Finder; `windowTitle`
     * (Main.kt) surfaces this in the window title chip instead, so the
     * rejection is visible somewhere a person actually looks.
     */
    val emulatorConfigRejected: Boolean =
        authCheck.rejected || functionsCheck.rejected || firestoreCheck.rejected

    /**
     * #889 review, item 8/round 3 item 3: GCLOUD_PROJECT may stand in for
     * the project id, but only while an emulator is active and only when
     * the value is a demo-* id (the Firebase-documented convention for a
     * project that exists only for emulation, never a real one). This is
     * used ONLY inside the emulator branch of each builder below, never the
     * production branch: those always interpolate PROD_PROJECT_ID directly,
     * so setting only FIRESTORE_EMULATOR_HOST plus GCLOUD_PROJECT=demo-x
     * cannot change what functionUrl or identityToolkitBase build for a
     * production call that has no emulator switch of its own.
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

    /**
     * The base a callable/HTTP function lives under, with no function name
     * appended. The production branch always uses PROD_PROJECT_ID, never
     * the possibly-overridden PROJECT_ID: a GCLOUD_PROJECT override must
     * never leak into a URL that does not actually point at an emulator.
     */
    fun functionsBase(region: String = "us-central1", emulatorHost: String? = FUNCTIONS_EMULATOR_HOST): String =
        if (emulatorHost != null) "http://$emulatorHost/$PROJECT_ID/$region"
        else "https://$region-$PROD_PROJECT_ID.cloudfunctions.net"

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
     * Same PROD_PROJECT_ID-in-the-production-branch rule as functionsBase.
     */
    fun firestoreBase(emulatorHost: String? = FIRESTORE_EMULATOR_HOST): String =
        if (emulatorHost != null) "http://$emulatorHost/v1/projects/$PROJECT_ID/databases/$DATABASE_ID/documents"
        else "https://firestore.googleapis.com/v1/projects/$PROD_PROJECT_ID/databases/$DATABASE_ID/documents"
}

internal object FirebaseRestConfig : RestEndpoints()
