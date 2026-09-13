package com.tribetails.auntieos.ui.admin

/**
 * What the Integrations panel knows, and who told it.
 *
 * THE SPLIT IS THE POINT. This file used to hold ONE list of four hard-coded
 * rows whose health the handset decided for itself, and two of them were fixed
 * strings: "n8n Webhooks: CONFIGURED" stayed on screen for more than a year
 * after n8n was retired, and "Twilio Studio: CONFIGURED" asserted a state
 * nothing had checked. A phone cannot see a Cloud Functions secret, so every
 * server-side claim it made was a guess with a confident pill on it.
 *
 * So the panel now has two halves, and they are separate types because they have
 * different authors:
 *
 *   - [ServerIntegration], from `getIntegrationsHealth`. Every outside service
 *     (Stripe, Twilio, SMTP2GO, Cloudinary, Mapbox, Google Calendar, Sentry),
 *     decided on the server. THE SAME ANSWER THE REACT ADMIN RENDERS, which is
 *     what stops the two surfaces telling an operator different things about the
 *     same key.
 *   - [DeviceProbe], from this handset, and kept for exactly the two facts a
 *     server genuinely cannot see: whether THIS device can reach Firestore, and
 *     whether THIS device holds an FCM registration token. Both are properties
 *     of the phone in the operator's hand, so a server answer would be about a
 *     different machine. They are labelled as being about this device, so
 *     nobody reads "Firestore: healthy" as a claim about the business.
 */

// ── The device half ──────────────────────────────────────────────────────────

/** Health of something this handset can check about itself. */
enum class IntegrationHealthState {
    HEALTHY,         // Recent successful round-trip from this device
    CONFIGURED,      // Reachable in principle, nothing proved
    DISCONNECTED,    // Probe failed
    CHECKING,        // Probe in flight
    UNKNOWN,         // Not yet probed
}

data class IntegrationHealth(
    val name: String,
    val description: String,
    val state: IntegrationHealthState,
)

fun integrationPillLabel(state: IntegrationHealthState): String = when (state) {
    IntegrationHealthState.HEALTHY      -> "HEALTHY"
    IntegrationHealthState.CONFIGURED   -> "CONFIGURED"
    IntegrationHealthState.DISCONNECTED -> "DISCONNECTED"
    IntegrationHealthState.CHECKING     -> "CHECKING"
    IntegrationHealthState.UNKNOWN      -> "UNKNOWN"
}

// Probe-result interpretation helpers. Pure (no Firebase), JVM-testable.
fun firestoreHealthFromProbe(succeeded: Boolean): IntegrationHealthState =
    if (succeeded) IntegrationHealthState.HEALTHY else IntegrationHealthState.DISCONNECTED

fun fcmHealthFromTokenPresence(hasToken: Boolean): IntegrationHealthState =
    if (hasToken) IntegrationHealthState.HEALTHY else IntegrationHealthState.CONFIGURED

// ── The server half ──────────────────────────────────────────────────────────

/**
 * The operator's situation with one outside service, as the server decided it.
 *
 * [UNKNOWN] is not a spare value. A check that could not be made and a check
 * that passed must never render alike, because the first one means nobody knows
 * whether the business can take a payment. It is also where an unrecognised
 * status string lands, so an older APK meeting a newer server says "we cannot
 * tell" instead of inventing a verdict.
 */
enum class IntegrationStatus {
    WORKING,
    CONFIGURED,
    MISSING,
    UNKNOWN;

    companion object {
        fun from(raw: String?): IntegrationStatus = when (raw) {
            "working" -> WORKING
            "configured" -> CONFIGURED
            "missing" -> MISSING
            else -> UNKNOWN
        }
    }
}

/** The pill's words. Matches the React admin's `STATUS_LABEL` word for word. */
fun integrationStatusLabel(status: IntegrationStatus): String = when (status) {
    IntegrationStatus.WORKING -> "Working"
    IntegrationStatus.CONFIGURED -> "Set up, not verified"
    IntegrationStatus.MISSING -> "Missing"
    IntegrationStatus.UNKNOWN -> "Could not check"
}

/** One credential. Booleans and a character count, by construction: never a value. */
data class IntegrationSecretState(
    val name: String,
    val required: Boolean,
    val purpose: String,
    /** Some deployed function binds this name. Meaningless when declaredKnown is false. */
    val declared: Boolean,
    /** The name reached the function that answered. */
    val resolves: Boolean,
    /** Characters, 0 when absent. A count, never a sample. */
    val length: Int,
)

/** What the server actually exercised. `none` means no free check exists. */
data class IntegrationLiveness(
    val outcome: String,
    val detail: String,
)

data class ServerIntegration(
    val key: String,
    val name: String,
    val purpose: String,
    val status: IntegrationStatus,
    val summary: String,
    val secrets: List<IntegrationSecretState>,
    val liveness: IntegrationLiveness,
    /** The exact operator step, with the command. Empty when nothing is owed. */
    val remediation: String,
    /** A console step this repo cannot take for them. Empty when there is none. */
    val externalStep: String,
    /** The settings section that owns this one's flow, e.g. `googleCalendar`. */
    val ownedBySection: String,
)

data class IntegrationsHealth(
    val checkedAt: String,
    /** False when the server could not read which secrets are declared anywhere. */
    val declaredKnown: Boolean,
    val declaredError: String,
    val integrations: List<ServerIntegration>,
)

/**
 * One credential as the row reads it. Pure, so the whole matrix is covered
 * without Compose.
 *
 * The undeclared warning is WITHHELD when the server could not read the declared
 * set: a false `declared` there is an artefact of the failed read, and printing
 * it as a finding would send the operator to edit a function that was already
 * correct.
 */
fun integrationSecretLine(secret: IntegrationSecretState, declaredKnown: Boolean): String {
    val set = if (secret.resolves) "set, ${secret.length} characters" else "not set"
    val undeclared =
        if (declaredKnown && !secret.declared) " · no deployed function declares this" else ""
    val optional = if (secret.required) "" else " · optional"
    return "${secret.name} · $set$undeclared$optional"
}

/**
 * When the answer was worked out, in the operator's own time zone.
 *
 * An unparseable stamp says so rather than being dropped: a panel with no
 * "checked at" line reads as freshly loaded whatever its age, and a stale
 * verdict about whether the business can take a payment is the one thing this
 * panel must not present as current.
 */
fun integrationsCheckedLabel(iso: String): String {
    if (iso.isBlank()) return "The server did not stamp this check with a time."
    val at = runCatching {
        java.time.Instant.parse(iso)
            .atZone(java.time.ZoneId.systemDefault())
            .format(java.time.format.DateTimeFormatter.ofPattern("MMM d, HH:mm"))
    }.getOrNull() ?: return "Checked at a time that could not be read ($iso)."
    return "Checked $at."
}

/**
 * The settings mock's `.logo` letter (issue #755 pass): the first character
 * of the service's name, upper-cased, or a question mark for a blank name.
 * Mirrors `monogram` in the web `IntegrationsSection.tsx`.
 */
fun integrationMonogram(name: String): String {
    val first = name.trim().firstOrNull() ?: return "?"
    return first.uppercaseChar().toString()
}

/**
 * Which brand gradient a service's monogram tile takes: a stable pick by the
 * name, so the same service reads with the same colour signature every time
 * the panel opens. The hash is `avatarPaletteFor`'s (the one the web
 * `gradientForSeed` ports), kept non-negative by the mask so the modulo is
 * always in range. A blank name takes the first gradient.
 */
fun integrationGradientIndex(name: String, count: Int): Int {
    require(count > 0) { "count must be positive" }
    if (name.isEmpty()) return 0
    var h = 0
    for (ch in name) h = (h * 31 + ch.code) and 0x7FFFFFFF
    return h % count
}
