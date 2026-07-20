package com.kinfolk.portal.share

/**
 * Android stub. Share viewer is web-only (public URL → browser); Android
 * is never the runtime for unauth visitors. Fails loud so a wrong call
 * site surfaces immediately rather than silently swallowing.
 */
actual fun makeShareLinkFetcher(base: String): ShareLinkFetcher =
    object : ShareLinkFetcher {
        override suspend fun getShareLink(shareId: String, passcode: String?): GetShareLinkResult =
            throw ShareFetchException("Share viewer is web-only. Open the share link in a browser.")
        override suspend fun postGuestComment(
            shareToken: String, taleId: String, body: String, guestName: String, guestEmail: String,
            recaptchaToken: String, parentCommentId: String?,
        ): String = throw ShareFetchException("Share viewer is web-only.")
    }
