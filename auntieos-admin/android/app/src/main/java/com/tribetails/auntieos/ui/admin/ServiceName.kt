package com.tribetails.auntieos.ui.admin

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.serviceTone
import com.tribetails.auntieos.util.runCatchingCancellable
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * What a visit's service is CALLED, resolved against the operator's KinCare
 * catalog (#1592: the Schedule legend and KinTales rows printed `visit_60`, and
 * Bookings printed `30minute`). Port of the web `bookingServiceName`
 * (`auntieos-admin/src/lib/bookingFormat.ts`); the two must agree.
 *
 * `kin_care_sessions.serviceType` is free text holding several spellings of the
 * same few services (`visit_60`, `60Mins`, `30 Minute`, `30Minute`). In order:
 *  1. The catalog key itself, matched on letters and digits alone.
 *  2. The one catalog entry that runs as long as the label states, when exactly
 *     one does (a bare trailing number is read as minutes, the `visit_60`
 *     shape). Two 60-minute KinCares resolve to nothing rather than a guess.
 *
 * Unresolved falls back to the stored text, never a placeholder; only a blank
 * field becomes "Visit". The name returned is the catalog KEY, which is what the
 * KinCare settings and the booking picker show.
 */
fun bookingServiceName(
    rawServiceType: String?,
    serviceRates: Map<String, String>,
    serviceDurations: Map<String, String> = emptyMap(),
): String {
    val label = rawServiceType?.trim().orEmpty()
    if (label.isEmpty()) return "Visit"
    val keys = serviceRates.keys.map { it.trim() }.filter { it.isNotEmpty() }
    val wanted = normaliseServiceKey(label)
    keys.firstOrNull { normaliseServiceKey(it) == wanted }?.let { return it }
    val minutes = labelMinutes(label)
    if (minutes != null) {
        val sameLength = keys.filter {
            (storedDurationMinutes(serviceDurations[it]) ?: serviceDurationMinutes(it)) == minutes
        }
        if (sameLength.size == 1) return sameLength.first()
    }
    return label
}

/**
 * The KinCare catalog a stored service is named and coloured against:
 * `business_settings.serviceRates` and `serviceDurations` together (#1592).
 *
 * One value handed to every Schedule mark, so the legend, the agenda rows, the
 * Bookings cards and the month dots all resolve a stored `visit_60` the same
 * way. Before it the legend resolved with both maps and the rows with the rates
 * alone, so a KinCare whose length lived only in `serviceDurations` was named on
 * the legend and printed raw on the row.
 */
data class ServiceCatalog(
    val serviceRates: Map<String, String> = emptyMap(),
    val serviceDurations: Map<String, String> = emptyMap(),
) {
    /** [bookingServiceName] against this catalog. */
    fun nameOf(rawServiceType: String?): String = bookingServiceName(rawServiceType, serviceRates, serviceDurations)
}

/**
 * THE tone of a stored booking service, for every mark that colours a visit:
 * the legend swatch, the agenda pill, the month dot (#1592).
 *
 * Keyed on the NAME [bookingServiceName] resolves, never the stored text. The
 * legend names each service and dedupes on that name, so it can only colour by
 * the name; a dot coloured by the stored `visit_60` while its legend row was
 * coloured by the KinCare it resolves to ("Dog walk") drew two colours for one
 * service, and renaming a KinCare moved the swatch without the dots. Same rule
 * as the web `bookingServiceTone`.
 */
fun bookingServiceTone(rawServiceType: String?, catalog: ServiceCatalog): AuntieStatusTone =
    serviceTone(catalog.nameOf(rawServiceType))

/** The catalog fields of the operator's settings. */
fun BusinessSettings.serviceCatalog(): ServiceCatalog = ServiceCatalog(serviceRates, serviceDurations)

/**
 * One `business_settings` read shared by every screen that names a service
 * without loading settings itself (#1592: the household profile's visit rows,
 * KinTale detail). Port of the web `useBookingCatalog` + `sharedLoad`: callers
 * mounted together join one read, a later caller reuses it for [TTL_MS] so a
 * rename in Settings shows within that window, and a failed read is never kept.
 */
internal object SharedServiceCatalog {
    private const val TTL_MS = 5 * 60 * 1000L
    private val lock = Mutex()
    private var held: CompletableDeferred<ServiceCatalog>? = null
    private var settledAtMs = 0L

    /** What a caller shows before its read lands: the last good catalog, or empty. */
    @Volatile var latest: ServiceCatalog = ServiceCatalog()
        private set

    suspend fun load(read: suspend () -> Result<BusinessSettings>): ServiceCatalog? {
        val pending = lock.withLock {
            val current = held
            val fresh = current != null && (!current.isCompleted || System.currentTimeMillis() - settledAtMs < TTL_MS)
            if (fresh) return@withLock current!! to false
            CompletableDeferred<ServiceCatalog>().also { held = it } to true
        }
        val (deferred, owner) = pending
        if (owner) {
            val result = runCatchingCancellable { read().getOrThrow().serviceCatalog() }
            result.onSuccess {
                settledAtMs = System.currentTimeMillis()
                latest = it
                deferred.complete(it)
            }.onFailure {
                lock.withLock { if (held === deferred) held = null }
                deferred.completeExceptionally(it)
            }
        }
        return runCatching { deferred.await() }.getOrNull()
    }

    /** Tests only: forget the shared read. */
    internal fun reset() {
        held = null
        settledAtMs = 0L
        latest = ServiceCatalog()
    }
}

/**
 * The KinCare catalog for a composable that names a visit's service. Fails
 * quiet to the empty catalog, which [bookingServiceName] answers with the
 * stored text, so a row never shows a made-up name.
 */
@Composable
fun rememberServiceCatalog(): ServiceCatalog {
    val catalog by produceState(initialValue = SharedServiceCatalog.latest) {
        SharedServiceCatalog.load { AuntieOSApp.instance.repository.getBusinessSettings() }?.let { value = it }
    }
    return catalog
}

/** Letters and digits only, lowercased: "30 Minute", "30Minute" and "30-minute" are one id. */
private fun normaliseServiceKey(raw: String): String = raw.lowercase().replace(Regex("[^a-z0-9]"), "")

private val BARE_TRAILING_NUMBER = Regex("""(?:^|[^0-9A-Za-z])(\d{1,4})$""")

/** Minutes a label states: a stated unit wins, else a bare trailing number. */
private fun labelMinutes(label: String): Int? {
    serviceDurationMinutes(label)?.let { return it }
    val bare = BARE_TRAILING_NUMBER.find(label) ?: return null
    val minutes = bare.groupValues[1].toInt()
    return if (minutes > 0) minutes else null
}
