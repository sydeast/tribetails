@file:JsModule("firebase/auth")
@file:JsNonModule

package com.kinfolk.portal.auth.recaptcha

import kotlin.js.Promise

/**
 * Returns the default Firebase Auth instance from the SAME firebase/auth ESM
 * module that gitlive bundles. Because webpack resolves a single copy of the
 * `firebase` npm package (pinned to 10.14.0 via YarnRootExtension.resolution),
 * this Auth instance is identical to the one gitlive.Firebase.auth wraps.
 *
 * Avoids reaching into gitlive's private wrapper field (renamed by production
 * minification → caused `t._errorFactory is undefined` at runtime).
 */
external fun getAuth(app: dynamic = definedExternally): dynamic

external fun initializeRecaptchaConfig(auth: dynamic): Promise<Unit>
