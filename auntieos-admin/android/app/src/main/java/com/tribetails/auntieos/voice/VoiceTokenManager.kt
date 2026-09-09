package com.tribetails.auntieos.voice

import android.content.Context
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.firebase.messaging.FirebaseMessaging
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.AuthGate
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.fcmTokenFlow
import com.tribetails.auntieos.util.isFcmUnavailable
import com.tribetails.auntieos.util.saveFcmToken
import com.twilio.voice.RegistrationException
import com.twilio.voice.RegistrationListener
import com.twilio.voice.Voice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await

/**
 * One minted Twilio Voice access token, exactly as `mintVoiceAccessToken` returns it.
 *
 * [expiresInSeconds] is not decoration. The server picks the TTL and the client
 * has to re-mint against it; a client that assumes an hour and is handed ten
 * minutes fails as a call that will not connect, with nothing pointing at why.
 */
data class VoiceAccessToken(
    val token: String,
    val identity: String,
    val expiresInSeconds: Long,
)

/**
 * What voice calling is currently doing, and when it is not working, WHY.
 *
 * This exists because the thing it replaces was silence. `fetchToken` used to
 * return `null` on every failure, log a line to logcat, and let the caller
 * return early, so an operator whose phone could not receive calls saw a normal
 * looking app and no indication that anything had gone wrong. A screen can bind
 * to this and say the actual sentence.
 */
sealed interface VoiceTokenState {

    /**
     * Voice registration has not been attempted yet.
     *
     * Note what this does NOT say. [VoiceTokenManager.currentAccessToken] can
     * mint a token without registering anything, and that leaves this state
     * standing, correctly: a token in hand is not a device that will ring.
     */
    data object Idle : VoiceTokenState

    /**
     * A registration attempt is in flight.
     *
     * Only ever set by an entry point that will go on to register and settle:
     * `initialize`, [VoiceTokenManager.refresh], [VoiceTokenManager.onFcmTokenRefresh],
     * and the near-expiry job. A bare token read never sets it, because a state
     * that says "working" with nothing left to do is a spinner that never stops,
     * which is the same lie as the silent `null` this file exists to remove.
     */
    data object Working : VoiceTokenState

    /**
     * The Voice SDK is registered and this device will ring for inbound calls.
     * [expiresAtMillis] is when the current token lapses, in `System.currentTimeMillis` terms.
     */
    data class Registered(val identity: String, val expiresAtMillis: Long) : VoiceTokenState

    /**
     * The server refused because a Twilio secret is missing or malformed, and it
     * named which one. [secret] is the environment variable name, so the banner
     * can tell the operator exactly what to set instead of "something went wrong".
     */
    data class Misconfigured(
        val secret: String,
        val detailCode: String,
        val message: String,
    ) : VoiceTokenState

    /** The caller is signed out, or is signed in without the admin claim. */
    data class NotAuthorized(val message: String) : VoiceTokenState

    /** Anything else: no network, the callable is not deployed, a bad response shape. */
    data class Failed(val message: String) : VoiceTokenState
}

/**
 * The Voice SDK registration call, behind a seam.
 *
 * `Voice.register` is a static on the Twilio SDK that reaches for Android
 * runtime pieces, so nothing above it could be exercised on the JVM while it was
 * called directly. The production implementation is [TwilioVoiceRegistrar]; a
 * test supplies a recorder.
 */
interface VoiceRegistrar {
    /** [onResult] is handed `null` on success, or the registration failure. */
    fun register(accessToken: String, fcmToken: String, onResult: (Throwable?) -> Unit)
}

internal object TwilioVoiceRegistrar : VoiceRegistrar {
    override fun register(accessToken: String, fcmToken: String, onResult: (Throwable?) -> Unit) {
        Voice.register(
            accessToken,
            Voice.RegistrationChannel.FCM,
            fcmToken,
            object : RegistrationListener {
                override fun onRegistered(accessToken: String, fcmToken: String) = onResult(null)
                override fun onError(
                    error: RegistrationException,
                    accessToken: String,
                    fcmToken: String,
                ) = onResult(error)
            },
        )
    }
}

/**
 * Mints Twilio Voice access tokens and keeps this device registered for inbound calls.
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────────────
 *
 * It used to fetch from `https://tribetailsattendant-8587.twil.io/get-token` via
 * Retrofit. That endpoint was public, took no arguments, and would hand a token
 * granting `incomingAllow` for the identity `auntie` to anyone who knew the URL.
 * It also 404s today, so in practice every launch fetched nothing. Both halves
 * of that are fixed by the `mintVoiceAccessToken` callable, which is admin gated
 * server side.
 *
 * ── TWO DEFECTS THIS FILE EXISTS TO CLOSE ─────────────────────────────────────
 *
 *  1. SILENCE. The old `fetchToken` swallowed every failure into `null`. The
 *     operator's phone simply never rang and nothing said so. Every failure now
 *     lands in [state], classified, and a misconfiguration carries the name of
 *     the secret the server is missing.
 *
 *  2. EXPIRY. `cachedToken` was written once and never invalidated, so after the
 *     token's hour was up the cached string was still handed out, and a stale
 *     access token fails at registration rather than at use. [ensureToken] now
 *     re-mints once the token is inside [REFRESH_SKEW_SECONDS] of lapsing, and a
 *     background job re-mints on the same boundary without waiting to be asked.
 *
 * A singleton because the Voice SDK registration it drives is process wide: two
 * of these would fight over one registration.
 */
object VoiceTokenManager {

    /**
     * How early to re-mint. Five minutes covers a slow mint plus the registration
     * round trip, so a token is never handed out with less life left than the
     * work it is about to be used for.
     */
    private const val REFRESH_SKEW_SECONDS = 300L

    /**
     * THE RETRY BOUND: four mint attempts per trigger, and no more.
     *
     * One attempt plus the three backoffs in [MINT_RETRY_BACKOFF_MILLIS], so a
     * trigger gives up roughly forty seconds after it started. The bound is here
     * because the alternative to a bound is a loop that hammers a callable for
     * the rest of the process, and the thing it is retrying costs a Twilio mint.
     *
     * Only a transient failure spends any of this budget; see [isWorthRetrying].
     * An auth failure spends none, because the event that fixes it is the
     * operator signing in, and [onAdminSignedIn] is already listening for that.
     */
    private const val MAX_MINT_ATTEMPTS = 4

    /**
     * Waits between the attempts, growing so a server that is briefly down is not
     * asked four times in the same second. One entry short of [MAX_MINT_ATTEMPTS]
     * on purpose: the last attempt is not followed by a wait.
     */
    private val MINT_RETRY_BACKOFF_MILLIS = longArrayOf(2_000L, 10_000L, 30_000L)

    private val _state = MutableStateFlow<VoiceTokenState>(VoiceTokenState.Idle)

    /**
     * Observable, because a log line is not a user-visible failure. The app shell
     * binds to this in `ui/Navigation.kt`, beside the TEST MODE banner, so a
     * device that will not ring says so on every screen instead of only in Sentry.
     */
    val state: StateFlow<VoiceTokenState> = _state.asStateFlow()

    private var mint: (suspend () -> Result<VoiceAccessToken>)? = null
    private var registrar: VoiceRegistrar = TwilioVoiceRegistrar
    private var fcmTokenProvider: suspend () -> String = { "" }
    private var now: () -> Long = System::currentTimeMillis
    private var scope: CoroutineScope? = null

    /**
     * The backoff wait, behind a seam. A test that really slept forty seconds to
     * prove a retry works is a test nobody runs, so this defaults to [delay] and
     * a test hands in a recorder that returns immediately and keeps the durations.
     */
    private var backoff: suspend (Long) -> Unit = { delay(it) }

    /** Serialises minting so two concurrent callers cannot burn two tokens. */
    private val mintMutex = Mutex()

    private var cachedToken: String? = null
    private var cachedIdentity: String = ""
    private var cachedExpiresAtMillis: Long = 0L
    private var refreshJob: Job? = null

    /**
     * Whether the Voice SDK is currently registered, tracked separately from
     * [state] because the two answer different questions. [state] is the last
     * thing worth telling the operator; this is the fact a re-mint has to consult
     * before it can restate an expiry without inventing a registration.
     */
    private var registeredWithVoiceSdk: Boolean = false

    /**
     * Hand the manager its production seams. THIS NO LONGER MINTS ANYTHING.
     *
     * It used to end with `scope.launch { mintAndRegister() }`, and that one line
     * was the whole of #433. `Application.onCreate` is the earliest code in the
     * process, so the mint it started ran before anybody could be signed in;
     * `mintVoiceAccessToken` opens with `authGate.ensureAuthenticated()`, so on
     * the first launch after an install and on every launch after a sign-out it
     * was refused outright. A refusal scheduled no retry, because `scheduleRefresh`
     * is only reached by a SUCCESSFUL mint, and so the manager parked on a
     * terminal state and the phone did not ring for the rest of that process.
     * A returning session merely raced Firebase Auth restoring its persisted user,
     * which is not something to be right by luck either.
     *
     * Registration is driven by [VoiceRegistrationCoordinator] now, off the auth
     * state the app already publishes, which puts the mint AFTER the sign-in it
     * depends on and gets sign-out then sign-in right for free.
     */
    fun initialize(context: Context, repository: AuntieRepository, scope: CoroutineScope) {
        AuntieLog.d("Initializing VoiceTokenManager")
        val appContext = context.applicationContext
        configure(
            mint = { repository.mintVoiceAccessToken() },
            registrar = TwilioVoiceRegistrar,
            fcmTokenProvider = { resolveFcmToken(appContext) },
            now = System::currentTimeMillis,
            scope = scope,
        )
    }

    /**
     * An admin is signed in: mint and register this device for inbound calls.
     *
     * [VoiceRegistrationCoordinator] calls this on every sign-in, including the
     * one that follows a sign-out, which is why the re-mint is forced. A cached
     * token belongs to the identity that minted it, and handing the incoming
     * admin the outgoing admin's token registers this phone under the wrong
     * identity, which is a subtler version of the same "phone does not ring"
     * complaint.
     *
     * Safe to call more than once. Each call is its own retry budget, so a
     * transient failure earlier in the session never means a later sign-in gets
     * fewer attempts.
     */
    fun onAdminSignedIn() {
        val activeScope = scope
        if (activeScope == null) {
            AuntieLog.w("Ignoring admin sign-in: VoiceTokenManager is not initialized")
            return
        }
        AuntieLog.i("Admin signed in, registering this device for inbound calls")
        activeScope.launch { mintAndRegister(forceRemint = true) }
    }

    /**
     * The admin signed out. Drop the token and stop claiming a registration.
     *
     * The cached token outliving the session that minted it is what would let the
     * next admin be registered under the previous one's identity. Back to
     * [VoiceTokenState.Idle] rather than a failure, because "registration has not
     * been attempted" is the true statement for a signed-out app and a red banner
     * about a phone that cannot ring is noise on a login screen.
     *
     * Deliberately does NOT call `Voice.unregister`: Twilio keeps the previous
     * registration until the token lapses either way, and tearing it down needs a
     * still-valid token this device may no longer be able to mint.
     */
    fun onSignedOut() {
        AuntieLog.i("Admin signed out, dropping the cached voice token")
        refreshJob?.cancel()
        refreshJob = null
        cachedToken = null
        cachedIdentity = ""
        cachedExpiresAtMillis = 0L
        registeredWithVoiceSdk = false
        _state.value = VoiceTokenState.Idle
    }

    /**
     * Re-register after FCM hands this device a new token.
     *
     * THE CALLER LIVES ELSEWHERE. `onNewToken` in
     * `fcm/AuntieFirebaseMessagingService.kt` is the natural call site and is
     * owned by another change; this function is public and stable so that wiring
     * is a one line addition there. Until it is wired, a rotated FCM token means
     * this device stops ringing until the next app launch.
     *
     * Takes only the new token: the repository, scope and context were captured
     * by [initialize], so the call site needs to know nothing about them.
     */
    fun onFcmTokenRefresh(newFcmToken: String) {
        AuntieLog.i("FCM token refreshed, re-registering voice")
        val activeScope = scope
        if (activeScope == null) {
            AuntieLog.w("Ignoring FCM token refresh: VoiceTokenManager is not initialized")
            return
        }
        if (newFcmToken.isBlank()) {
            // Registering against a blank token cannot work, and letting Twilio
            // be the one to say so buries the cause in an SDK error string.
            registeredWithVoiceSdk = false
            _state.value = VoiceTokenState.Failed(
                "Push registration was refreshed with a blank token, so this device " +
                    "cannot be woken for an incoming call."
            )
            return
        }
        activeScope.launch {
            _state.value = VoiceTokenState.Working
            // Deliberately NOT the old `cachedToken ?: fetch` line: that reused a
            // token that may already have expired, which fails at registration.
            // A null here has already put a terminal failure in [state].
            val token = ensureToken(forceRemint = false) ?: return@launch
            register(token, newFcmToken)
        }
    }

    /**
     * Re-run the whole mint and register, discarding any cached token.
     *
     * This is the "Try again" on the failure banner in the app shell, and only
     * that. It is NOT how the app recovers from a failed registration: a control
     * the operator has to find and press is the same "once, if somebody happens
     * to look" that #433 was about. Recovery is [onAdminSignedIn] plus the
     * bounded retry inside [mintAndRegister]; this is for the operator who has
     * just gone and set the secret the banner named and does not want to wait.
     */
    fun refresh() {
        val activeScope = scope
        if (activeScope == null) {
            AuntieLog.w("Ignoring voice refresh: VoiceTokenManager is not initialized")
            return
        }
        activeScope.launch { mintAndRegister(forceRemint = true) }
    }

    /**
     * A currently valid access token, minting a fresh one if the cached token is
     * gone or close enough to expiry to be untrustworthy. `null` means the mint
     * failed, and [state] says how.
     *
     * THIS READ NEVER LEAVES [state] MID-FLIGHT. It used to: it set `Working`
     * before minting and had nothing that set it back, because only the
     * registration callback ever moves the flow to [VoiceTokenState.Registered].
     * A caller who got a perfectly good token therefore left the screen showing
     * a spinner that would never resolve, reporting "still trying" about work
     * that had already succeeded. That is the same defect as the silent `null`
     * this file was written to remove, wearing the opposite costume, so the
     * settle below is not tidiness.
     */
    suspend fun currentAccessToken(): String? {
        val token = ensureToken(forceRemint = false) ?: return null
        settleAfterBareMint()
        return token
    }

    /**
     * Bring [state] back to something true after a token read.
     *
     * Minting registers nothing, so this restates the registration the device
     * already has, carrying the expiry a re-mint has just moved. When the device
     * is NOT registered it deliberately writes nothing: overwriting a real
     * [VoiceTokenState.Failed] registration error with a claim of success would
     * be a worse lie than the stuck spinner, and [VoiceTokenState.Idle] is
     * already the true statement that registration has not been attempted.
     */
    private fun settleAfterBareMint() {
        if (registeredWithVoiceSdk) {
            _state.value = VoiceTokenState.Registered(
                identity = cachedIdentity,
                expiresAtMillis = cachedExpiresAtMillis,
            )
        }
    }

    /**
     * Whether a mint failure is worth spending another attempt on.
     *
     * Only [VoiceTokenState.Failed] is: that is the no-network, callable-not-
     * deployed, bad-response-shape bucket, and those clear on their own. The two
     * that are excluded are excluded because a retry cannot help them:
     *
     *  - [VoiceTokenState.NotAuthorized] is fixed by the operator signing in, or
     *    by an admin claim being granted, and [onAdminSignedIn] already fires on
     *    the first of those. Spending the budget here would just mean an attempt
     *    that arrives thirty seconds later and is refused for the same reason.
     *  - [VoiceTokenState.Misconfigured] names a Twilio secret that is unset on
     *    the server. It will still be unset in thirty seconds. The banner naming
     *    the secret is the fix, and the "Try again" on it is the retry.
     */
    private fun isWorthRetrying(state: VoiceTokenState): Boolean = state is VoiceTokenState.Failed

    /**
     * Mint a token and register this device, retrying a transient refusal up to
     * [MAX_MINT_ATTEMPTS] times.
     *
     * The retry is around the MINT only. Registration reports through a Twilio
     * callback rather than by returning, so looping over it would mean plumbing
     * a completion back out of [register]; the failure this is here to fix is a
     * mint failure, and the registration failures already land in [state] with
     * their own sentence and a "Try again" beside them.
     */
    internal suspend fun mintAndRegister(forceRemint: Boolean = false) {
        val token = mintWithRetry(forceRemint) ?: return
        val fcmToken = try {
            fcmTokenProvider()
        } catch (e: Exception) {
            AuntieLog.e("Could not resolve an FCM token for voice registration", e)
            ""
        }
        if (fcmToken.isBlank()) {
            // Loud, where this used to be a `w` log and a return. Without an FCM
            // token the device cannot be woken for an inbound call at all.
            registeredWithVoiceSdk = false
            _state.value = VoiceTokenState.Failed(
                "This device has no push token yet, so it cannot be registered to receive calls. " +
                    "Reopen the app once notifications are allowed."
            )
            return
        }
        register(token, fcmToken)
    }

    /**
     * [ensureToken], with the bounded backoff described on [MAX_MINT_ATTEMPTS].
     *
     * Returns the token, or `null` once the attempts are spent or the refusal
     * turns out to be one no retry can fix. Either way [state] is left holding
     * the classified failure, never [VoiceTokenState.Working].
     */
    private suspend fun mintWithRetry(forceRemint: Boolean): String? {
        var attempt = 1
        while (true) {
            _state.value = VoiceTokenState.Working
            val token = ensureToken(forceRemint)
            if (token != null) return token
            // `ensureToken` has already classified the refusal into [state], and
            // that classification is what decides whether another attempt buys
            // anything.
            if (attempt >= MAX_MINT_ATTEMPTS || !isWorthRetrying(_state.value)) return null
            val wait = MINT_RETRY_BACKOFF_MILLIS[attempt - 1]
            AuntieLog.w(
                "Voice token mint failed (attempt $attempt of $MAX_MINT_ATTEMPTS), " +
                    "retrying in ${wait / 1000}s"
            )
            backoff(wait)
            attempt++
        }
    }

    private suspend fun ensureToken(forceRemint: Boolean): String? = mintMutex.withLock {
        val cached = cachedToken
        if (!forceRemint && cached != null && now() < cachedExpiresAtMillis - REFRESH_SKEW_SECONDS * 1000L) {
            return@withLock cached
        }
        val mintCallable = mint
        if (mintCallable == null) {
            registeredWithVoiceSdk = false
            _state.value = VoiceTokenState.Failed(
                "Voice calling was never initialized on this device."
            )
            return@withLock null
        }
        // NOTE: no `Working` here. This runs under a bare token read as well as
        // under the registering entry points, and only those can settle the flow
        // afterwards, so setting it here is what stranded the UI on a spinner.
        // Each registering caller sets `Working` for itself.
        val result = mintCallable()
        val minted = result.getOrNull()
        if (minted == null) {
            // Drop the cache: continuing to hand out a token the server has just
            // refused to renew is how a stale credential outlives its own failure.
            cachedToken = null
            cachedExpiresAtMillis = 0L
            registeredWithVoiceSdk = false
            val error = result.exceptionOrNull()
                ?: IllegalStateException("mintVoiceAccessToken failed without an error")
            _state.value = classifyTokenFailure(error)
            AuntieLog.e("Twilio Voice token mint failed", error)
            return@withLock null
        }
        cachedToken = minted.token
        cachedIdentity = minted.identity
        cachedExpiresAtMillis = now() + minted.expiresInSeconds * 1000L
        scheduleRefresh(minted.expiresInSeconds)
        AuntieLog.d("Twilio Voice token minted for ${minted.identity}")
        minted.token
    }

    /**
     * Re-mint [REFRESH_SKEW_SECONDS] before the token lapses, so a device sitting
     * idle overnight is still registered in the morning. Replaces the previous
     * job, so a forced re-mint does not leave two timers running.
     */
    private fun scheduleRefresh(expiresInSeconds: Long) {
        val activeScope = scope ?: return
        refreshJob?.cancel()
        val delayMillis = ((expiresInSeconds - REFRESH_SKEW_SECONDS) * 1000L).coerceAtLeast(0L)
        refreshJob = activeScope.launch {
            delay(delayMillis)
            AuntieLog.d("Voice access token is near expiry, re-minting")
            mintAndRegister(forceRemint = true)
        }
    }

    private fun register(accessToken: String, fcmToken: String) {
        AuntieLog.d("Registering Voice SDK with FCM token")
        try {
            registrar.register(accessToken, fcmToken) { error ->
                if (error == null) {
                    AuntieLog.i("Voice SDK registered successfully")
                    registeredWithVoiceSdk = true
                    _state.value = VoiceTokenState.Registered(
                        identity = cachedIdentity,
                        expiresAtMillis = cachedExpiresAtMillis,
                    )
                } else {
                    AuntieLog.e("Voice SDK registration error: ${error.message}", error)
                    registeredWithVoiceSdk = false
                    _state.value = VoiceTokenState.Failed(
                        "Twilio refused this device's registration: ${error.message ?: "no reason given"}"
                    )
                }
            }
        } catch (t: Throwable) {
            // `Voice.register` is a third-party static that can throw before it
            // ever reaches its listener. Without this the flow would sit on
            // `Working` for the rest of the process: a failure reported as
            // work still in progress, which is the shape of defect this whole
            // change exists to remove.
            AuntieLog.e("Voice SDK registration threw before reporting", t)
            registeredWithVoiceSdk = false
            _state.value = VoiceTokenState.Failed(
                "The Twilio Voice SDK failed while registering this device: " +
                    (t.message ?: "no reason given")
            )
        }
    }

    private suspend fun resolveFcmToken(context: Context): String {
        val stored = context.fcmTokenFlow().first()
        if (stored.isNotBlank()) return stored
        return try {
            AuntieLog.d("Fetching FCM token from Firebase")
            val fetched = FirebaseMessaging.getInstance().token.await()
            context.saveFcmToken(fetched)
            fetched
        } catch (e: Exception) {
            // AUNTIEOS-ADMIN-W: no Play Services on this device (an AOSP
            // emulator, mainly) means no FCM token exists to fetch, and no
            // retry changes that. Voice registration already treats "" as
            // nothing to register with, so this call already skips
            // registration; the only change here is not reporting a Sentry
            // error for a device shape the app cannot do anything about.
            if (isFcmUnavailable(e)) {
                AuntieLog.i("FCM unavailable on this device (${e.message}); voice registration skipped")
            } else {
                AuntieLog.e("Could not get FCM token from Firebase", e)
            }
            ""
        }
    }

    internal fun configure(
        mint: suspend () -> Result<VoiceAccessToken>,
        registrar: VoiceRegistrar,
        fcmTokenProvider: suspend () -> String,
        now: () -> Long,
        scope: CoroutineScope,
        backoff: suspend (Long) -> Unit = { delay(it) },
    ) {
        refreshJob?.cancel()
        refreshJob = null
        this.mint = mint
        this.registrar = registrar
        this.fcmTokenProvider = fcmTokenProvider
        this.now = now
        this.scope = scope
        this.backoff = backoff
        cachedToken = null
        cachedIdentity = ""
        cachedExpiresAtMillis = 0L
        registeredWithVoiceSdk = false
        _state.value = VoiceTokenState.Idle
    }

    /**
     * An `object` keeps its fields for the life of the JVM, and the unit test
     * suite is one JVM, so without this a passing test would leave a cached token
     * behind for the next one and the pair would pass alone and fail together.
     */
    internal fun resetForTests() {
        refreshJob?.cancel()
        refreshJob = null
        mint = null
        registrar = TwilioVoiceRegistrar
        fcmTokenProvider = { "" }
        now = System::currentTimeMillis
        scope = null
        backoff = { delay(it) }
        cachedToken = null
        cachedIdentity = ""
        cachedExpiresAtMillis = 0L
        registeredWithVoiceSdk = false
        _state.value = VoiceTokenState.Idle
    }
}

/**
 * Turns a mint failure into the sentence the operator should read.
 *
 * Pure and `internal` so the mapping is pinned by tests rather than only
 * reachable by breaking a real deployment. The `failed-precondition` branch is
 * the load-bearing one: `mintVoiceAccessToken` throws it with
 * `details.secret` naming the exact Twilio secret that is missing or malformed,
 * which is the difference between "calling is broken" and "set TWIML_APP_SID".
 */
internal fun classifyTokenFailure(error: Throwable): VoiceTokenState {
    // The mint never left the device: `mintVoiceAccessToken` opens with
    // `authGate.ensureAuthenticated()`, which throws this when nobody is signed
    // in. It reads as NotAuthorized rather than as a generic failure because the
    // two are recovered differently. Nothing is wrong with the server, and the
    // event that fixes this is the operator signing in, which
    // `VoiceRegistrationCoordinator` is already watching for. Classifying it as
    // `Failed` would instead spend the whole retry budget re-asking a question
    // whose answer cannot change until then (#433).
    if (error.message == AuthGate.SIGN_IN_REQUIRED) {
        return VoiceTokenState.NotAuthorized(AuthGate.SIGN_IN_REQUIRED)
    }
    if (error is FirebaseFunctionsException) {
        val details = error.details as? Map<*, *>
        val secret = details?.get("secret") as? String
        val detailCode = details?.get("code") as? String
        if (error.code == FirebaseFunctionsException.Code.FAILED_PRECONDITION && !secret.isNullOrBlank()) {
            return VoiceTokenState.Misconfigured(
                secret = secret,
                detailCode = detailCode.orEmpty(),
                message = error.message
                    ?: "Voice calling is not configured yet: the $secret secret is not set.",
            )
        }
        if (error.code == FirebaseFunctionsException.Code.PERMISSION_DENIED ||
            error.code == FirebaseFunctionsException.Code.UNAUTHENTICATED
        ) {
            return VoiceTokenState.NotAuthorized(
                error.message ?: "This account is not allowed to answer the business line."
            )
        }
    }
    return VoiceTokenState.Failed(
        error.message ?: "Voice calling could not be set up, and no reason was given."
    )
}
