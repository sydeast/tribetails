package com.kinfolk.portal.components

import android.animation.ValueAnimator

/**
 * Reads the platform setting directly. `areAnimatorsEnabled()` returns false
 * when Animator duration scale is off in Developer options, and when the
 * "Remove animations" accessibility toggle is on -- the two ways an Android
 * user asks for what the web calls `prefers-reduced-motion: reduce`.
 */
actual fun animationsEnabled(): Boolean = ValueAnimator.areAnimatorsEnabled()
