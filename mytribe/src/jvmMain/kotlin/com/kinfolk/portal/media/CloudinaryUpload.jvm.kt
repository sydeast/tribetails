package com.kinfolk.portal.media

/** JVM: stub. PhotoPicker on JVM also returns null so this is unreachable. */
actual suspend fun uploadImageToCloudinary(
    signed: CloudinarySignedUpload,
    image: PickedImage,
): String? {
    println("[CloudinaryUpload] JVM stub — desktop dev runs cannot upload images")
    return null
}
