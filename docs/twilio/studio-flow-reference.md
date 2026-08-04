### Tribe Tails Pet Care — Twilio Studio Flow Blueprint (Twilio Assets Edition)

> **The canonical flow is `auntieos-admin/studio_flow_v2.json`, not this file.**
> This is a hand-written blueprint and it drifted from the JSON. Four points
> were corrected against it on 2026-08-04 and are marked `CORRECTED 2026-08-04`
> inline. Where the two still disagree, the JSON wins: it is what runs.

📁 Recommended Asset Organization
Inside your Twilio Console (under Functions > Assets), upload your custom audio clips. For maximum compatibility with all mobile networks and devices, ensure they are saved as .mp3 or mono .wav files.
• after_hours_greeting.mp3
• open_hours_greeting.mp3
• open_hours_retry.mp3
• gather_intro.mp3
• try_text_suggestion.mp3
• thank_you_vm.mp3
🗺️ Execution Graph
Trigger (Incoming Call)
   │
   ▼
check_hours_business (HTTP GET /check-hours)
   ├─► success [body == "yes"] ──► open_hours_greeting
   ├─► success [body == "no"]  ──► after_hours_greeting
   └─► failed (Fail-Open)     ──► open_hours_greeting

======================= AFTER-HOURS BRANCH =======================

after_hours_greeting (Gather Input, Digits: 1, Timeout: 8s)
   │   🔊 Twilio Asset: /after_hours_greeting.mp3
   ├─► keypress ──► route_after_hours
   └─► timeout / speech ──► try_text_suggestion

route_after_hours (Split Based On...)
   ├─► == "4" ──► record_voicemail_after_hours
   └─► else  ──► try_text_suggestion

record_voicemail_after_hours (Record Voicemail)
   ├─► recordingComplete ──► thank_you_vm
   ├─► noAudio ───────────► try_text_suggestion
   └─► hangup ────────────► END

======================= OPEN-HOURS BRANCH =======================

open_hours_greeting (Gather Input, Digits: 1, Timeout: 8s)
   │   🔊 Twilio Asset: /open_hours_greeting.mp3
   ├─► keypress ──► route_open_hours
   └─► timeout / speech ──► open_hours_retry
       CORRECTED 2026-08-04: this read try_text_suggestion. The JSON sends both
       to open_hours_retry, which is also what the widget detail below says.

route_open_hours (Split Based On...)
   ├─► == "3" ──► gather_intro
   ├─► == "4" ──► record_voicemail_business
   └─► else  ──► open_hours_retry

open_hours_retry (Gather Input, Digits: 1, Timeout: 8s)
   │   🔊 Twilio Asset: /open_hours_retry.mp3
   ├─► == "3" ──► gather_intro
   ├─► == "4" ──► record_voicemail_business
   └─► else / timeout ──► try_text_suggestion

======================= THE PRESS-3 CONNECT PATH =======================

gather_intro (Gather Speech, Timeout: 5s)
   │   🔊 Twilio Asset: /gather_intro.mp3 ("State your name...")
   └─► speech ──► http_notify_screen (POST /screen-notify)
                    └─► success ──► add_call_recording
                                        └─► success ──► caller_queue (Enqueue)
                                                            ├─► callComplete ──► END
                                                            ├─► failedToEnqueue ─► try_text_suggestion
                                                            └─► callFailure ────► try_text_suggestion
       CORRECTED 2026-08-04: both read record_voicemail_business. The JSON sends
       them to try_text_suggestion, so a caller who cannot be enqueued gets the
       text-us prompt and a hangup, NOT a voicemail box.

======================= TERMINUS & SINK WIDGETS =======================

try_text_suggestion (Say/Play)
   │   🔊 Twilio Asset: /try_text_suggestion.mp3
   └─► audioComplete ──► END (Hard Disconnect)

record_voicemail_business (Record Voicemail)
   └─► recordingComplete ──► thank_you_vm

thank_you_vm (Say/Play)
   │   🔊 Twilio Asset: /thank_you_vm.mp3
   └─► audioComplete ──► END

⚙️ Detailed Widget Configurations
1. Initialization & Time Filters
check_hours_business
• Type: HTTP Request
• Method: GET
• URL: https://your-service-name-XXXX.twil.io/check-hours (Your Twilio Function URL)
• Transitions: • Success ──► split_hours • Failed ──► open_hours_greeting
split_hours
• Type: Split Based On...
• Variable to Analyze: {{widgets.check_hours_business.body}}
  CORRECTED 2026-08-04: this read `.Body`. Studio is case-sensitive here and the
  JSON uses lowercase `.body`. The capitalized form resolves to empty, so the
  split always falls through No Match to after_hours_greeting and the line is
  never open.
• Transitions: • Matches Value yes ──► open_hours_greeting • No Match / no ──► after_hours_greeting
2. After-Hours Logic (Anti-Spam Gateway)
after_hours_greeting
• Type: Gather Input On Call
• Widget Action: Play an Audio File
• Audio URL: https://your-service-name-XXXX.twil.io/after_hours_greeting.mp3
• Stop Gathering on Keypress: True
• Max Digits: 1
• Timeout: 8 seconds
• Transitions: • User Pressed Keys ──► route_after_hours • User Said Something / No Input ──► try_text_suggestion
route_after_hours
• Type: Split Based On...
• Variable to Analyze: {{widgets.after_hours_greeting.Digits}}
• Transitions: • Equal to 4 ──► record_voicemail_after_hours • No Match ──► try_text_suggestion
record_voicemail_after_hours
• Type: Record Voicemail
• Transcribe: True
• Transcription Callback URL: https://your-service-name-XXXX.twil.io/notify-voicemail
• Max Length: 180 seconds
• Trim: trim-silence
• Play Beep: True
• Finish on Key: #
• Transitions: • Recording Complete ──► thank_you_vm • No Audio Input ──► try_text_suggestion • Hangup ──► END
3. Business-Hours Logic (Anti-Spam Gateway)
open_hours_greeting
• Type: Gather Input On Call
• Widget Action: Play an Audio File
• Audio URL: https://your-service-name-XXXX.twil.io/open_hours_greeting.mp3
• Stop Gathering on Keypress: True
• Max Digits: 1
• Timeout: 8 seconds
• Transitions: • User Pressed Keys ──► route_open_hours • User Said Something / No Input ──► open_hours_retry
route_open_hours
• Type: Split Based On...
• Variable to Analyze: {{widgets.open_hours_greeting.Digits}}
• Transitions: • Equal to 3 ──► gather_intro • Equal to 4 ──► record_voicemail_business • No Match ──► open_hours_retry
open_hours_retry
• Type: Gather Input On Call
• Widget Action: Play an Audio File
• Audio URL: https://your-service-name-XXXX.twil.io/open_hours_retry.mp3
• Stop Gathering on Keypress: True
• Max Digits: 1
• Timeout: 8 seconds
• Transitions: • User Pressed Keys ──► Split node routing directly to gather_intro (if 3) or record_voicemail_business (if 4). • No Match / Timeout / Speech ──► try_text_suggestion
4. Screening, Live Recording, & Live Queue
gather_intro
• Type: Gather Input On Call
• Widget Action: Play an Audio File
• Audio URL: https://your-service-name-XXXX.twil.io/gather_intro.mp3
• Input Method: Speech Only
• Timeout: 5 seconds
• Transitions: • User Said Something / User Pressed Keys ──► http_notify_screen
http_notify_screen
• Type: HTTP Request
• Method: POST
• URL: https://your-service-name-XXXX.twil.io/screen-notify
• Parameters: {{widgets.gather_intro.SpeechResult}}, {{widgets.gather_intro.RecordingUrl}}
• Transitions: • Success ──► add_call_recording
add_call_recording
• Type: Call Recording
• Record Call: True
• Recording Channels: dual
• Recording Status Callback URL: NOT SET.
  CORRECTED 2026-08-04: this named a `/notify-recording` callback. The JSON's
  `add_call_recording` sets only `record_call` and `recording_channels`, so
  `twilio-service/functions/notify-recording.js` is never invoked by this flow.
  Wire the callback if you want it; do not assume it already fires.
• Transitions: • Success ──► caller_queue
caller_queue
• Type: Enqueue Call
• Queue Name: TribeTails_Call_Queue
• Transitions: • Call Complete ──► END • Failed to Enqueue / Call Failure ──► try_text_suggestion
  CORRECTED 2026-08-04: this read record_voicemail_business.
5. Terminus Points (The Sinks)
try_text_suggestion
• Type: Say/Play
• Widget Action: Play an Audio File
• Audio URL: https://your-service-name-XXXX.twil.io/try_text_suggestion.mp3
• Transitions: • Audio Complete ──► Disconnect Call Widget
record_voicemail_business
• Type: Record Voicemail
• Transcribe: True
• Transcription Callback URL: https://your-service-name-XXXX.twil.io/notify-voicemail
• Max Length: 180 seconds
• Trim: trim-silence
• Transitions: • Recording Complete ──► thank_you_vm
thank_you_vm
• Type: Say/Play
• Widget Action: Play an Audio File
• Audio URL: https://your-service-name-XXXX.twil.io/thank_you_vm.mp3
• Transitions: • Audio Complete ──► Disconnect Call Widget
