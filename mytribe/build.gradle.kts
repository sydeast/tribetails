import java.io.ByteArrayOutputStream
import java.util.Properties
import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.kotlin.gradle.ExperimentalKotlinGradlePluginApi
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("multiplatform") version "2.4.20"
    id("org.jetbrains.compose") version "1.12.0"
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.20"
    // 9.3.1, up from 8.7.2, because androidx.core 1.19.0 declares "requires
    // Android Gradle plugin 9.1.0 or higher" in its AAR metadata and
    // checkReleaseAarMetadata FAILS the build on it rather than warning. That
    // check is why :assembleRelease did not build at all here, which is why this
    // app was never in a release run. Raised WITH the dependencies that demand
    // it, and matched to auntieos-admin/android, which is already on 9.3.1.
    // Needs Gradle 9.x; the wrapper moves with it.
    id("com.android.application") version "9.4.0"
    id("com.google.gms.google-services") version "4.5.0"
}

group = "com.kinfolk"
version = "0.2.0"

/**
 * Version identity, derived from git so it cannot silently repeat. Copied from
 * auntieos-admin/android/app/build.gradle.kts, which learned this the hard way:
 * three App Distribution releases there all shipped as "0.2.0 (2)" with
 * different code and different release notes, and testers could not tell them
 * apart. This module still carried that hardcoded pair, so every kinfolk-portal
 * build ever distributed has been "0.2.0 (2)" as well, and Android has never
 * treated one as an upgrade over the last.
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

// Mirrors auntieos-admin/android/app/build.gradle.kts:41. local.properties is
// gitignored and holds sdk.dir plus whatever a machine's own credentials are.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

kotlin {
    @OptIn(ExperimentalKotlinGradlePluginApi::class)
    applyDefaultHierarchyTemplate()

    compilerOptions {
        optIn.add("kotlin.time.ExperimentalTime")
        optIn.add("androidx.compose.ui.ExperimentalComposeUiApi")
        optIn.add("androidx.compose.material3.ExperimentalMaterial3Api")
    }

    jvm()
    jvmToolchain(17)

    androidTarget {
        apply(plugin = "com.google.gms.google-services")
        @OptIn(ExperimentalKotlinGradlePluginApi::class)
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_17)
        }
    }

    // wasmJs target removed: compile OOMs and JS target covers the web app.
    // Re-add later once heap-tuning + gitlive wasmJs support land.

    js {
        outputModuleName.set("kinfolk-portal")
        browser()
        binaries.executable()
    }

    sourceSets {
        val firebaseMain by creating {
            dependsOn(commonMain.get())
            dependencies {
                implementation("dev.gitlive:firebase-auth:2.7.0")
                implementation("dev.gitlive:firebase-firestore:2.7.0")
                implementation("dev.gitlive:firebase-functions:2.7.0")
                implementation("dev.gitlive:firebase-messaging:2.7.0")
            }
        }
        // firebaseMain = gitlive client SDK source set, only for android + js.
        // jvmMain uses Firebase REST APIs (gitlive on JVM is the Admin SDK).
        androidMain.get().dependsOn(firebaseMain)
        jsMain.get().dependsOn(firebaseMain)

        commonMain.dependencies {
            implementation(compose.runtime)
            implementation(compose.foundation)
            implementation(compose.animation)
            implementation(compose.material)
            implementation(compose.material3)
            implementation(compose.materialIconsExtended)
            implementation(compose.ui)
            // Multiplatform resources — bundles the brand fonts (Young Serif,
            // Bricolage Grotesque, DM Mono) from commonMain/composeResources/font
            // so all three targets render identical typography. See theme/Theme.kt.
            implementation(compose.components.resources)
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
            implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.8.0")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
            // Coil 3 multiplatform image loader for AsyncImage on Account avatar + KinTale media.
            // Per-platform network engines wired below (okhttp for android, ktor3 for js).
            implementation("io.coil-kt.coil3:coil-compose:3.6.2")
            // Routing (D-ROUTE1, chosen 2026-06-01): AndroidX Compose Navigation.
            // Spike confirmed it resolves + compiles on js(IR)/jvm/android with
            // Compose 1.10.1 / Kotlin 2.2.20. Migration off the hand-rolled TabShell
            // state machine to a NavHost is the next routing task.
            implementation("org.jetbrains.androidx.navigation:navigation-compose:2.9.2")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
        }
        // composeUiTest = the tests that need a running Compose host, kept OUT of
        // commonTest so the Android unit-test variant never collects them.
        //
        // Issue #473: `./gradlew testDebugUnitTest` failed 143 of 524 on a clean
        // main, every one of them the same NullPointerException out of
        // androidx.compose.ui.test.RobolectricIdlingStrategy, where
        // `Build.FINGERPRINT` is null because the Android unit-test variant runs
        // against the stub android.jar. Those tests could not pass there and were
        // verifying nothing; the other 381 ran fine.
        //
        // Robolectric is the obvious answer and it does not work here. Compose's
        // `runComposeUiTest` launches `androidx.activity.ComponentActivity` through
        // ActivityScenario, so that activity has to be in the manifest Robolectric
        // reads. Robolectric reads the binary manifest inside
        // `apk_for_local_test`, and AGP builds that one from the MAIN manifest, not
        // the merged unit-test manifest, so the declaration that
        // `androidx.compose.ui:ui-test-manifest` contributes never arrives, and the
        // launch dies with "Unable to resolve activity". Verified on this branch:
        // adding robolectric 4.16.1 + ui-test-manifest 1.10.1 gets past
        // FINGERPRINT and straight into that. The only way through would be to
        // declare a test-only activity in the app's shipping AndroidManifest, which
        // is a worse trade than this source set.
        //
        // These tests are NOT skipped. Every one of them runs, unchanged, under
        // `:jvmTest`, the task that counts for this module. See CLAUDE.md.
        val composeUiTest by creating {
            dependsOn(commonTest.get())
            dependencies {
                @OptIn(org.jetbrains.compose.ExperimentalComposeLibrary::class)
                implementation(compose.uiTest)
            }
        }
        jvmTest.get().dependsOn(composeUiTest)
        jsTest.get().dependsOn(composeUiTest)
        jvmMain.dependencies {
            implementation(compose.desktop.currentOs)
            // Ktor client + JSON for Firebase REST (Auth + Firestore).
            implementation("io.ktor:ktor-client-core:3.5.2")
            implementation("io.ktor:ktor-client-cio:3.5.2")
            implementation("io.ktor:ktor-client-content-negotiation:3.5.2")
            implementation("io.ktor:ktor-serialization-kotlinx-json:3.5.2")
        }
        val jvmTest by getting {
            dependencies {
                implementation(compose.desktop.currentOs)
                implementation(compose.desktop.uiTestJUnit4)
            }
        }
        androidMain.dependencies {
            // The Firebase BOM, required from AGP 9 on. gitlive's android
            // artifacts (firebase-auth-android, -firestore-android,
            // -messaging-android) declare their com.google.firebase deps with
            // NO version and expect the consumer to supply the platform. AGP
            // 8.7.2 resolved them anyway; AGP 9 does not, and the build dies at
            // :compileReleaseKotlinAndroid with
            //   Could not find com.google.firebase:firebase-auth:
            // (note the empty version). Pinning the BOM is the supported answer
            // and it also stops the three SDKs drifting apart from each other.
            implementation(project.dependencies.platform("com.google.firebase:firebase-bom:34.18.0"))
            implementation("com.google.firebase:firebase-analytics-ktx:22.5.0")
            // Native Firebase Functions SDK — used by NativeAndroidFunctionsClient
            // to bypass gitlive 2.x's FirebaseEncoder, which throws
            //   SerializationException: Serializer for class 'Any' is not found
            // when callers pass Map<String, Any?> payloads. The native call()
            // accepts HashMap and returns HashMap, no serializer layer.
            implementation("com.google.firebase:firebase-functions:22.1.1")
            // App Check (O-3 ruling D1). Play Integrity is the shipped provider;
            // SafetyNet is decommissioned and is deliberately not a fallback. The
            // debug artifact is here rather than in a debug-only configuration
            // because the source set is shared — `activateAppCheck` picks the
            // factory at runtime from FLAG_DEBUGGABLE, so a release build never
            // reaches the debug provider. Versions come from the BOM above.
            implementation("com.google.firebase:firebase-appcheck-playintegrity")
            implementation("com.google.firebase:firebase-appcheck-debug")
            // Task.await() for native Functions call() result.
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.11.0")
            implementation("androidx.activity:activity-compose:1.13.0")
            implementation("androidx.biometric:biometric:1.1.0")
            implementation("androidx.core:core-ktx:1.19.0")
            implementation("io.coil-kt.coil3:coil-network-okhttp:3.6.2")
            // Sentry — crash reporting. Init gated in KinfolkPortalApplication
            // on a non-blank DSN + non-robolectric fingerprint.
            implementation("io.sentry:sentry-android:8.55.0")
            // Mapbox Maps SDK, android only. It is what puts streets and
            // landmarks under the KinCare route instead of the bare polyline a
            // kinfolk sees today (issue #520). Same 11.10.0 as
            // auntieos-admin/android so the two apps cannot drift onto
            // different SDK behaviour.
            //
            // Resolved from the Mapbox maven repository declared in
            // settings.gradle.kts, which needs MAPBOX_DOWNLOADS_TOKEN. Without
            // it this dependency does not resolve and Android tasks fail
            // loudly; jvm and js are untouched and keep the Canvas renderer.
            implementation("com.mapbox.maps:android:11.10.0")
        }
        // The Android unit-test variant's own source set (layout v2, see
        // gradle.properties). It exists so MapboxTokenStartupTest can assert
        // that KinfolkPortalApplication.onCreate hands the SDK its token before
        // any Composable - and therefore any MapView - can exist. That needs a
        // real Application instance, which is Robolectric's job and cannot be
        // done from commonTest.
        //
        // NOT a way around the #473 Compose-UI-test wall: nothing here launches
        // an Activity. See mytribe/CLAUDE.md; Compose UI tests still belong in
        // src/composeUiTest and still run only under :jvmTest.
        val androidUnitTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation("junit:junit:4.13.2")
                implementation("org.robolectric:robolectric:4.16.1")
            }
        }
        jsMain.dependencies {
            // Coil 3 ktor3 fetcher for the kinfolk web portal. Brought into jsMain only;
            // jvmMain still uses ktor 2.x for the Firebase REST shim and stays untouched.
            implementation("io.coil-kt.coil3:coil-network-ktor3:3.6.2")
            implementation("io.ktor:ktor-client-js:3.5.2")
        }
    }
}

// Stable package for the generated Res accessor (brand fonts). Keeps the import
// in theme/Theme.kt deterministic across targets.
compose.resources {
    publicResClass = false
    packageOfResClass = "com.kinfolk.portal.generated.resources"
}

android {
    namespace = "com.kinfolk.portal"
    // 37 because androidx.core 1.19.0 declares a minimum compileSdk of 37 in
    // its AAR metadata (coil3 3.5.0, androidx.activity 1.13.0 and
    // navigationevent 1.0.0 want 36), and checkReleaseAarMetadata fails rather
    // than warns. Same reasoning and the same number as
    // auntieos-admin/android/app/build.gradle.kts.
    //
    // compileSdk is which APIs the code may reference. targetSdk stays where it
    // was: raising that changes runtime behaviour on device and is its own
    // change with its own testing.
    compileSdk = 37

    sourceSets["main"].manifest.srcFile("src/androidMain/AndroidManifest.xml")

    defaultConfig {
        applicationId = "com.kinfolk.portal"
        minSdk = 34
        targetSdk = 35
        // Derived from git, NOT hardcoded, and identical in shape to
        // auntieos-admin/android so both APKs read the same way in App
        // Distribution. versionCode is the commit count, which is monotonic on a
        // linear history and is what Android requires to accept an upgrade;
        // versionName carries the short SHA so a tester's screenshot maps to an
        // exact commit. The count is NOT repeated in the name, because App
        // Distribution already prints versionCode beside it.
        versionCode = gitCommitCount()
        versionName = "0.2.0-${gitShortSha()}"

        // The Maps SDK authenticates its OWN tile requests on the device, so a
        // public token has to reach the APK; there is no server-proxy option for
        // a basemap the way there is for a geocoding lookup. This is the mobile
        // token, which carries no URL restriction because Mapbox validates those
        // from a browser Referer and answers 403 to Maps SDK requests. The web
        // portal gets a different, URL-restricted token.
        //
        // Injected exactly the way auntieos-admin/android does it: local
        // .properties first, then a gradle property (which covers
        // ~/.gradle/gradle.properties and ORG_GRADLE_PROJECT_MAPBOX_PUBLIC_TOKEN),
        // then empty. Empty is a VALID build: RouteMap then renders the Canvas
        // polyline, which is exactly what every kinfolk sees today, and no other
        // screen degrades.
        //
        // NOT the same token as MAPBOX_DOWNLOADS_TOKEN in settings.gradle.kts.
        // That one is an `sk.` maven credential that downloads the SDK at build
        // time and cannot authenticate a MapView.
        buildConfigField(
            "String",
            "MAPBOX_PUBLIC_TOKEN",
            "\"${localProps.getProperty("MAPBOX_PUBLIC_TOKEN") ?: project.findProperty("MAPBOX_PUBLIC_TOKEN") ?: ""}\"",
        )
    }

    signingConfigs {
        // Internal-testing signing with the Android debug keystore. There is no
        // Play Store; Firebase App Distribution is the only channel, and it rejects
        // an unsigned APK. This mirrors the AuntieOS app so assembleRelease emits an
        // installable, distributable release build. The debug keystore password is
        // the well-known public default, not a secret.
        create("release") {
            storeFile = file(System.getProperty("user.home") + "/.android/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        // Off by default in AGP 8+, and this module had no buildConfigField
        // until the Mapbox token above needed one. Without it BuildConfig is
        // never generated and MapboxPortalConfig cannot read the token.
        buildConfig = true
    }

    testOptions {
        unitTests {
            // Robolectric needs the merged resources and the manifest to build
            // an Application. Mirrors auntieos-admin/android:163.
            isReturnDefaultValues = true
            isIncludeAndroidResources = true
        }
    }

    lint {
        // Workaround: androidx.lifecycle NullSafeMutableLiveDataDetector crashes
        // with IncompatibleClassChangeError on current Kotlin analysis API
        // (KaCallableMemberCall class-vs-interface ABI skew). Bug in the lint
        // detector itself, not user code. Re-enable after a lifecycle-lint
        // release that targets the matching analysis API.
        disable += "NullSafeMutableLiveData"
    }
}

compose.desktop {
    application {
        mainClass = "com.kinfolk.portal.MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
            packageName = "Kinfolk Portal"
            packageVersion = "1.0.0"
        }
    }
}

// Force Firebase JS SDK to 10.14.0 — gitlive 2.1.0 transitive may pin older.
// 10.14+ required for initializeRecaptchaConfig (Identity Platform reCAPTCHA
// Enterprise integration in index.html). See project_path_b_decisions memory.
plugins.withType<org.jetbrains.kotlin.gradle.targets.js.yarn.YarnPlugin> {
    the<org.jetbrains.kotlin.gradle.targets.js.yarn.YarnRootExtension>()
        .resolution("firebase", "10.14.0")
}
