package com.tribetails.auntieos.web.screens.media

import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.MediaFile

/**
 * #13 global Gallery: pure filtering + lookup helpers over the all-media list. Kept
 * separate from the screen so the selection logic is unit-tested (no Compose).
 */
data class GalleryFilter(
    val kinfolkId: String? = null,   // household; null = all households
    val fileType: String? = null,    // "IMAGE" | "VIDEO" | ...; null = all types
    val monthPrefix: String? = null, // "YYYY-MM"; null = all months
)

/** Apply the active filters, newest first (uploadedAt desc). Pure; tested. */
fun filterGalleryMedia(all: List<MediaFile>, filter: GalleryFilter): List<MediaFile> =
    all.asSequence()
        .filter { filter.kinfolkId == null || it.kinfolkId == filter.kinfolkId }
        .filter { filter.fileType == null || it.fileType.equals(filter.fileType, ignoreCase = true) }
        .filter { filter.monthPrefix == null || it.uploadedAt.startsWith(filter.monthPrefix) }
        .sortedByDescending { it.uploadedAt }
        .toList()

/** Distinct YYYY-MM buckets present, newest first (for the month filter). */
fun galleryMonths(all: List<MediaFile>): List<String> =
    all.map { it.uploadedAt.take(7) }
        .filter { it.length == 7 && it[4] == '-' }
        .distinct()
        .sortedDescending()

/** Distinct kinfolkIds present (blank dropped) for the kinfolk filter. */
fun galleryKinfolkIds(all: List<MediaFile>): List<String> =
    all.map { it.kinfolkId }.filter { it.isNotBlank() }.distinct()

/** Distinct fileTypes present (for the type filter). */
fun galleryFileTypes(all: List<MediaFile>): List<String> =
    all.map { it.fileType }.filter { it.isNotBlank() }.distinct().sorted()

/** Resolve a file's taggedKinIds to display names via a kin lookup (unknown ids dropped). */
fun taggedKinNames(media: MediaFile, kinById: Map<String, Kin>): List<String> =
    media.taggedKinIds.mapNotNull { id -> kinById[id]?.name?.takeIf { it.isNotBlank() } }

/** Kin selectable when tagging a file: scoped to the file's kinfolk when known, else all. */
fun taggableKin(media: MediaFile, allKin: List<Kin>): List<Kin> =
    if (media.kinfolkId.isNotBlank()) allKin.filter { it.kinfolkId == media.kinfolkId } else allKin
