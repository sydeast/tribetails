package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthBackend
import com.kinfolk.portal.auth.FirebaseAuthBackend

actual fun platformAuthBackend(): AuthBackend = FirebaseAuthBackend()

actual fun platformFirestoreClient(): FirestoreClient = GitliveFirestoreClient()

// platformFunctionsClient is now per-target:
//   androidMain → NativeAndroidFunctionsClient (skips gitlive serialization)
//   jsMain     → GitliveFunctionsClient (gitlive's JS path still works)
// jvmMain has its own actual via RestFunctionsClient.
