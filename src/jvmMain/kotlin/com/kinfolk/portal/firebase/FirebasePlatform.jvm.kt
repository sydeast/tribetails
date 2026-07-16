package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthBackend

/**
 * Single shared RestAuthBackend instance — RestFirestoreClient + RestFunctionsClient
 * both read tokens from it.
 */
private val restAuthBackend: RestAuthBackend by lazy { RestAuthBackend() }
private val restFirestoreClient: RestFirestoreClient by lazy { RestFirestoreClient(restAuthBackend) }
private val restFunctionsClient: RestFunctionsClient by lazy { RestFunctionsClient(restAuthBackend) }

actual fun platformAuthBackend(): AuthBackend = restAuthBackend

actual fun platformFirestoreClient(): FirestoreClient = restFirestoreClient

actual fun platformFunctionsClient(): FunctionsClient = restFunctionsClient
