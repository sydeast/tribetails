import org.jetbrains.compose.ExperimentalComposeLibrary
import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
    alias(libs.plugins.kotlinSerialization)
}

kotlin {
    // The wasm admin is gone (#481). It was superseded by the React admin in
    // `auntieos-admin/src/`, and what was left here was a target nothing ships
    // from carrying logic nobody applied fixes to: #452 found it still holding
    // a canned KinTale message the React admin had already had removed, with a
    // test asserting the canned string was present.
    //
    // The desktop (jvm) target stays. It is paused, not withdrawn, and it is
    // also the host `:composeApp:jvmTest` runs on, so `commonMain` keeps its
    // coverage either way.
    jvm()

    sourceSets {
        commonMain.dependencies {
            // Compose
            implementation(compose.runtime)
            implementation(compose.foundation)
            implementation(compose.material3)
            implementation(compose.materialIconsExtended)
            implementation(compose.ui)
            implementation(compose.components.resources)

            // Concurrency / serialization / time
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.serialization.json)
            implementation(libs.kotlinx.datetime)

            // HTTP (n8n webhook + any REST while Firestore migration is incomplete)
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.content.negotiation)
            implementation(libs.ktor.serialization.kotlinx.json)

            // Headless component kit + Lucide icons
            implementation(libs.composables.core)
            implementation(libs.composables.icons.lucide)

            // Calendar engine
            implementation(libs.kizitonwose.calendar)

            // Image loader (Cloudinary thumbnails on the KinTale composer + media gallery)
            implementation(libs.coil.compose)
            implementation(libs.coil.network.ktor3)

            // Firebase: the desktop target has no Firebase SDK and talks to
            // Identity Toolkit / Firestore / callables over REST. See JvmFirestoreRest.kt.
        }

        jvmMain.dependencies {
            implementation(compose.desktop.currentOs)
            // Desktop has no Firebase SDK; the JVM auth/data layer talks to Firebase
            // over REST (Identity Toolkit + Firestore + callable HTTPS) via Ktor's JDK
            // engine. commonMain already provides ktor-client-core; the engine must be
            // present at runtime on this target.
            implementation(libs.ktor.client.java)
            // Desktop crash/error reporting (0H): the official Sentry JVM SDK. Reports to the
            // shared auntieos-admin project; Android already has its own Sentry setup.
            implementation(libs.sentry.jvm)
        }

        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.kotlinx.coroutines.test)
        }

        // Desktop (JVM) screenshot tests for the visual-comparison harness.
        // Uses Compose's own runDesktopComposeUiTest + captureToImage (no extra plugin).
        val jvmTest by getting {
            dependencies {
                @OptIn(ExperimentalComposeLibrary::class)
                implementation(compose.uiTest)
                implementation(compose.desktop.currentOs)
                implementation(compose.desktop.uiTestJUnit4)
                // N8nClient builds a no-engine Ktor HttpClient, and with the wasm
                // target gone (#481) nothing puts an engine on the classpath here,
                // so its init throws when the inbox/communicate screens construct
                // it. Supply the JDK engine so construction succeeds (screenshots
                // never actually issue a request).
                implementation(libs.ktor.client.java)
            }
        }
    }
}

// Den redesign fonts (Fraunces / Hanken Grotesk / Spline Sans Mono) live in
// commonMain/composeResources/font and are accessed via the generated Res class.
compose.resources {
    publicResClass = true
    packageOfResClass = "com.tribetails.auntieos.web.resources"
    generateResClass = always
}

compose.experimental {
    web.application {}
}

compose.desktop {
    application {
        mainClass = "MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Dmg)
            packageName = "AuntieOS"
            packageVersion = "1.0.0"
            // The desktop client talks to Firebase over REST via Ktor's JDK engine
            // (java.net.http.HttpClient) + TLS to googleapis. jlink trims the bundled
            // runtime to only the modules it can detect, and it misses java.net.http +
            // the TLS crypto modules, which crashes at launch
            // (NoClassDefFoundError: java/net/http/HttpClient$Version). Bundle the full
            // module set so auth + Firestore REST + TLS all resolve in the packaged app.
            includeAllModules = true
        }
    }
}
