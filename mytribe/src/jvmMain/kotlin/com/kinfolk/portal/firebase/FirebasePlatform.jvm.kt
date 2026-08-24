package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthBackend

/**
 * Single shared RestAuthBackend instance — RestFirestoreClient + RestFunctionsClient
 * both read tokens from it.
 */
private val restAuthBackend: RestAuthBackend by lazy { RestAuthBackend() }
private val restFirestoreClient: RestFirestoreClient by lazy { RestFirestoreClient(restAuthBackend) }
private val restFunctionsClient: RestFunctionsClient by lazy { RestFunctionsClient(restAuthBackend) }

/**
 * #557: the same revocation reaction the other two targets get. The REST
 * backend's `authStateChanges()` is the one-shot default, so the desktop shell
 * does not re-render off this by itself the way Android and JS do — the local
 * session is still ended, and the next `AuthRepository.refresh()` reports it.
 */
private val revocationAwareFunctionsClient: FunctionsClient by lazy {
    RevocationAwareFunctionsClient(restFunctionsClient)
}

actual fun platformAuthBackend(): AuthBackend = restAuthBackend

actual fun platformFirestoreClient(): FirestoreClient = restFirestoreClient

actual fun platformFunctionsClient(): FunctionsClient = revocationAwareFunctionsClient
