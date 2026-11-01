package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthBackend
import com.kinfolk.portal.auth.FirebaseAuthBackend

actual fun platformAuthBackend(): AuthBackend = FirebaseAuthBackend()

// platformFunctionsClient and (#1282) platformFirestoreClient are per-target:
//   androidMain → NativeAndroidFunctionsClient (skips gitlive serialization)
//   jsMain     → GitliveFunctionsClient (gitlive's JS path still works)
// jvmMain has its own actual via RestFunctionsClient.
// Firestore follows the same split for the same reason: androidMain reads
// documents with NativeAndroidFirestoreClient, jsMain keeps GitliveFirestoreClient.
