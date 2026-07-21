# Auntie OS — Tasker Android Task Spec

Trigger Auntie OS generation from your Android phone.
POSTs to the n8n webhook and displays the generated copy in a Tasker Scene.

---

## Requirements

- Tasker (paid app, Google Play)
- Your Mac running `python3 web_server.py` (UI) and n8n on `localhost:51002`
- Phone and Mac on the same Wi-Fi network
- Your Mac's local IP (Settings → Wi-Fi → tap network → IP Address, e.g. `192.168.1.45`)

**Replace `MAC_IP` with your Mac's actual LAN IP throughout this spec.**

---

## Variables Used

| Variable | Purpose |
|---|---|
| `%comm_type` | Communication type (e.g., visit_report) |
| `%recipient` | Kinfolk name or free text |
| `%raw_notes` | Syd's raw notes |
| `%tone_hint` | Tone: warm, casual, celebratory, urgent, professional |
| `%max_length` | Length: short, medium, long |
| `%response_body` | Raw JSON from n8n |
| `%generated_copy` | Extracted generated copy |
| `%draft_id` | Returned draft ID |
| `%http_response_code` | HTTP status code |

---

## Task: Auntie Generate

### Action 1 — Variable Set: Communication Type
**Type:** Variable Set
- **Name:** `%comm_type`
- **To:** `visit_report`
*(Change default as needed, or replace with Variable Query below)*

---

### Action 2 — Variable Query: Communication Type
**Type:** Variable Query  
*(Prompts user to pick from a list)*
- **Title:** `Communication Type`
- **Variable:** `%comm_type`
- **Values (one per line):**
  ```
  visit_report
  sms
  email
  social_post
  blog_post
  general
  ```

---

### Action 3 — Variable Query: Recipient
**Type:** Variable Query
- **Title:** `Recipient`
- **Variable:** `%recipient`
- **Type:** Text Input
- **Hint:** `Kinfolk name or free text`

*(Optional: Replace with a menu of your 7 Kinfolk names if you prefer)*

---

### Action 4 — Variable Query: Raw Notes
**Type:** Variable Query
- **Title:** `Raw Notes`
- **Variable:** `%raw_notes`
- **Type:** Text Input (multi-line)
- **Hint:** `Bullet points or free-form notes`

---

### Action 5 — Variable Query: Tone
**Type:** Variable Query
- **Title:** `Tone (optional)`
- **Variable:** `%tone_hint`
- **Values:**
  ```
  warm
  casual
  celebratory
  urgent
  professional
  ```
- **Default:** `warm`

---

### Action 6 — Variable Query: Length
**Type:** Variable Query
- **Title:** `Length (optional)`
- **Variable:** `%max_length`
- **Values:**
  ```
  medium
  short
  long
  ```
- **Default:** `medium`

---

### Action 7 — HTTP Request
**Type:** HTTP Request

| Field | Value |
|---|---|
| **Method** | POST |
| **URL** | `http://MAC_IP:51002/webhook/auntie-generate` |
| **Headers** | `Content-Type: application/json` |
| **Body** | *(see below)* |
| **Timeout** | 60 |
| **Response Variable** | `%response_body` |
| **Response Code Variable** | `%http_response_code` |
| **Trust Any Certificate** | Off (LAN only, no cert needed) |

**Body** (paste exactly, it's a Tasker expression):
```
{"communication_type":"%comm_type","recipient":"%recipient","raw_notes":"%raw_notes","tone_hint":"%tone_hint","max_length":"%max_length"}
```

> ⚠️ In Tasker's HTTP Request body field, Tasker variables like `%comm_type` ARE expanded at runtime, but make sure "Content-Type" header is set and the body field type is set to "String" not "File".

---

### Action 8 — IF: Check HTTP success
**Type:** If
- **Condition:** `%http_response_code` **~** `200`
  *(~ means "matches" in Tasker — use "Equals" with value `200`)*

---

### Action 9 — JSON Extract: Get generated_copy
**Type:** Variable Set (using Tasker JSON path)
- **Name:** `%generated_copy`
- **To:** `%response_body`
- Then use **JSON Extractor** action:
  - **Variable:** `%generated_copy`
  - **JSON:** `%response_body`
  - **Path:** `generated_copy`

*(In newer Tasker: Action → Variables → JSON Extractor)*

---

### Action 10 — JSON Extract: Get draft_id
**Type:** JSON Extractor
- **Variable:** `%draft_id`
- **JSON:** `%response_body`
- **Path:** `draft_id`

---

### Action 11 — Notify or Alert
Choose one:

**Option A — Flash notification (simple):**
- **Type:** Flash
- **Text:** `%generated_copy`

**Option B — Tasker Scene (full display with copy button):**
See Scene spec below.

**Option C — Share intent (opens Android share sheet):**
- **Type:** Intent
- **Action:** `android.intent.action.SEND`
- **Type:** `text/plain`
- **Extra:** `android.intent.extra.TEXT:%generated_copy`
- **Package:** *(leave blank to show share sheet)*

> Recommended: Option C — you can paste directly into Messages, Gmail, Instagram, etc.

---

### Action 12 — ELSE: Show error
**Type:** Flash
- **Text:** `Generation failed: %response_body`

---

### Action 13 — End If

---

## Optional: Scene for Full Display

If you want a proper display with Copy and Close buttons:

### Scene: Auntie Result

**Elements:**

1. **Text element** (large, top)
   - Text: `Auntie OS`
   - Font: bold, 18sp

2. **Text element** (scrollable)
   - Variable: `%generated_copy`
   - ID: `generated_copy_text`
   - Scrollable: checked
   - Font: 14sp, wrap text

3. **Button: Copy**
   - Text: `Copy`
   - Tap Task: inline → Set Clipboard → `%generated_copy` → Flash "Copied!"

4. **Button: Share**
   - Text: `Share`
   - Tap Task: inline → Intent → `android.intent.action.SEND`, type `text/plain`, extra `android.intent.extra.TEXT:%generated_copy`

5. **Button: Close**
   - Text: `Close`
   - Tap Task: inline → Destroy Scene `Auntie Result`

**Show Scene action (replaces Action 11):**
- **Type:** Show Scene
- **Name:** `Auntie Result`
- **Display:** Full screen or Dialog

---

## Profile: Quick Launch

Create a Tasker Profile to add a quick-launch tile:

1. **Profile:** Event → UI → Quick Settings Tile
   - Or: Shortcut → Long Tap → Widget → Tasker → select "Auntie Generate" task
2. **Task:** `Auntie Generate` (the task built above)

This gives you a one-tap tile in your Android Quick Settings or home screen widget.

---

## Variable defaults you may want to set permanently

If you almost always use the same values, set them at the top of the task:

```
%tone_hint = warm
%max_length = medium
```

Then skip Actions 5 and 6 entirely for faster triggering.

---

## Testing

1. Make sure Mac is on, n8n is running (`docker ps | grep n8n` should show it)
2. Run the Tasker task manually from within Tasker
3. If it fails: check `%http_response_code` in Tasker's variable viewer
4. Common issues:
   - Wrong MAC_IP → update the URL in Action 7
   - Phone on different network → connect both to same Wi-Fi
   - n8n not running → start Docker on Mac
