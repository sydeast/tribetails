package com.kinfolk.portal.firebase

import com.kinfolk.portal.components.RoutePoint

/**
 * Decoding for `kin_care_sessions/{id}/breadcrumbs`, the household's live GPS
 * read.
 *
 * TWO WRITERS, TWO SHAPES, and until issue #607 the Kotlin clients read only
 * one of them. Android's `LocationPoint` (`data/model/LocationModels.kt`)
 * writes `latitude` / `longitude` / `timestamp` as epoch millis. The wasm web
 * client, retired in #513, wrote `lat` / `lng` / `timestamp` as an ISO string.
 * `GitliveFirestoreClient` read the short pair and the string clock only, so
 * every point of every current visit was unreadable to it.
 *
 * It did not drop those points, which would at least have been honest. It
 * defaulted each missing coordinate to `0.0`, so an Android breadcrumb decoded
 * to (0.0, 0.0) and the household was shown a route running to null island.
 * That is why the miss is corrected here rather than at the call site: a
 * default is what turned a silent gap into a wrong answer.
 *
 * WHY THIS LIVES IN commonMain. `GitliveFirestoreClient` is `firebaseMain` and
 * needs a live Firestore to instantiate, so nothing in it can be tested. The
 * decode is the part with the bug and the part worth pinning, so it is a pure
 * function over the document's own field map, covered by `BreadcrumbDecodeTest`
 * in commonTest.
 *
 * THERE ARE THREE COPIES OF THIS FUNCTION, in three languages:
 * `mytribe/web/src/lib/breadcrumbs.ts`, `auntieos-admin/src/lib/breadcrumbs.ts`
 * and this one. They cannot be shared, so they are kept semantically identical
 * instead, and each carries a test naming both wire shapes. Change one, change
 * all three.
 */

/** Any Firestore number as a Double, or null when the field is absent or not a number. */
private fun numberOrNull(v: Any?): Double? = (v as? Number)?.toDouble()?.takeIf { !it.isNaN() && !it.isInfinite() }

/**
 * One breadcrumb document as a [RoutePoint], or null when it carries no usable
 * coordinate pair.
 *
 * `lat`/`lng` is preferred over `latitude`/`longitude` only because a document
 * carrying both was written by something that meant the short pair; no writer
 * in the tree emits both today, so the order is a tiebreak that should never
 * fire rather than a rule.
 *
 * `timestamp` is read as any `Number` before it is read as a string, because
 * Gitlive surfaces a Firestore number as Long or Double depending on target and
 * on how it was written. A point whose timestamp is neither still counts: it
 * has a real location, and the map does not draw the clock. Dropping it would
 * put a hole in the polyline over a field nothing renders.
 */
fun decodeBreadcrumb(data: Map<String, Any?>): RoutePoint? {
    val lat = numberOrNull(data["lat"]) ?: numberOrNull(data["latitude"]) ?: return null
    val lng = numberOrNull(data["lng"]) ?: numberOrNull(data["longitude"]) ?: return null
    val t = (data["timestamp"] as? Number)?.toLong()
        ?: (data["timestamp"] as? String)?.let(::parseIsoMs)
    return RoutePoint(lat = lat, lng = lng, t = t)
}

/**
 * Chronological, on the DECODED millisecond value.
 *
 * Firestore sorts a mixed-type field by type group first, so a server
 * `orderBy("timestamp")` would return every Android ping before every web one
 * regardless of when they were taken. That is a second reason the query carries
 * no `orderBy`, alongside the index it would need.
 *
 * A point with no usable timestamp sorts to the front rather than being
 * dropped, which is the `?: 0` the stream has always used.
 */
fun orderBreadcrumbs(points: List<RoutePoint>): List<RoutePoint> = points.sortedBy { it.t ?: 0L }

/** Slim ISO-8601 -> epoch ms. Returns null on parse failure. */
internal fun parseIsoMs(iso: String): Long? = runCatching {
    if (iso.length < 19) return@runCatching null
    val y = iso.substring(0, 4).toInt()
    val mo = iso.substring(5, 7).toInt()
    val d = iso.substring(8, 10).toInt()
    val h = iso.substring(11, 13).toInt()
    val mi = iso.substring(14, 16).toInt()
    val s = iso.substring(17, 19).toInt()
    daysFromCivil(y, mo, d) * 86_400_000L + h * 3_600_000L + mi * 60_000L + s * 1_000L
}.getOrNull()

private fun daysFromCivil(y: Int, m: Int, d: Int): Long {
    val yy = if (m <= 2) y - 1 else y
    val era = if (yy >= 0) yy / 400 else (yy - 399) / 400
    val yoe = (yy - era * 400).toLong()
    val mp = if (m > 2) m - 3 else m + 9
    val doy = (153 * mp + 2) / 5 + d - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097L + doe - 719_468L
}
