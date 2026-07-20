package com.kinfolk.portal.auth

actual fun platformUserAgent(): String =
    "MyTribe-Android/${android.os.Build.MODEL} (Android ${android.os.Build.VERSION.RELEASE})"
