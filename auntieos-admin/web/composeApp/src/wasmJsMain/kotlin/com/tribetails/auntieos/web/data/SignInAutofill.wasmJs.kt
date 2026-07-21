package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * 02-sign-in item 1 (web): password-manager autofill bridge.
 *
 * Compose-Wasm renders the whole app to a single <canvas>, so a password manager
 * sees no <input>/<form> and cannot offer to fill or save credentials. This injects
 * a real, visually-hidden <form> (managers detect inputs by their `autocomplete`
 * attributes, not by pixel position, so no canvas geometry is needed) and bridges:
 *   - DOM input -> Compose: the manager filling the inputs fires the onCredentials cb.
 *   - Compose -> DOM: [platformSetSignInAutofillValues] mirrors what the user types in
 *     the canvas fields, so submit-to-save has the right values.
 *   - save prompt: [platformSubmitSignInAutofill] requestSubmit()s the form after a
 *     successful sign-in so the manager offers to save the credential.
 *
 * All DOM work is done from @JsFun (compiled into the wasm JS glue, NOT an inline
 * <script>), so it is CSP-safe under the strict script-src.
 */

private val autofillJson = Json { ignoreUnknownKeys = true; isLenient = true }

@JsFun(
    """(cb) => {
      let f = document.getElementById('__auntie_af');
      if (f) return;
      f = document.createElement('form');
      f.id = '__auntie_af';
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
      const u = document.createElement('input');
      u.type = 'email'; u.name = 'username'; u.autocomplete = 'username'; u.id = '__auntie_af_u';
      const p = document.createElement('input');
      p.type = 'password'; p.name = 'password'; p.autocomplete = 'current-password'; p.id = '__auntie_af_p';
      const s = document.createElement('button'); s.type = 'submit'; s.tabIndex = -1; s.style.display = 'none';
      f.appendChild(u); f.appendChild(p); f.appendChild(s);
      // The manager fills the DOM inputs; mirror that into Compose state.
      const emit = () => cb(JSON.stringify({ email: u.value, password: p.value }));
      u.addEventListener('input', emit); u.addEventListener('change', emit);
      p.addEventListener('input', emit); p.addEventListener('change', emit);
      // Keep the canvas the real UI: never navigate on submit.
      f.addEventListener('submit', (e) => { e.preventDefault(); });
      document.body.appendChild(f);
    }""",
)
private external fun jsMountAutofill(cb: (String) -> Unit)

@JsFun(
    """(email, pwd) => {
      const u = document.getElementById('__auntie_af_u');
      const p = document.getElementById('__auntie_af_p');
      if (u && u.value !== email) u.value = email;
      if (p && p.value !== pwd) p.value = pwd;
    }""",
)
private external fun jsSetAutofillValues(email: String, pwd: String)

@JsFun(
    """() => {
      const f = document.getElementById('__auntie_af');
      if (f && f.requestSubmit) { try { f.requestSubmit(); } catch (e) {} }
    }""",
)
private external fun jsSubmitAutofill()

@JsFun("() => { const f = document.getElementById('__auntie_af'); if (f) f.remove(); }")
private external fun jsUnmountAutofill()

internal actual fun platformMountSignInAutofill(onCredentials: (email: String, password: String) -> Unit) {
    jsMountAutofill { payload ->
        runCatching {
            val o = autofillJson.parseToJsonElement(payload).jsonObject
            val email = o["email"]?.jsonPrimitive?.contentOrNull.orEmpty()
            val password = o["password"]?.jsonPrimitive?.contentOrNull.orEmpty()
            onCredentials(email, password)
        }
    }
}

internal actual fun platformSetSignInAutofillValues(email: String, password: String) =
    jsSetAutofillValues(email, password)

internal actual fun platformSubmitSignInAutofill() = jsSubmitAutofill()

internal actual fun platformUnmountSignInAutofill() = jsUnmountAutofill()
