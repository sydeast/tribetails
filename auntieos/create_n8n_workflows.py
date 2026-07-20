"""Create Auntie OS n8n workflows via the n8n REST API.

Creates:
  1. "Auntie OS — Generate"        (POST /webhook/auntie-generate)
  2. "Auntie OS — Update Profiles" (POST /webhook/auntie-update-profiles)

Run:
    python3 create_n8n_workflows.py
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from baserow_auth import _load_env

PROJECT_ROOT = Path(__file__).resolve().parent
VOICE_RULES_PATH = PROJECT_ROOT.parent / "auntie_voice_rules.md"


def n8n_post(url: str, token: str, path: str, payload: dict) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{url}/api/v1{path}",
        data=body,
        headers={
            "X-N8N-API-KEY": token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode()
        raise RuntimeError(f"n8n API {e.code}: {body_txt}") from e


def n8n_patch(url: str, token: str, path: str, payload: dict) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{url}/api/v1{path}",
        data=body,
        headers={
            "X-N8N-API-KEY": token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"n8n API PATCH {e.code}: {e.read().decode()}") from e


def build_generation_workflow(env: dict, voice_rules: str) -> dict:
    """Build the full generation workflow definition."""

    baserow_url = env["BASEROW_URL"]
    baserow_token = env["BASEROW_TOKEN"]
    anthropic_key = env["ANTHROPIC_API_KEY"]
    anthropic_model = env.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")

    T_KINFOLK  = env["BASEROW_TABLE_KINFOLK"]
    T_KIN      = env["BASEROW_TABLE_KIN"]
    T_LOGS     = env["BASEROW_TABLE_VISIT_LOGS"]
    T_DRAFTS   = env["BASEROW_TABLE_GENERATED_DRAFTS"]
    T_DOSSIER  = env["BASEROW_TABLE_THE_DOSSIER"]
    T_411      = env["BASEROW_TABLE_THE_411"]
    T_TRAINING = env["BASEROW_TABLE_TRAINING_DOCUMENTS"]

    # Embed voice rules as escaped string for JS
    voice_rules_js = json.dumps(voice_rules)

    system_prompt_js = json.dumps(
        "You are Auntie. You write communications for Tribe Tails Pet Care in Auntie's authentic voice.\n\n"
        "HARD RULES:\n"
        "- Output ONLY the communication itself. No preamble, no 'here is your message', no meta-commentary.\n"
        "- Never use em dashes. Use ellipses (.....) or commas.\n"
        "- First person, contractions always.\n"
        "- Pets are always 'Kin' — never 'pet' or 'animal'\n"
        "- Kinfolk are always 'Kinfolk' — never 'client', 'customer', or 'owner'\n"
        "- No corporate language. No generic filler.\n"
        "- Specific moments over vague summaries.\n"
        "- Tone and length adapt to communication_type:\n"
        "  - sms: conversational, 2-4 sentences max\n"
        "  - email: warm opener, full body, closing\n"
        "  - visit_report: flowing paragraph narrative (Auntie's signature format)\n"
        "  - social_post: punchy, brand voice, can use emojis sparingly\n"
        "  - blog_post: longer, storytelling, multiple paragraphs ok\n"
        "  - general: match the tone_hint if provided\n\n"
        "=== AUNTIE VOICE RULES ===\n\n"
    ) [:-1] + "\" + " + voice_rules_js  # append voice rules

    # Actually build it properly:
    full_system = (
        "You are Auntie. You write communications for Tribe Tails Pet Care in Auntie's authentic voice.\n\n"
        "HARD RULES:\n"
        "- Output ONLY the communication itself. No preamble, no 'here is your message', no meta-commentary.\n"
        "- Never use em dashes. Use ellipses (.....) or commas.\n"
        "- First person, contractions always.\n"
        "- Pets are always 'Kin' — never 'pet' or 'animal'\n"
        "- Kinfolk are always 'Kinfolk' — never 'client', 'customer', or 'owner'\n"
        "- No corporate language. No generic filler.\n"
        "- Specific moments over vague summaries.\n"
        "- Tone and length adapt to communication_type:\n"
        "  - sms: conversational, 2-4 sentences max\n"
        "  - email: warm opener, full body, closing\n"
        "  - visit_report: flowing paragraph narrative (Auntie signature format)\n"
        "  - social_post: punchy, brand voice, can use emojis sparingly\n"
        "  - blog_post: longer, storytelling, multiple paragraphs ok\n"
        "  - general: match the tone_hint if provided\n\n"
        "=== AUNTIE VOICE RULES ===\n\n"
        + voice_rules
    )
    full_system_js = json.dumps(full_system)

    nodes = [
        # 1. Webhook
        {
            "id": "a1b2c3d4-0001-0001-0001-000000000001",
            "name": "Webhook",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [0, 300],
            "parameters": {
                "httpMethod": "POST",
                "path": "auntie-generate",
                "responseMode": "responseNode",
                "options": {},
            },
            "webhookId": "auntie-generate-webhook",
        },

        # 2. Parse and validate input
        {
            "id": "a1b2c3d4-0002-0002-0002-000000000002",
            "name": "Parse Input",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [260, 300],
            "parameters": {
                "jsCode": """
const body = $input.first().json.body || $input.first().json;

const communication_type = (body.communication_type || '').trim().toLowerCase();
const recipient = (body.recipient || '').trim();
const raw_notes = (body.raw_notes || '').trim();
const tone_hint = (body.tone_hint || 'warm').trim();
const max_length = (body.max_length || 'medium').trim();

const valid_types = ['sms','email','visit_report','social_post','blog_post','general'];

if (!communication_type || !valid_types.includes(communication_type)) {
  throw new Error(`communication_type must be one of: ${valid_types.join(', ')}`);
}
if (!recipient) throw new Error('recipient is required');
if (!raw_notes) throw new Error('raw_notes is required');

return [{
  json: {
    communication_type,
    recipient,
    raw_notes,
    tone_hint,
    max_length,
  }
}];
""",
            },
        },

        # 3. Fetch all Kinfolk
        {
            "id": "a1b2c3d4-0003-0003-0003-000000000003",
            "name": "Fetch Kinfolk",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [520, 300],
            "parameters": {
                "method": "GET",
                "url": f"{baserow_url}/api/database/rows/table/{T_KINFOLK}/?user_field_names=true&size=200",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # 4. Match recipient to kinfolk
        {
            "id": "a1b2c3d4-0004-0004-0004-000000000004",
            "name": "Match Recipient",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [780, 300],
            "parameters": {
                "jsCode": """
const parsed = $('Parse Input').first().json;
const kinfolkData = $input.first().json;

const recipient = parsed.recipient.toLowerCase();
const rows = kinfolkData.results || [];

const match = rows.find(r => (r['Display Name'] || '').toLowerCase() === recipient);

return [{
  json: {
    ...parsed,
    kinfolk_id: match ? match.id : null,
    kinfolk_name: match ? match['Display Name'] : parsed.recipient,
    is_known_kinfolk: !!match,
  }
}];
""",
            },
        },

        # 5. IF known kinfolk branch
        {
            "id": "a1b2c3d4-0005-0005-0005-000000000005",
            "name": "Known Kinfolk?",
            "type": "n8n-nodes-base.if",
            "typeVersion": 2,
            "position": [1040, 300],
            "parameters": {
                "conditions": {
                    "options": {"caseSensitive": False},
                    "conditions": [
                        {
                            "id": "cond-1",
                            "leftValue": "={{ $json.is_known_kinfolk }}",
                            "rightValue": True,
                            "operator": {"type": "boolean", "operation": "equals"},
                        }
                    ],
                    "combinator": "and",
                },
            },
        },

        # 6a. Fetch Dossier (true branch)
        {
            "id": "a1b2c3d4-0006-0006-0006-000000000006",
            "name": "Fetch Dossier",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1300, 100],
            "parameters": {
                "method": "GET",
                "url": f"={baserow_url}/api/database/rows/table/{T_DOSSIER}/?user_field_names=true&size=200&filter__kinfolk_id__equal={{{{$('Match Recipient').first().json.kinfolk_id}}}}",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # 6b. Fetch all Kin
        {
            "id": "a1b2c3d4-0007-0007-0007-000000000007",
            "name": "Fetch Kin",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1300, 220],
            "parameters": {
                "method": "GET",
                "url": f"{baserow_url}/api/database/rows/table/{T_KIN}/?user_field_names=true&size=200",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # 6c. Fetch 411s
        {
            "id": "a1b2c3d4-0008-0008-0008-000000000008",
            "name": "Fetch 411s",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1300, 340],
            "parameters": {
                "method": "GET",
                "url": f"{baserow_url}/api/database/rows/table/{T_411}/?user_field_names=true&size=200",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # 6d. Fetch Recent Visit Logs
        {
            "id": "a1b2c3d4-0009-0009-0009-000000000009",
            "name": "Fetch Visit Logs",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1300, 460],
            "parameters": {
                "method": "GET",
                "url": f"={baserow_url}/api/database/rows/table/{T_LOGS}/?user_field_names=true&size=200&filter__kinfolk_id__equal={{{{$('Match Recipient').first().json.kinfolk_id}}}}",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # 6e. Fetch Training Docs (type-matched)
        {
            "id": "a1b2c3d4-0010-0010-0010-000000000010",
            "name": "Fetch Training Docs",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1300, 580],
            "parameters": {
                "method": "GET",
                "url": f"={baserow_url}/api/database/rows/table/{T_TRAINING}/?user_field_names=true&size=200&filter__communication_type__equal={{{{$('Match Recipient').first().json.communication_type}}}}",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # 6f. Build prompt for known kinfolk
        {
            "id": "a1b2c3d4-0011-0011-0011-000000000011",
            "name": "Build Prompt (Known)",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1600, 300],
            "parameters": {
                "jsCode": f"""
const ctx = $('Match Recipient').first().json;
const dossierData = $('Fetch Dossier').first().json;
const kinData = $('Fetch Kin').first().json;
const four11Data = $('Fetch 411s').first().json;
const logData = $('Fetch Visit Logs').first().json;
const trainingData = $('Fetch Training Docs').first().json;

// Dossier
const dossier = (dossierData.results || [])[0] || {{}};
let dossierBlock = '';
if (dossier.raw_summary) {{
  dossierBlock = `KINFOLK DOSSIER:\\n${{dossier.raw_summary}}`;
  if (dossier.communication_style) dossierBlock += `\\n\\nCommunication style: ${{dossier.communication_style}}`;
  if (dossier.household_notes) dossierBlock += `\\nHousehold notes: ${{dossier.household_notes}}`;
  if (dossier.preferred_contact_method) dossierBlock += `\\nPreferred contact: ${{dossier.preferred_contact_method}}`;
}}

// Kin + 411s for this kinfolk
const allKin = (kinData.results || []).filter(k => String(k.kinfolk_id) === String(ctx.kinfolk_id));
const allKinIds = new Set(allKin.map(k => k.id));
const all411s = (four11Data.results || []).filter(k => allKinIds.has(k.kin_id));

let kinBlock = '';
if (allKin.length > 0) {{
  kinBlock = 'KIN IN THIS HOUSEHOLD AND THEIR 411s:\\n';
  for (const kin of allKin) {{
    const f411 = all411s.find(k => k.kin_id === kin.id) || {{}};
    kinBlock += `\\n${{kin.Name}} (${{kin.species || 'unknown species'}})`;
    if (f411.personality) kinBlock += `\\nPersonality: ${{f411.personality}}`;
    if (f411.quirks_and_preferences) kinBlock += `\\nQuirks: ${{f411.quirks_and_preferences}}`;
    if (f411.medical_notes && f411.medical_notes !== 'Not yet documented.') kinBlock += `\\nMedical: ${{f411.medical_notes}}`;
    if (f411.dietary_details && f411.dietary_details !== 'Not yet documented.') kinBlock += `\\nDiet: ${{f411.dietary_details}}`;
    kinBlock += '\\n';
  }}
}}

// Last 5 visit logs for tone anchoring
const logs = (logData.results || [])
  .filter(l => l.auntie_notes && l.auntie_notes.trim())
  .sort((a, b) => b.id - a.id)
  .slice(0, 5);
let logsBlock = '';
if (logs.length > 0) {{
  logsBlock = 'RECENT VISIT NOTES (tone anchors — do not copy):\\n';
  logsBlock += logs.map(l => `--- ${{l.submitted || ''}} (${{l.service_type || ''}}) ---\\n${{l.auntie_notes}}`).join('\\n\\n');
}}

// Training docs
const trainingDocs = (trainingData.results || []).filter(t => t.content && t.content.trim());
let trainingBlock = '';
if (trainingDocs.length > 0) {{
  trainingBlock = 'VOICE TRAINING EXAMPLES (reference only — do not copy directly):\\n';
  trainingBlock += trainingDocs.map(t => `[${{t.title}}]\\n${{t.content}}`).join('\\n\\n');
}}

// Build user message
const parts = [
  `COMMUNICATION TYPE: ${{ctx.communication_type}}`,
  `RECIPIENT: ${{ctx.kinfolk_name}}`,
  `TONE HINT: ${{ctx.tone_hint}}`,
  `LENGTH: ${{ctx.max_length}}`,
];
if (dossierBlock) parts.push(dossierBlock);
if (kinBlock) parts.push(kinBlock);
if (logsBlock) parts.push(logsBlock);
if (trainingBlock) parts.push(trainingBlock);
parts.push(`RAW NOTES FROM SYD (transform these into the communication):\\n${{ctx.raw_notes}}`);

return [{{
  json: {{
    ...ctx,
    user_message: parts.join('\\n\\n'),
    context_loaded: true,
  }}
}}];
""",
            },
        },

        # 6g. Fetch Training Docs generic (false branch)
        {
            "id": "a1b2c3d4-0012-0012-0012-000000000012",
            "name": "Fetch Training Docs (Generic)",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1300, 700],
            "parameters": {
                "method": "GET",
                "url": f"={baserow_url}/api/database/rows/table/{T_TRAINING}/?user_field_names=true&size=200&filter__communication_type__equal={{{{$('Match Recipient').first().json.communication_type}}}}",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # 6h. Build prompt generic
        {
            "id": "a1b2c3d4-0013-0013-0013-000000000013",
            "name": "Build Prompt (Generic)",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1600, 600],
            "parameters": {
                "jsCode": """
const ctx = $('Match Recipient').first().json;
const trainingData = $('Fetch Training Docs (Generic)').first().json;

const trainingDocs = (trainingData.results || []).filter(t => t.content && t.content.trim());
let trainingBlock = '';
if (trainingDocs.length > 0) {
  trainingBlock = 'VOICE TRAINING EXAMPLES (reference only — do not copy directly):\\n';
  trainingBlock += trainingDocs.map(t => `[${t.title}]\\n${t.content}`).join('\\n\\n');
}

const parts = [
  `COMMUNICATION TYPE: ${ctx.communication_type}`,
  `RECIPIENT: ${ctx.recipient}`,
  `TONE HINT: ${ctx.tone_hint}`,
  `LENGTH: ${ctx.max_length}`,
];
if (trainingBlock) parts.push(trainingBlock);
parts.push(`RAW NOTES FROM SYD (transform these into the communication):\\n${ctx.raw_notes}`);

return [{
  json: {
    ...ctx,
    user_message: parts.join('\\n\\n'),
    context_loaded: false,
  }
}];
""",
            },
        },

        # 7. Merge branches + call Claude
        {
            "id": "a1b2c3d4-0014-0014-0014-000000000014",
            "name": "Call Claude",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1900, 300],
            "parameters": {
                "method": "POST",
                "url": "https://api.anthropic.com/v1/messages",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {"name": "x-api-key", "value": anthropic_key},
                        {"name": "anthropic-version", "value": "2023-06-01"},
                        {"name": "content-type", "value": "application/json"},
                    ]
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": f"""={{{{
  JSON.stringify({{
    model: "{anthropic_model}",
    max_tokens: 2048,
    system: {full_system_js},
    messages: [{{
      role: "user",
      content: $json.user_message
    }}]
  }})
}}}}""",
                "options": {},
            },
        },

        # 8. Parse Claude response
        {
            "id": "a1b2c3d4-0015-0015-0015-000000000015",
            "name": "Parse Claude Response",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [2160, 300],
            "parameters": {
                "jsCode": """
const claudeResp = $input.first().json;
const ctx = $('Build Prompt (Known)').first()?.json || $('Build Prompt (Generic)').first()?.json;

// Extract text from Claude response
const content = claudeResp.content || [];
const textBlocks = content.filter(b => b.type === 'text');
const generated_copy = textBlocks.map(b => b.text).join('').trim();

if (!generated_copy) throw new Error('Claude returned no text content');

const usage = claudeResp.usage || {};
const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
const kinfolk_id = ctx?.kinfolk_id || null;
const kinfolk_name = ctx?.kinfolk_name || ctx?.recipient || '';
const comm_type = ctx?.communication_type || '';
const draft_label = `${now} — ${comm_type} — ${kinfolk_name}`;

return [{
  json: {
    generated_copy,
    kinfolk_id,
    kinfolk_name,
    communication_type: comm_type,
    recipient: ctx?.recipient || '',
    raw_notes: ctx?.raw_notes || '',
    tone_hint: ctx?.tone_hint || '',
    max_length: ctx?.max_length || '',
    draft_label,
    model: claudeResp.model || '',
    generated_at: now,
    usage,
  }
}];
""",
            },
        },

        # 9. Write draft to Baserow
        {
            "id": "a1b2c3d4-0016-0016-0016-000000000016",
            "name": "Write Draft",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [2420, 300],
            "parameters": {
                "method": "POST",
                "url": f"{baserow_url}/api/database/rows/table/{T_DRAFTS}/?user_field_names=true",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": """={{ JSON.stringify({
  draft_label: $json.draft_label,
  communication_type: $json.communication_type,
  recipient: $json.recipient,
  raw_notes: $json.raw_notes,
  generated_copy: $json.generated_copy,
  kinfolk_id: $json.kinfolk_id,
  model: $json.model,
  generated_at: $json.generated_at,
  status: "generated",
  tone_hint: $json.tone_hint,
  max_length: $json.max_length,
}) }}""",
                "options": {},
            },
        },

        # 10. Respond to webhook
        {
            "id": "a1b2c3d4-0017-0017-0017-000000000017",
            "name": "Respond",
            "type": "n8n-nodes-base.respondToWebhook",
            "typeVersion": 1.1,
            "position": [2680, 300],
            "parameters": {
                "respondWith": "json",
                "responseBody": """={{ JSON.stringify({
  generated_copy: $('Parse Claude Response').first().json.generated_copy,
  draft_id: $json.id,
  kinfolk_id: $('Parse Claude Response').first().json.kinfolk_id,
  kinfolk_name: $('Parse Claude Response').first().json.kinfolk_name,
  communication_type: $('Parse Claude Response').first().json.communication_type,
  model: $('Parse Claude Response').first().json.model,
  generated_at: $('Parse Claude Response').first().json.generated_at,
  usage: $('Parse Claude Response').first().json.usage,
  warnings: [],
}) }}""",
                "options": {"responseCode": 200},
            },
        },

        # Error responder
        {
            "id": "a1b2c3d4-0018-0018-0018-000000000018",
            "name": "Error Response",
            "type": "n8n-nodes-base.respondToWebhook",
            "typeVersion": 1.1,
            "position": [780, 560],
            "parameters": {
                "respondWith": "json",
                "responseBody": """={{ JSON.stringify({ error: $json.message || 'Unknown error' }) }}""",
                "options": {"responseCode": 400},
            },
        },
    ]

    connections = {
        "Webhook": {"main": [[{"node": "Parse Input", "type": "main", "index": 0}]]},
        "Parse Input": {"main": [[{"node": "Fetch Kinfolk", "type": "main", "index": 0}]]},
        "Fetch Kinfolk": {"main": [[{"node": "Match Recipient", "type": "main", "index": 0}]]},
        "Match Recipient": {"main": [[{"node": "Known Kinfolk?", "type": "main", "index": 0}]]},
        "Known Kinfolk?": {
            "main": [
                # true branch -> all 5 fetches
                [
                    {"node": "Fetch Dossier", "type": "main", "index": 0},
                    {"node": "Fetch Kin", "type": "main", "index": 0},
                    {"node": "Fetch 411s", "type": "main", "index": 0},
                    {"node": "Fetch Visit Logs", "type": "main", "index": 0},
                    {"node": "Fetch Training Docs", "type": "main", "index": 0},
                ],
                # false branch
                [{"node": "Fetch Training Docs (Generic)", "type": "main", "index": 0}],
            ]
        },
        # True branch: all fetches -> build prompt
        "Fetch Dossier": {"main": [[{"node": "Build Prompt (Known)", "type": "main", "index": 0}]]},
        "Fetch Kin": {"main": [[{"node": "Build Prompt (Known)", "type": "main", "index": 1}]]},
        "Fetch 411s": {"main": [[{"node": "Build Prompt (Known)", "type": "main", "index": 2}]]},
        "Fetch Visit Logs": {"main": [[{"node": "Build Prompt (Known)", "type": "main", "index": 3}]]},
        "Fetch Training Docs": {"main": [[{"node": "Build Prompt (Known)", "type": "main", "index": 4}]]},
        "Build Prompt (Known)": {"main": [[{"node": "Call Claude", "type": "main", "index": 0}]]},
        # False branch
        "Fetch Training Docs (Generic)": {"main": [[{"node": "Build Prompt (Generic)", "type": "main", "index": 0}]]},
        "Build Prompt (Generic)": {"main": [[{"node": "Call Claude", "type": "main", "index": 0}]]},
        # After Claude
        "Call Claude": {"main": [[{"node": "Parse Claude Response", "type": "main", "index": 0}]]},
        "Parse Claude Response": {"main": [[{"node": "Write Draft", "type": "main", "index": 0}]]},
        "Write Draft": {"main": [[{"node": "Respond", "type": "main", "index": 0}]]},
    }

    return {
        "name": "Auntie OS — Generate",
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
    }


def build_profile_update_workflow(env: dict, voice_rules: str) -> dict:
    """Build the profile auto-update workflow."""

    baserow_url = env["BASEROW_URL"]
    baserow_token = env["BASEROW_TOKEN"]
    anthropic_key = env["ANTHROPIC_API_KEY"]
    anthropic_model = env.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")

    T_DRAFTS   = env["BASEROW_TABLE_GENERATED_DRAFTS"]
    T_TRAINING = env["BASEROW_TABLE_TRAINING_DOCUMENTS"]
    T_DOSSIER  = env["BASEROW_TABLE_THE_DOSSIER"]
    T_411      = env["BASEROW_TABLE_THE_411"]
    T_KIN      = env["BASEROW_TABLE_KIN"]
    T_LOGS     = env["BASEROW_TABLE_VISIT_LOGS"]

    nodes = [
        {
            "id": "b1c2d3e4-0001-0001-0001-000000000001",
            "name": "Webhook",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [0, 300],
            "parameters": {
                "httpMethod": "POST",
                "path": "auntie-update-profiles",
                "responseMode": "responseNode",
                "options": {},
            },
            "webhookId": "auntie-update-profiles-webhook",
        },

        {
            "id": "b1c2d3e4-0002-0002-0002-000000000002",
            "name": "Parse Trigger",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [260, 300],
            "parameters": {
                "jsCode": """
const body = $input.first().json.body || $input.first().json;
const trigger_source = (body.trigger_source || '').trim();
const row_id = body.row_id;
const kinfolk_id = body.kinfolk_id;

const valid_sources = ['generated_draft', 'training_document'];
if (!valid_sources.includes(trigger_source)) {
  throw new Error(`trigger_source must be one of: ${valid_sources.join(', ')}`);
}
if (!row_id) throw new Error('row_id is required');
if (!kinfolk_id) throw new Error('kinfolk_id is required');

return [{ json: { trigger_source, row_id, kinfolk_id } }];
""",
            },
        },

        # Fetch the triggering row (draft or training doc)
        {
            "id": "b1c2d3e4-0003-0003-0003-000000000003",
            "name": "Fetch Trigger Row",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [520, 300],
            "parameters": {
                "method": "GET",
                "url": f"""={{ $json.trigger_source === 'generated_draft'
  ? '{baserow_url}/api/database/rows/table/{T_DRAFTS}/' + $json.row_id + '/?user_field_names=true'
  : '{baserow_url}/api/database/rows/table/{T_TRAINING}/' + $json.row_id + '/?user_field_names=true'
}}""",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # Fetch current dossier for this kinfolk
        {
            "id": "b1c2d3e4-0004-0004-0004-000000000004",
            "name": "Fetch Current Dossier",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [780, 180],
            "parameters": {
                "method": "GET",
                "url": f"={baserow_url}/api/database/rows/table/{T_DOSSIER}/?user_field_names=true&filter__kinfolk_id__equal={{{{$('Parse Trigger').first().json.kinfolk_id}}}}",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # Fetch kin for kinfolk
        {
            "id": "b1c2d3e4-0005-0005-0005-000000000005",
            "name": "Fetch Kin",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [780, 300],
            "parameters": {
                "method": "GET",
                "url": f"={baserow_url}/api/database/rows/table/{T_KIN}/?user_field_names=true&size=200&filter__kinfolk_id__equal={{{{$('Parse Trigger').first().json.kinfolk_id}}}}",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # Fetch all 411s for household
        {
            "id": "b1c2d3e4-0006-0006-0006-000000000006",
            "name": "Fetch 411s",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [780, 420],
            "parameters": {
                "method": "GET",
                "url": f"{baserow_url}/api/database/rows/table/{T_411}/?user_field_names=true&size=200",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "options": {},
            },
        },

        # Build update prompts and call Claude
        {
            "id": "b1c2d3e4-0007-0007-0007-000000000007",
            "name": "Build Update Prompts",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1060, 300],
            "parameters": {
                "jsCode": f"""
const trigger = $('Parse Trigger').first().json;
const triggerRow = $('Fetch Trigger Row').first().json;
const dossierData = $('Fetch Current Dossier').first().json;
const kinData = $('Fetch Kin').first().json;
const four11Data = $('Fetch 411s').first().json;

const dossier = (dossierData.results || [])[0] || {{}};
const allKin = kinData.results || [];
const allKinIds = new Set(allKin.map(k => k.id));
const all411s = (four11Data.results || []).filter(k => allKinIds.has(k.kin_id));

// What's the new content?
const new_content = triggerRow.generated_copy || triggerRow.content || '';
const content_type = triggerRow.communication_type || triggerRow.title || trigger.trigger_source;

const voice_rules = {json.dumps(voice_rules)};

const systemPrompt = `You are Auntie's memory system. Your job is to extract facts from new communications and update living profiles.

Be specific and factual — only note what is actually stated or clearly implied in the new content.
Write in first person as Auntie. No em dashes. No corporate language.

${{voice_rules}}`;

// Dossier update prompt
const dossierUpdatePrompt = `CURRENT DOSSIER for ${{dossier.display_name || 'this Kinfolk'}}:
${{dossier.raw_summary || 'No existing summary.'}}

NEW COMMUNICATION (${{content_type}}):
${{new_content}}

Review the new communication and update the following profile sections with any new facts, observations, or context you can extract. For each section, output ONLY what should replace the current content — incorporate existing info with new info. If nothing new was learned for a section, output the existing content unchanged.

Output EXACTLY in this format:

COMMUNICATION_STYLE:
[updated text]

HOUSEHOLD_NOTES:
[updated text]

RELATIONSHIP_WITH_AUNTIE:
[updated text]

IMPORTANT_LIFE_CONTEXT:
[updated text]

RAW_SUMMARY:
[updated flowing narrative paragraph]`;

// 411 update prompts — one per kin
const kinUpdatePrompts = allKin.map(kin => {{
  const f411 = all411s.find(k => k.kin_id === kin.id) || {{}};
  return {{
    kin_id: kin.id,
    kin_name: kin.Name,
    four11_row_id: f411.id,
    prompt: `CURRENT 411 for ${{kin.Name}}:
${{f411.raw_summary || 'No existing summary.'}}

NEW COMMUNICATION (${{content_type}}):
${{new_content}}

If ${{kin.Name}} is mentioned or relevant in the new communication, update their 411 with any new facts. If they are not mentioned, output "NO_CHANGES" for every section.

Output EXACTLY in this format:

PERSONALITY:
[updated text or NO_CHANGES]

DIETARY_DETAILS:
[updated text or NO_CHANGES]

MEDICAL_NOTES:
[updated text or NO_CHANGES]

QUIRKS_AND_PREFERENCES:
[updated text or NO_CHANGES]

SAFETY_NOTES:
[updated text or NO_CHANGES]

RELATIONSHIP_WITH_OTHER_KIN:
[updated text or NO_CHANGES]

RAW_SUMMARY:
[updated flowing narrative paragraph or NO_CHANGES]`
  }};
}});

return [{{
  json: {{
    trigger,
    dossier_row_id: dossier.id,
    dossierUpdatePrompt,
    kinUpdatePrompts,
    systemPrompt,
  }}
}}];
""",
            },
        },

        # Call Claude for dossier update
        {
            "id": "b1c2d3e4-0008-0008-0008-000000000008",
            "name": "Call Claude — Dossier",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1320, 180],
            "parameters": {
                "method": "POST",
                "url": "https://api.anthropic.com/v1/messages",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {"name": "x-api-key", "value": anthropic_key},
                        {"name": "anthropic-version", "value": "2023-06-01"},
                        {"name": "content-type", "value": "application/json"},
                    ]
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": f"""={{ JSON.stringify({{
  model: "{anthropic_model}",
  max_tokens: 1500,
  system: $json.systemPrompt,
  messages: [{{ role: "user", content: $json.dossierUpdatePrompt }}]
}}) }}""",
                "options": {},
            },
        },

        # Parse dossier update and patch Baserow
        {
            "id": "b1c2d3e4-0009-0009-0009-000000000009",
            "name": "Update Dossier in Baserow",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1580, 180],
            "parameters": {
                "jsCode": f"""
const claudeResp = $('Call Claude — Dossier').first().json;
const ctx = $('Build Update Prompts').first().json;

const text = (claudeResp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

function extract(label, raw, nextLabel) {{
  const start = raw.indexOf(label + ':');
  if (start === -1) return null;
  const lineEnd = raw.indexOf('\\n', start);
  const contentStart = lineEnd + 1;
  if (nextLabel) {{
    const nextStart = raw.indexOf(nextLabel + ':', contentStart);
    return nextStart !== -1 ? raw.slice(contentStart, nextStart).trim() : raw.slice(contentStart).trim();
  }}
  return raw.slice(contentStart).trim();
}}

const fields = {{
  communication_style:      extract('COMMUNICATION_STYLE', text, 'HOUSEHOLD_NOTES'),
  household_notes:          extract('HOUSEHOLD_NOTES', text, 'RELATIONSHIP_WITH_AUNTIE'),
  relationship_with_auntie: extract('RELATIONSHIP_WITH_AUNTIE', text, 'IMPORTANT_LIFE_CONTEXT'),
  important_life_context:   extract('IMPORTANT_LIFE_CONTEXT', text, 'RAW_SUMMARY'),
  raw_summary:              extract('RAW_SUMMARY', text, null),
  last_updated:             new Date().toISOString().slice(0, 16).replace('T', ' '),
}};

// Remove null fields
const patch = Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== null));

if (!ctx.dossier_row_id) {{
  return [{{ json: {{ dossier_updated: false, reason: 'no dossier row found' }} }}];
}}

// PATCH via HTTP in next node — pass the data
return [{{ json: {{ dossier_row_id: ctx.dossier_row_id, patch, kinUpdatePrompts: ctx.kinUpdatePrompts, systemPrompt: ctx.systemPrompt }} }}];
""",
            },
        },

        {
            "id": "b1c2d3e4-0010-0010-0010-000000000010",
            "name": "Patch Dossier",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1840, 180],
            "parameters": {
                "method": "PATCH",
                "url": f"={baserow_url}/api/database/rows/table/{T_DOSSIER}/{{{{$json.dossier_row_id}}}}/?user_field_names=true",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [{"name": "Authorization", "value": f"Token {baserow_token}"}]
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={{ JSON.stringify($json.patch) }}",
                "options": {},
            },
        },

        # Respond
        {
            "id": "b1c2d3e4-0011-0011-0011-000000000011",
            "name": "Respond",
            "type": "n8n-nodes-base.respondToWebhook",
            "typeVersion": 1.1,
            "position": [2100, 300],
            "parameters": {
                "respondWith": "json",
                "responseBody": """={{ JSON.stringify({
  ok: true,
  dossier_updated: true,
  updated_at: new Date().toISOString(),
}) }}""",
                "options": {"responseCode": 200},
            },
        },
    ]

    connections = {
        "Webhook": {"main": [[{"node": "Parse Trigger", "type": "main", "index": 0}]]},
        "Parse Trigger": {"main": [[{"node": "Fetch Trigger Row", "type": "main", "index": 0}]]},
        "Fetch Trigger Row": {
            "main": [
                [
                    {"node": "Fetch Current Dossier", "type": "main", "index": 0},
                    {"node": "Fetch Kin", "type": "main", "index": 0},
                    {"node": "Fetch 411s", "type": "main", "index": 0},
                ]
            ]
        },
        "Fetch Current Dossier": {"main": [[{"node": "Build Update Prompts", "type": "main", "index": 0}]]},
        "Fetch Kin": {"main": [[{"node": "Build Update Prompts", "type": "main", "index": 1}]]},
        "Fetch 411s": {"main": [[{"node": "Build Update Prompts", "type": "main", "index": 2}]]},
        "Build Update Prompts": {"main": [[{"node": "Call Claude — Dossier", "type": "main", "index": 0}]]},
        "Call Claude — Dossier": {"main": [[{"node": "Update Dossier in Baserow", "type": "main", "index": 0}]]},
        "Update Dossier in Baserow": {"main": [[{"node": "Patch Dossier", "type": "main", "index": 0}]]},
        "Patch Dossier": {"main": [[{"node": "Respond", "type": "main", "index": 0}]]},
    }

    return {
        "name": "Auntie OS — Update Profiles",
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
    }


def main() -> int:
    env = _load_env()
    n8n_url = env.get("N8N_URL", "http://localhost:51002")
    n8n_token = env.get("N8N_TOKEN", "")

    if not n8n_token:
        print("ERROR: N8N_TOKEN not set in .env")
        return 1

    voice_rules = VOICE_RULES_PATH.read_text()
    print(f"Voice rules loaded: {len(voice_rules)} chars")

    workflows = [
        ("Generation", build_generation_workflow(env, voice_rules)),
        ("Profile Update", build_profile_update_workflow(env, voice_rules)),
    ]

    created_ids = []
    for label, workflow in workflows:
        print(f"\nCreating '{workflow['name']}'...")
        try:
            result = n8n_post(n8n_url, n8n_token, "/workflows", workflow)
            wid = result.get("id")
            print(f"  ✅ Created — id: {wid}")

            # Activate it
            try:
                act = n8n_patch(n8n_url, n8n_token, f"/workflows/{wid}/activate", {})
                print(f"  ✅ Activated")
                webhook_path = None
                for node in workflow["nodes"]:
                    if node["type"] == "n8n-nodes-base.webhook":
                        webhook_path = node["parameters"].get("path")
                        break
                if webhook_path:
                    print(f"  🔗 Webhook: {n8n_url}/webhook/{webhook_path}")
            except Exception as e:
                print(f"  ⚠  Activation failed (activate manually in UI): {e}")

            created_ids.append(wid)
        except Exception as e:
            print(f"  ❌ Failed: {e}")
            return 1

    print(f"\n\nDone. Created {len(created_ids)} workflow(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
