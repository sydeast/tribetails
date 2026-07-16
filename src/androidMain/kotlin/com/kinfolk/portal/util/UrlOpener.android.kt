package com.kinfolk.portal.util

import android.content.Intent
import android.net.Uri
import com.kinfolk.portal.KinfolkPortalApplication

actual fun openExternalUrl(url: String) {
    val ctx = KinfolkPortalApplication.appContext ?: return
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    ctx.startActivity(intent)
}
