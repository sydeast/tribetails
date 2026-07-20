import org.jetbrains.compose.ExperimentalComposeLibrary
import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.kotlin.gradle.ExperimentalWasmDsl

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
    alias(libs.plugins.kotlinSerialization)
}

kotlin {
    @OptIn(ExperimentalWasmDsl::class)
    wasmJs {
        moduleName = "auntieos-web"
        browser {
            commonWebpackConfig {
                outputFileName = "auntieos-web.js"
            }
        }
        binaries.executable()
    }

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

            // Firebase: GitLive 2.1.0 has no wasmJs publication. Lifted into
            // wasmJsMain via raw Firebase JS SDK (npm) — see FirestoreClient.wasmJs.kt.
        }

        wasmJsMain.dependencies {
            implementation(libs.ktor.client.js)
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
                // N8nClient builds a no-engine Ktor HttpClient; on JVM there is no engine
                // on the classpath (only ktor-client-js ships for wasm), so its init throws
                // when the inbox/communicate screens construct it. Supply the JDK engine so
                // construction succeeds (screenshots never actually issue a request).
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
