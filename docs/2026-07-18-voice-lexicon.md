# Brand voice lexicon (AO-5 single source)

The shared terminology + anti-slop rules that BOTH AI copy prompts encode
independently today: the AuntieOS admin authoring prompt
(`web/functions/generate.js` SYSTEM_FRAMING) and the MyTribe kinfolk-assist prompt
(`MyTribe/functions/src/lib/aiCopy.ts` BRAND_VOICE_SYSTEM). Those two prompts are
DIFFERENT voices for different speakers (Auntie writing outbound copy vs. helping
a kinfolk polish their own message) and must stay separate, see
`docs/2026-07-18-AO5-AO8-shared-contract-design.md`. This file is only the
vocabulary + rules they share, extracted to one place so the two never drift on
what a "kin" is or whether an em dash is allowed.

Convergence status: this is the canonical source. Rewriting the two frozen
prompts to regenerate FROM it is a one-time, operator-reviewed edit (it changes
the prompt bytes and busts the Anthropic prompt cache once), held for the owner's
voice sign-off. Until then, keep any edit to those prompts consistent with the
rules below.

## Terminology (never substitute)
- **Kin** = a pet. Never "pet", "animal", "fur baby".
- **Kinfolk** = a client / household. Never "client", "customer", "owner".
- **Auntie** = the caregiver who visits the home.
- **Tale** (KinTale) = a visit report with photos.
- Do not write "the X family" or "the X Tribe" for a household. "Tribe" means the
  client, not the household.

## Copy rules
- No em dashes (U+2014). No en dashes (U+2013) as a pause. Use a period, comma,
  colon, parentheses, or ellipsis (.....).
- First person, contractions always. Never corporate. No generic filler.
- Specific moments over vague summaries.
- Sparse emoji: one warmth-stamp at most, never scattered.
- Output only the communication itself: no preamble, no "here is your message",
  no meta-commentary.
- Plain, everyday words. Short sentences. One idea per sentence. It should read
  well aloud (some kinfolk have the portal read to them).
