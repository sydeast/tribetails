import java.util.Properties
import java.io.ByteArrayOutputStream

/**
 * Version identity, derived from git so it cannot silently repeat.
 *
 * Both helpers FALL BACK rather than failing the build: a source zip with no
 * .git still has to compile. The fallbacks are deliberately obvious (0 / "nogit")
 * so an un-versioned artifact is recognisable instead of masquerading as a real
 * release.
 */
fun gitOutput(vararg args: String, fallback: String): String =
    try {
        val out = ByteArrayOutputStream()
        val proc = ProcessBuilder(*args)
            .directory(rootDir)
            .redirectErrorStream(true)
            .start()
        proc.inputStream.copyTo(out)
        if (proc.waitFor() == 0) out.toString().trim().ifEmpty { fallback } else fallback
    } catch (_: Exception) {
        fallback
    }

/** Monotonic across a linear history, which is what Android requires of versionCode. */
fun gitCommitCount(): Int = gitOutput("git", "rev-list", "--count", "HEAD", fallback = "0").toIntOrNull() ?: 0

/** Short SHA, so a tester's screenshot maps to an exact commit. */
fun gitShortSha(): String = gitOutput("git", "rev-parse", "--short", "HEAD", fallback = "nogit")

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.google.services)
    alias(libs.plugins.sentry)
    // Roborazzi gradle plugin omitted: 1.46.1 needs AGP's removed TestedExtension.
    // The roborazzi *library* (captureRoboImage) works standalone; record mode is
    // driven by the roborazzi.test.record system property set on the test task below.
}

val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) load(f.inputStream())
}

kotlin {
    jvmToolchain(21)
}

val requiredReleaseSigningProps = listOf("KEYSTORE_PATH", "KEYSTORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD")
val missingReleaseSigningProps = requiredReleaseSigningProps.filter { localProps.getProperty(it).isNullOrBlank() }
val canSignReleaseApk = missingReleaseSigningProps.isEmpty()
android {
    namespace = "com.tribetails.auntieos"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.tribetails.auntieos"
        minSdk = 26
        targetSdk = 36
        // Derived from git, NOT hardcoded. Three App Distribution releases all
        // shipped as "0.2.0 (2)" with different code and different release
        // notes, so testers could not tell them apart and Android did not treat
        // a new build as an upgrade. A human-incremented number gets forgotten;
        // the commit count cannot be.
        //
        // versionCode must be monotonically increasing for Android to accept an
        // upgrade, which `git rev-list --count` guarantees on a linear history.
        // versionName carries the short SHA so a tester's screenshot is
        // traceable to an exact commit.
        versionCode = gitCommitCount()
        versionName = "0.2.0.${gitCommitCount()}-${gitShortSha()}"

        // GOOGLE_CALENDAR_ID + GOOGLE_SERVICE_ACCOUNT_EMAIL are now SERVER-ONLY
        // config (slice 8). The Google Calendar busy sync runs in the
        // syncGoogleCalendarBusyEvents Cloud Function via Application Default
        // Credentials, so no calendar id or service-account key ships in the APK.
        buildConfigField("String", "SENTRY_DSN", "\"${localProps.getProperty("SENTRY_DSN") ?: project.findProperty("SENTRY_DSN") ?: ""}\"")
    }

    // Release signing, resolved LAZILY.
    //
    // signingConfigs.create runs its action eagerly, so the previous
    // `?: error(...)` fired during CONFIGURATION of any task. That made
    // `./gradlew :app:testDebugUnitTest` fail on every machine without the
    // keystore, including CI, even though debug tests need no signing at all.
    // The android CI job never revealed it because the Mapbox token gate skipped
    // the job first, so one missing secret was hiding another.
    //
    // Now: no keystore means debug still builds and tests, and only an actual
    // release assembly fails, at execution time, naming what is missing.
    val canSignRelease = canSignReleaseApk

    signingConfigs {
        if (canSignRelease) {
            create("release") {
                storeFile = file(localProps.getProperty("KEYSTORE_PATH"))
                storePassword = localProps.getProperty("KEYSTORE_PASSWORD")
                keyAlias = localProps.getProperty("KEY_ALIAS")
                keyPassword = localProps.getProperty("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Null when the keystore is absent. An unsigned release APK is never
            // silently produced: the guard below fails the assemble task.
            signingConfig = if (canSignRelease) signingConfigs.getByName("release") else null

            // Ship only the ABIs real phones use.
            //
            // Twilio Voice and Mapbox each vendor a native library, and without
            // this the release APK carried all four ABIs: measured at 117MB, of
            // which roughly 59MB was x86 and x86_64. Those exist for EMULATORS,
            // and testers install this on hardware, so that was download size
            // the testers paid for and never executed.
            //
            // Scoped to release ONLY, on purpose. Debug keeps all four ABIs so
            // the app still runs on an x86_64 emulator during development,
            // which is where those two are genuinely wanted.
            ndk {
                abiFilters += listOf("arm64-v8a", "armeabi-v7a")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
            isIncludeAndroidResources = true
            all {
                // Roborazzi record mode (plugin omitted under AGP 9) for the visual harness.
                //
                // OFF by default. Recording rewrites the tracked PNGs under visual/android/,
                // so a plain `./gradlew test` used to drag 20 screenshot changes into any
                // `git add -A`. Opt in only when you mean to re-capture:
                //   ./gradlew :app:testDebugUnitTest -Proborazzi.record=true
                // Then verify/approve from web/visual (npm run visual:verify | visual:approve).
                // Roborazzi compares this property against the literal "true", and
                // captureRoboImage early-returns when no task type is enabled, so
                // "false" makes the screenshot tests run without touching any file.
                // A bare `-Proborazzi.record` arrives as "" from Gradle; treat that
                // as opt-in rather than silently doing nothing.
                val recordProp = project.findProperty("roborazzi.record")?.toString()
                val record = when (recordProp) {
                    null -> false
                    "" -> true
                    else -> recordProp.toBoolean()
                }
                it.systemProperty("roborazzi.test.record", record.toString())
            }
        }
    }


    buildFeatures {
        compose = true
        buildConfig = true
        viewBinding = true
        resValues = true
    }

    packaging {
        resources {
            excludes += "META-INF/DEPENDENCIES"
            excludes += "META-INF/INDEX.LIST"
        }
        jniLibs {
            useLegacyPackaging = false
        }
    }
}

// Verify gRPC version pins at build time. Run: ./gradlew verifyGrpcVersionPins
// See GrpcVersionRegressionTest.kt for the full history of why these versions matter.
tasks.register("verifyGrpcVersionPins") {
    doLast {
        val config = configurations.getByName("debugRuntimeClasspath")
        val resolved = config.resolvedConfiguration.resolvedArtifacts
        val grpcModules = mapOf(
            "grpc-api" to "1.62.2",
            "grpc-core" to "1.62.2",
            "grpc-context" to "1.62.2"
        )
        var failed = false
        grpcModules.forEach { (module, expected) ->
            val actual = resolved
                .firstOrNull { it.moduleVersion.id.module.group == "io.grpc" && it.moduleVersion.id.module.name == module }
                ?.moduleVersion?.id?.version
            if (actual != expected) {
                logger.error("GRPC VERSION VIOLATION: io.grpc:$module expected=$expected actual=${actual ?: "NOT FOUND"}")
                logger.error("  Fix: restore force(\"io.grpc:$module:$expected\") in configurations.all in app/build.gradle.kts")
                failed = true
            }
        }
        check(!failed) { "gRPC version pins violated — see errors above" }
        logger.lifecycle("gRPC version pins OK (grpc-api/core/context all at 1.62.2)")
    }
}

sentry {
    org = "tribetails"
    projectName = "auntieos-admin"
    autoUploadProguardMapping = true
    includeProguardMapping = true
    uploadNativeSymbols = false
    autoUploadNativeSymbols = false
    ignoredBuildTypes = setOf("debug")
}

configurations.all {
    resolutionStrategy {
        force("io.grpc:grpc-api:1.62.2")
        force("io.grpc:grpc-context:1.62.2")
        force("io.grpc:grpc-core:1.62.2")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.constraintlayout)

    // Network
    implementation(libs.retrofit)
    implementation(libs.retrofit.gson)
    implementation(libs.okhttp.logging)
    implementation(libs.gson)

    // Firebase
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.firebase.analytics)
    implementation(libs.firebase.firestore)
    implementation(libs.firebase.storage)
    implementation(libs.firebase.auth)
    implementation(libs.firebase.functions)

    // Coroutines
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)

    // DataStore (token persistence)
    implementation(libs.datastore.preferences)

    // Chrome Custom Tabs
    implementation(libs.browser)

    // AppCompat
    implementation(libs.appcompat)

    // Twilio Voice SDK
    implementation(libs.twilio.voice)

    // Google Calendar busy sync is server-side (syncGoogleCalendarBusyEvents
    // Cloud Function via ADC); the client-side Calendar API + service-account
    // libraries were removed in slice 8 so no calendar key ships in the APK.

    // Coil for Image Loading
    implementation(libs.coil.compose)
    implementation(libs.coil.svg)

    // Lottie (Compottie)
    implementation(libs.compottie)
    implementation(libs.compottie.dot)

    // Telephoto zoomable image
    implementation(libs.telephoto.coil)

    // Calendar
    implementation(libs.calendar.compose)

    // Media3 / ExoPlayer
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)

    // Cloudinary for Media Upload
    implementation(libs.cloudinary.android)
    implementation(libs.cloudinary.android.download)

    // Camera and Image Handling
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.androidx.exifinterface)

    // Mapbox for Location Tracking and Maps
    implementation(libs.mapbox.maps.android)

    // Location Services
    implementation(libs.google.play.services.location)
    implementation(libs.google.play.services.maps)

    // Sentry
    implementation(libs.sentry.android)

    // Composables (headless primitives — matches web AuntieTheme tokens)
    implementation(libs.composables.core)
    implementation(libs.composables.icons.lucide)

    // Testing
    testImplementation(libs.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
// Fail LOUD, at execution time, if someone tries to ship a release without the
// keystore. Configuration stays clean so debug and unit tests run anywhere; this
// only trips on an actual release assembly, and it names the missing keys rather
// than emitting an unsigned APK.
if (!canSignReleaseApk) {
    tasks.matching { it.name.startsWith("assemble") && it.name.contains("Release") }.configureEach {
        doFirst {
            error(
                "Cannot assemble a signed release: missing " + missingReleaseSigningProps.joinToString(", ") +
                    " in android/local.properties. Debug builds and unit tests do not need these."
            )
        }
    }
}
