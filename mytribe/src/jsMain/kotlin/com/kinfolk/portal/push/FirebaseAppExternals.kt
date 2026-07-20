@file:JsModule("firebase/app")
@file:JsNonModule

package com.kinfolk.portal.push

/**
 * Default Firebase app from the same firebase/app ESM module gitlive
 * initializes in Main.kt — see FirebaseMessagingExternals.kt for why we don't
 * reach into the gitlive wrapper.
 */
external fun getApp(name: String = definedExternally): dynamic
