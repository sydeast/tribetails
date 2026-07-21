package com.tribetails.auntieos.web.ui.shell

private var memHash: String = ""

actual fun currentHash(): String = memHash
actual fun setHash(value: String) { memHash = value }
actual fun observeHash(onChange: (String) -> Unit) { /* desktop has no URL bar */ }
