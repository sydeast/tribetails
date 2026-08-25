package com.tribetails.auntieos.media

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.GeoLocation
import com.tribetails.auntieos.data.model.LocationPoint

/**
 * ISSUE #519: `business_settings.enablePhotoLocationTagging`, which had a
 * control on three admin surfaces and no consumer anywhere.
 *
 * WHAT THE SWITCH NOW MEANS. When it is on, a photo added to a KinTale is
 * stamped with where the visit was when it was added, into
 * `MediaMetadata.location`. When it is off, that field is left null and no
 * coordinate is written to the media record at all. Before this, nothing wrote
 * it either way: the field existed on the Android media model and the single
 * `MediaMetadata(...)` construction site in the app never set it.
 *
 * ANDROID ONLY, and that is a fact about the models rather than a shortcut. The
 * React and desktop media models carry no location field of any kind
 * (`api/gallery.ts`, `web/.../MediaModels.kt`), and neither surface has a GPS
 * fix to offer, so "off" is already true on both and there is nothing to gate.
 *
 * THE FIX COMES FROM THE VISIT'S OWN BREADCRUMB TRAIL, not from a fresh location
 * request. Three reasons, in order of weight:
 *  1. It needs no permission the app does not already hold and no new prompt at
 *     the moment the operator is trying to attach a photo.
 *  2. It is the same trail the visit's route is drawn from, so a photo's pin and
 *     the route it sits on can never disagree.
 *  3. It fails safe. Breadcrumbs only exist while GPS tracking ran, so when the
 *     master switch is off there is nothing to read and nothing is stamped,
 *     without that having to be a second special case.
 *
 * THE MASTER SWITCH STILL WINS. `enableGPSTrackingForAllVisits` off means no
 * location is stamped whatever the tagging switch says: a business that has
 * turned GPS off has not agreed to store coordinates by another door.
 *
 * WHAT THIS DOES NOT CLOSE, said plainly because it is a real leak and not a
 * detail: the photo file itself is uploaded to Cloudinary byte for byte
 * (`MediaUploadManager.uploadToCloudinary`), and a camera's own EXIF GPS tag
 * rides along inside it whatever this setting says. Stripping that means
 * re-encoding the operator's photographs, which trades image quality for it and
 * is a decision nobody has made. It is named in the PR rather than silently
 * left as a gap this switch appears to cover.
 */
object PhotoLocationTagging {

    /**
     * The location to stamp on a photo being added to [settings]'s business, or
     * null when nothing should be stored.
     *
     * Null is returned for every reason there could be: the operator turned
     * tagging off, the operator turned GPS off entirely, or the visit simply has
     * no ping yet. The caller does not need to tell those apart, because they
     * all mean the same thing to the media record.
     */
    fun locationFor(settings: BusinessSettings, latestPing: LocationPoint?): GeoLocation? {
        if (!settings.enableGPSTrackingForAllVisits) return null
        if (!settings.enablePhotoLocationTagging) return null
        val ping = latestPing ?: return null
        // A ping at exactly (0, 0) is Null Island: the default a LocationPoint
        // carries before a real fix ever landed, not a place any visit happened.
        if (ping.latitude == 0.0 && ping.longitude == 0.0) return null
        return GeoLocation(
            latitude = ping.latitude,
            longitude = ping.longitude,
            accuracy = ping.accuracy,
        )
    }

    /**
     * The most recent usable ping of a visit, or null.
     *
     * Breadcrumbs arrive ordered by `timestamp` from the repository, but this
     * takes the max rather than the last element so an unsorted or partially
     * written list cannot stamp a photo with a location from an hour ago.
     */
    fun latestPing(points: List<LocationPoint>): LocationPoint? =
        points.filter { it.timestamp > 0L }.maxByOrNull { it.timestamp }
}
