package com.tribetails.auntieos.web.data

/**
 * 02-sign-in item 1 (desktop/JVM): no-op. Password-manager autofill on desktop is the
 * OS/browser-agnostic platform's concern, not the app's; there is no DOM form to inject.
 */
internal actual fun platformMountSignInAutofill(onCredentials: (email: String, password: String) -> Unit) {}
internal actual fun platformSetSignInAutofillValues(email: String, password: String) {}
internal actual fun platformSubmitSignInAutofill() {}
internal actual fun platformUnmountSignInAutofill() {}
