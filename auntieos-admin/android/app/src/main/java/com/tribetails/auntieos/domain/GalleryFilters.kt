package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType

/**
 * #13 global Gallery: pure filtering + lookup helpers over the all-media list. Mirrors
 * the web `screens/media/GalleryFilters.kt`. Kept out of the screen so the selection
 * logic is unit-tested.
 */
data class GalleryFilter(
    val kinfolkId: String? = null,
    val fileType: MediaType? = null,
    val monthPrefix: String? = null, // "YYYY-MM"
)

/** Apply the active filters, newest first (uploadedAt desc). */
fun filterGalleryMedia(all: List<MediaFile>, filter: GalleryFilter): List<MediaFile> =
    all.asSequence()
        .filter { filter.kinfolkId == null || it.kinfolkId == filter.kinfolkId }
        .filter { filter.fileType == null || it.fileType == filter.fileType }
        .filter { filter.monthPrefix == null || it.uploadedAt.startsWith(filter.monthPrefix) }
        .sortedByDescending { it.uploadedAt }
        .toList()

/** Distinct YYYY-MM buckets present, newest first. */
fun galleryMonths(all: List<MediaFile>): List<String> =
    all.map { it.uploadedAt.take(7) }
        .filter { it.length == 7 && it[4] == '-' }
        .distinct()
        .sortedDescending()

/** Distinct kinfolkIds present (blank dropped). */
fun galleryKinfolkIds(all: List<MediaFile>): List<String> =
    all.map { it.kinfolkId }.filter { it.isNotBlank() }.distinct()

/**
 * True when at least one row has no resolvable kinfolkId: media genuinely
 * unrelated to any household (operator ruling 2026-07-31: Kinfolk do not
 * "own" media). Gates the "No household" chip in GalleryScreen the same way
 * [galleryKinfolkIds]/[galleryFileTypes] already gate their own chip rows:
 * only offer a facet with real rows behind it. Mirrors web's
 * `galleryHasUnattachedMedia` (mediaFormat.ts).
 */
fun galleryHasUnattachedMedia(all: List<MediaFile>): Boolean = all.any { it.kinfolkId.isBlank() }

/** Distinct fileTypes present. */
fun galleryFileTypes(all: List<MediaFile>): List<MediaType> =
    all.map { it.fileType }.distinct().sortedBy { it.name }

/** Resolve a file's taggedKinIds to display names via a kin lookup (unknown ids dropped). */
fun taggedKinNames(media: MediaFile, kinById: Map<String, Kin>): List<String> =
    media.taggedKinIds.mapNotNull { id -> kinById[id]?.name?.takeIf { it.isNotBlank() } }

/** Kin selectable when tagging a file: scoped to the file's kinfolk when known, else all. */
fun taggableKin(media: MediaFile, allKin: List<Kin>): List<Kin> =
    if (media.kinfolkId.isNotBlank()) allKin.filter { it.kinfolkId == media.kinfolkId } else allKin
