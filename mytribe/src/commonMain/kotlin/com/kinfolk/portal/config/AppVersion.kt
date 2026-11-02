package com.kinfolk.portal.config

/**
 * The release number the About screen prints (#1411), or "" when this build
 * carries none; the screen then leaves the row out rather than invent one.
 *
 * Android reads `BuildConfig.VERSION_NAME`, which `build.gradle.kts`
 * `appVersionName()` sets to RELEASE_VERSION on a release build and to the last
 * tag plus "-dev" otherwise. The web portal's `lib/appVersion.ts` applies the
 * same rule, so both clients print one number for one release. The desktop and
 * Kotlin/JS targets ship no release of their own and answer "".
 */
expect fun appVersionName(): String
