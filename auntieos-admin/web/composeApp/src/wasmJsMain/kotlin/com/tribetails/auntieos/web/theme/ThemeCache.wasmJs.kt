package com.tribetails.auntieos.web.theme

// Browser localStorage bridge for the theme warm-start cache. Wrapped in try/catch
// so private-mode / disabled storage never throws (falls back to no cache = the
// pre-fix behavior, never a crash). Empty string is the "absent" sentinel so the
// external fun can stay non-nullable (matches the other wasm interop in this app).

@JsFun("() => { try { const v = window.localStorage.getItem('auntieos.theme'); return v == null ? '' : v; } catch (e) { return ''; } }")
private external fun jsReadThemeCache(): String

@JsFun("(v) => { try { window.localStorage.setItem('auntieos.theme', v); } catch (e) {} }")
private external fun jsWriteThemeCache(v: String)

internal actual fun readThemeCache(): String? = jsReadThemeCache().ifEmpty { null }

internal actual fun writeThemeCache(value: String) {
    jsWriteThemeCache(value)
}
