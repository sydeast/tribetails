package com.tribetails.auntieos.web.ui.shaders

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import com.tribetails.auntieos.web.theme.AuntieColors

/**
 * The SkSL source for the AuntieOS mesh-gradient background. Three soft "blobs"
 * of brand color drift in slow Lissajous orbits and refract around an interactive
 * pointer (mouse on web; gyroscope on Android - set via expect/actual).
 *
 * Uniforms:
 *   uResolution : float2  - canvas size in px
 *   uTime       : float   - seconds since composition start
 *   uPointer    : float2  - interactive pointer in 0..1 (0,0 = top-left)
 *   uColorBg    : float4  - base background color
 *   uColorA/B/C : float4  - three blob tints (typically gold variants)
 *   uIntensity  : float   - 0..1, dim shader on light theme
 */
const val AUNTIE_MESH_SKSL = """
uniform float2 uResolution;
uniform float  uTime;
uniform float2 uPointer;
uniform float4 uColorBg;
uniform float4 uColorA;
uniform float4 uColorB;
uniform float4 uColorC;
uniform float  uIntensity;

float blob(float2 uv, float2 c, float r) {
    float d = length(uv - c);
    return smoothstep(r, 0.0, d);
}

half4 main(float2 fragCoord) {
    float2 uv = fragCoord / uResolution;
    float t = uTime * 0.18;

    // Pointer pulls the orbit centers, giving a "responsive glow" feel
    float2 pull = (uPointer - float2(0.5, 0.5)) * 0.25;

    float2 cA = float2(0.30 + 0.10 * sin(t * 1.1), 0.25 + 0.07 * cos(t * 0.9)) + pull;
    float2 cB = float2(0.75 + 0.08 * cos(t * 0.7), 0.65 + 0.09 * sin(t * 1.3)) - pull * 0.6;
    float2 cC = float2(0.50 + 0.12 * sin(t * 0.5), 0.85 + 0.06 * cos(t * 0.8)) + pull * 0.3;

    float a = blob(uv, cA, 0.55);
    float b = blob(uv, cB, 0.50);
    float c = blob(uv, cC, 0.45);

    float4 col = uColorBg;
    col = mix(col, uColorA, a * uIntensity);
    col = mix(col, uColorB, b * uIntensity);
    col = mix(col, uColorC, c * uIntensity);

    // Subtle vignette
    float v = smoothstep(1.2, 0.4, length(uv - 0.5));
    col.rgb *= mix(0.85, 1.0, v);

    return half4(col);
}
"""

/**
 * Pointer state shared between the platform-specific surface (Android sensor /
 * web mouse) and the shader background. Values are normalized 0..1.
 */
class PointerState {
    var x: Float by mutableFloatStateOf(0.5f)
        internal set
    var y: Float by mutableFloatStateOf(0.5f)
        internal set

    fun update(normalizedX: Float, normalizedY: Float) {
        x = normalizedX.coerceIn(0f, 1f)
        y = normalizedY.coerceIn(0f, 1f)
    }
}

/**
 * Provided by the platform layer:
 *   - wasmJs:  hooks into window mouse events
 *   - android: hooks into rotation-vector sensor
 */
expect class PlatformPointerSource() {
    fun start(state: PointerState)
    fun stop()
}

@Composable
fun rememberMeshPointer(): PointerState {
    val state = remember { PointerState() }
    val source = remember { PlatformPointerSource() }
    LaunchedEffect(source) {
        source.start(state)
    }
    return state
}

/**
 * Compose Modifier that paints the mesh-gradient shader behind whatever it's
 * applied to. On platforms where RuntimeEffect is unavailable, falls back to a
 * static brand-tinted radial gradient via [meshFallback].
 *
 * Placeholder: actual RuntimeEffect plumbing lives in the platform layer
 * (ui/shaders/MeshGradient.android.kt and .wasmJs.kt) since Compose's shader
 * API surface differs per target as of CMP 1.7.x.
 */
expect fun Modifier.meshGradientBackground(
    colors: AuntieColors,
    pointer: PointerState,
): Modifier
