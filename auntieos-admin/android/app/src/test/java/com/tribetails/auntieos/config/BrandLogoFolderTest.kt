package com.tribetails.auntieos.config

import com.tribetails.auntieos.data.model.MediaEntityType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1593: `saveBusinessSettings` takes a `logoUrl` only when it is blank, the
 * stored value, or an image under `BRAND_ASSET_FOLDER`
 * (`tribetails/business/business_settings`, `mytribe/functions/src/lib/brandAsset.ts`).
 * The Branding panel uploads with `entityType = BUSINESS, entityId =
 * "business_settings"` and stages the delivery URL, so both must land there or
 * every logo save is refused.
 *
 * The server check (`assertCloudinaryUrlInFolder`): host `res.cloudinary.com`,
 * path under `/<cloud>/image/upload/`, and the folder as a path segment.
 */
class BrandLogoFolderTest {

    private val brandAssetFolder = "tribetails/business/business_settings"

    @Test
    fun `a Branding upload asks the signer for the brand asset folder`() {
        assertEquals(brandAssetFolder, CloudinaryConfig.getFolderPath(MediaEntityType.BUSINESS.name, "business_settings"))
    }

    @Test
    fun `the staged logo URL passes the server's folder check`() {
        // Cloudinary's public_id carries the folder it was uploaded into.
        val url = CloudinaryConfig.getDeliveryUrl("$brandAssetFolder/business_1731100000000", isVideo = false, format = "png")
        val path = java.net.URI(url).path
        assertTrue(url.startsWith("https://res.cloudinary.com/"))
        assertTrue(path.startsWith("/${CloudinaryConfig.CLOUD_NAME}/image/upload/"))
        assertTrue(path.contains("/$brandAssetFolder/"))
    }
}
