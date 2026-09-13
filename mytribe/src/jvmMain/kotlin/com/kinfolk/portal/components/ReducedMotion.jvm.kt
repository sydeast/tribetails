package com.kinfolk.portal.components

/**
 * Desktop has no equivalent setting to read, and per mytribe/CLAUDE.md the jvm
 * target is not a delivery surface -- it exists so `:jvmTest` can host the
 * Compose UI tests. Answering true keeps those tests on the normal path; the
 * slowed path is covered by the pure `waitPhase` spec instead.
 */
actual fun animationsEnabled(): Boolean = true
