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
/** Heading for kin whose household is blank or no longer resolves (#1604). */
const val UNKNOWN_HOUSEHOLD_LABEL = "Household unavailable"
/** One household's kin in the tag picker (#1604). [kinfolkId] is blank for kin with no household on the document. */
data class KinHouseholdGroup(val kinfolkId: String, val label: String, val kin: List<Kin>)
/**
 * Groups a kin roster under the household each belongs to (#1604). Mirrors the web
 * `groupKinByHousehold`.
 *
 * The tag dialog offers the WHOLE roster for a file with no household (company
 * media, operator ruling 2026-07-31), and a flat list of first names across every
 * family invited tagging the wrong family's pet. Households sort by label and kin
 * by name, both ignoring case. Kin with no household, or one [labelFor] cannot
 * resolve, sort last under [UNKNOWN_HOUSEHOLD_LABEL]: an orphaned row is visible,
 * never attached to an arbitrary family and never shown as a raw id.
 */
fun groupKinByHousehold(kin: List<Kin>, labelFor: (String) -> String?): List<KinHouseholdGroup> =
    kin.groupBy { it.kinfolkId.trim() }
        .map { (id, rows) ->
            val label = if (id.isEmpty()) UNKNOWN_HOUSEHOLD_LABEL
            else labelFor(id)?.trim()?.takeIf { it.isNotEmpty() } ?: UNKNOWN_HOUSEHOLD_LABEL
            KinHouseholdGroup(id, label, rows.sortedBy { it.name.trim().lowercase() })
        }
        .sortedWith(
            compareBy<KinHouseholdGroup> { it.label == UNKNOWN_HOUSEHOLD_LABEL }
                .thenBy { it.label.lowercase() },
        )
