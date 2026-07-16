package com.tribetails.auntieos.web.ui.shell

/** Reads/writes the browser URL hash. No-op in-memory on non-web targets. */
expect fun currentHash(): String
expect fun setHash(value: String)
/** Register a listener for external hash changes (back/forward, manual edit). */
expect fun observeHash(onChange: (String) -> Unit)
