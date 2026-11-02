package com.kinfolk.portal.config

import com.kinfolk.portal.BuildConfig

/** Android: the versionName gradle derived (RELEASE_VERSION, else last tag + "-dev"). */
actual fun appVersionName(): String = BuildConfig.VERSION_NAME.trim()
