package com.kinfolk.portal.screens.kin

import com.kinfolk.portal.media.PickedImage

/**
 * #1291. What Save in [AddEditKinDialog] does to the Kin's photo. The photo is
 * not a [com.kinfolk.portal.portal.KinPayload] field the dialog edits: the
 * payload builder drops null fields, so a payload alone can never clear
 * `photoUrl`. Instead the dialog reports one of these, and [KinController]
 * runs the matching step after the text write lands.
 */
sealed interface KinPhotoChange {
    /** Leave `photoUrl` exactly as it is on the server. */
    data object Keep : KinPhotoChange

    /** Signed upload to Cloudinary, then confirmKinPhotoUpload writes the URL. */
    data class Upload(val image: PickedImage) : KinPhotoChange

    /** Clear `photoUrl` (an explicit null through updateKin). */
    data object Remove : KinPhotoChange

    companion object {
        /**
         * Folds the dialog's two photo controls into one change. A freshly
         * picked photo always wins over an earlier Remove tap: picking again
         * after removing means "use this one".
         */
        fun of(picked: PickedImage?, removeRequested: Boolean): KinPhotoChange = when {
            picked != null -> Upload(picked)
            removeRequested -> Remove
            else -> Keep
        }
    }
}
