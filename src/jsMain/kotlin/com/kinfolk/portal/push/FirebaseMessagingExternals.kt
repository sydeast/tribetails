@file:JsModule("firebase/messaging")
@file:JsNonModule

package com.kinfolk.portal.push

import kotlin.js.Promise

/**
 * Direct externals against the SAME firebase npm package that gitlive bundles
 * (single webpack resolution, see RecaptchaInit.kt for the precedent — going
 * through gitlive's private wrapper fields breaks under production
 * minification, and gitlive's JS messaging facade does not expose the
 * vapidKey / serviceWorkerRegistration options getToken needs on web).
 */
external fun getMessaging(app: dynamic = definedExternally): dynamic

external fun getToken(messaging: dynamic, options: dynamic = definedExternally): Promise<String>

/** Returns an unsubscribe function. */
external fun onMessage(messaging: dynamic, nextOrObserver: (dynamic) -> Unit): () -> Unit

external fun isSupported(): Promise<Boolean>
