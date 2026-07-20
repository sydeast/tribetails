package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthBackend

/**
 * Platform-provided Firebase wiring.
 * - android + js: gitlive-firebase backed (firebaseMain).
 * - jvm:          Ktor + Firebase REST backed (jvmMain).
 */
expect fun platformAuthBackend(): AuthBackend

expect fun platformFirestoreClient(): FirestoreClient

expect fun platformFunctionsClient(): FunctionsClient
