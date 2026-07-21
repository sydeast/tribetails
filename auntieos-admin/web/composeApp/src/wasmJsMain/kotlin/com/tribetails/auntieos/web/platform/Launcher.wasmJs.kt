package com.tribetails.auntieos.web.platform

// Navigates the browser to the URI; for tel:/sms: this hands off to the OS handler. Wrapped
// so a blocked navigation never throws into Wasm.
@JsFun("(uri) => { try { window.location.href = uri } catch (e) {} }")
private external fun jsLaunchUri(uri: String)

actual fun launchUri(uri: String) {
    jsLaunchUri(uri)
}
