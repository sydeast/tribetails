package com.kinfolk.portal.firebase

/**
 * #557: the revocation-aware decorator is installed HERE rather than at the
 * composition root, so every callable the app makes is covered without
 * `KinfolkPortalAppGuarded` having to remember to wire it — and without this
 * change needing to touch the composition root at all.
 */
actual fun platformFunctionsClient(): FunctionsClient =
    RevocationAwareFunctionsClient(NativeAndroidFunctionsClient())
