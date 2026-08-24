rootProject.name = "kinfolk-portal"

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    // Resolves JDK toolchains automatically when not present locally.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

// The Mapbox Maps SDK ships from Mapbox's own private maven repository, which
// takes an `sk.` downloads token as a password. That credential downloads the
// SDK at BUILD time and cannot authenticate a MapView; the runtime `pk.` token
// is a different credential, injected as a buildConfigField in build.gradle.kts.
//
// Resolved gradle-property first (which covers ~/.gradle/gradle.properties and
// ORG_GRADLE_PROJECT_MAPBOX_DOWNLOADS_TOKEN), then the environment. Blank counts
// as absent: an empty password would reach Mapbox as an anonymous request and
// come back 401, which reads as a network fault rather than a missing token.
val mapboxDownloadsToken: String? =
    (providers.gradleProperty("MAPBOX_DOWNLOADS_TOKEN").orNull
        ?: System.getenv("MAPBOX_DOWNLOADS_TOKEN"))
        ?.takeIf { it.isNotBlank() }

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")

        // Deliberately NOT the eager `?: throw GradleException(...)` that
        // auntieos-admin/android/settings.gradle.kts uses. Settings evaluation
        // runs for EVERY task, so a throw here would take down `:jvmTest` and
        // `compileKotlinJs` as well: two targets that carry no Mapbox dependency
        // at all and stay on the Canvas renderer permanently. `:jvmTest` is the
        // authoritative task for this module (see mytribe/CLAUDE.md), so a
        // missing mobile-maps credential must not be able to silence it. The
        // auntieos module has one target and never faced that trade.
        //
        // Still loud, and still never silently broken: with no token the
        // repository is not declared at all, so an Android build fails naming
        // the com.mapbox.maps coordinates it could not find, on top of the
        // banner below. What auntieos's throw protects against is a repository
        // declared with an EMPTY password, which fails as an opaque 401 instead.
        if (mapboxDownloadsToken != null) {
            maven {
                url = uri("https://api.mapbox.com/downloads/v2/releases/maven")
                credentials.username = "mapbox"
                credentials.password = mapboxDownloadsToken
                // Only Mapbox artifacts come from here, so no other dependency's
                // lookup is sent to Mapbox's server carrying our credential.
                content { includeGroupByRegex("com\\.mapbox(\\..*)?") }
            }
        }
    }
}

if (mapboxDownloadsToken == null) {
    logger.lifecycle(
        """
        |
        |  MAPBOX_DOWNLOADS_TOKEN is not set.
        |
        |  The Mapbox maven repository is NOT declared for this build, so the
        |  androidTarget cannot resolve com.mapbox.maps:android and every
        |  Android task will fail. :jvmTest and compileKotlinJs are unaffected:
        |  those targets render the Canvas polyline and never touch the Maps SDK.
        |
        |  Set it in ~/.gradle/gradle.properties, or export it:
        |      MAPBOX_DOWNLOADS_TOKEN=<the sk. downloads token>
        |
        """.trimMargin()
    )
}
