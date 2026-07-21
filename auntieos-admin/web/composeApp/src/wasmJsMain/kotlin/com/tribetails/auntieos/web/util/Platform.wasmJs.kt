package com.tribetails.auntieos.web.util

@JsFun("(url) => { window.open(url, '_blank', 'noopener'); }")
private external fun jsOpenUrl(url: String)

@JsFun("() => new Date().toISOString().slice(0, 19) + 'Z'")
private external fun jsNowIso(): String

actual fun openInMaps(address: String) {
    if (address.isBlank()) return
    val encoded = urlEncode(address)
    jsOpenUrl("https://www.google.com/maps/search/?api=1&query=$encoded")
}

actual fun nowIso(): String = jsNowIso()

actual fun openUrl(url: String) {
    if (url.isBlank()) return
    jsOpenUrl(url)
}

@JsFun("(text) => { try { if (navigator.clipboard) navigator.clipboard.writeText(text); } catch (e) {} }")
private external fun jsCopyToClipboard(text: String)

actual fun copyToClipboard(text: String) {
    if (text.isBlank()) return
    jsCopyToClipboard(text)
}

private fun urlEncode(s: String): String =
    s.replace(" ", "%20")
     .replace("&", "%26")
     .replace("?", "%3F")
     .replace("#", "%23")
     .replace(",", "%2C")
