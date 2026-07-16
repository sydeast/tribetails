# ---- Preserve source file names and line numbers for crash reports ----
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ---- General Kotlin attributes ----
-keepattributes Exceptions, InnerClasses, Signature, Deprecated, *Annotation*, EnclosingMethod

# ---- Data models (Gson reflection — field names must survive shrinking) ----
-keep class com.tribetails.auntieos.data.model.** { *; }
-keepclassmembers class com.tribetails.auntieos.data.model.** { *; }

# ---- Gson (2.10+ ships consumer-rules.pro; only pattern-based rules needed) ----
-keep class * implements com.google.gson.TypeAdapterFactory
-keep class * implements com.google.gson.JsonSerializer
-keep class * implements com.google.gson.JsonDeserializer
-keepclassmembers,allowobfuscation class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
-dontwarn sun.misc.**

# ---- Retrofit ----
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation
-keepclassmembers,allowshrinking,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}

# ---- OkHttp ----
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# ---- gRPC (Firebase Firestore calls InternalGlobalInterceptors at runtime; -dontwarn alone is not enough) ----
-keep class io.grpc.InternalGlobalInterceptors { *; }
-keep class io.grpc.internal.ManagedChannelImplBuilder { *; }
-dontwarn io.grpc.**

# ---- Cloudinary ----
-keep class com.cloudinary.** { *; }
-dontwarn com.cloudinary.**

# ---- Google API client (Calendar) ----
-keep class com.google.api.** { *; }
-dontwarn com.google.api.**
-dontwarn com.google.common.**

# ---- Sentry (plugin injects rules at build time; consumer-rules.pro in AAR) ----
-dontwarn io.sentry.**

# ---- Suppress warnings for libraries that include their own rules ----
# Firebase, Mapbox, Twilio, Coil, Kotlin Coroutines all ship consumerProguardFiles
# in their AARs. No manual rules needed for those.
-dontwarn com.mapbox.**
-dontwarn com.twilio.**

# ---- Android Window Extensions (runtime-only OEM classes, not on classpath) ----
-dontwarn androidx.window.extensions.**
-dontwarn androidx.window.sidecar.**

# ---- Guava ListenableFuture (Firebase transitive; missing-class warning under R8) ----
-dontwarn com.google.common.util.concurrent.ListenableFuture

# ---- GMS Location (ActivityRecognitionResult unused but referenced) ----
-dontwarn com.google.android.gms.location.ActivityRecognitionResult

# ---- Apache HTTP Client Kerberos auth (JGSS not on Android) ----
-dontwarn org.ietf.jgss.**
