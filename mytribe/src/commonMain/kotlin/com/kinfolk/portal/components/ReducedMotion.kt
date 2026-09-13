package com.kinfolk.portal.components

/**
 * Whether this device wants animation at all.
 *
 * The Android equivalent of the web's `prefers-reduced-motion`, which the
 * 2026-09-12 ruling has to respect on both platforms. On Android the setting is
 * Developer options -> Animator duration scale, or the Remove animations
 * accessibility toggle, both of which surface through
 * `ValueAnimator.areAnimatorsEnabled()`.
 *
 * WHAT CALLERS DO WITH A `false` IS SLOW THE SPINNER DOWN, NOT STOP IT, and
 * that asymmetry is deliberate. A frozen ring is not a loading indicator, it is
 * a picture of a hang -- which is exactly the reading the ruling exists to
 * prevent -- and the request is for no LARGE, vestibular or distracting motion,
 * which a 36dp ring turning once every 2.4 seconds is not. The sentence beside
 * it carries the meaning either way, which is why [KinLoading] draws the ring
 * next to the words and never instead of them.
 *
 * The same correction was made on the web side of both apps, where a global
 * `* { animation: none !important }` had been freezing every spinner including
 * three whose own comments said they were only meant to be slowed.
 */
expect fun animationsEnabled(): Boolean
