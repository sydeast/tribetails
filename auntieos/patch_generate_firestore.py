"""Migrate Auntie OS — Generate workflow from Baserow to Firestore.

Changes:
  Fetch Kinfolk, Fetch Dossier, Fetch Kin, Fetch 411s, Fetch Visit Logs,
  Fetch Training Docs, Fetch Training Docs (Generic):
    HTTP Request nodes → Firestore getAll nodes (serviceAccount credential)

  Match Recipient (Code):
    kinfolkData.results → Firestore item array
    r['Display Name'] → firstName + lastName composite
    match.id → Firestore doc ID (unchanged)

  Build Prompt (Known) (Code):
    All Baserow field names (snake_case) → Firestore field names (camelCase)
    .results arrays → .all().map(i => i.json)

  Build Prompt (Generic) (Code):
    Same training-doc field name fixes

Run:
    N8N_URL=https://n8n.tribetails.com python3 patch_generate_firestore.py [--dry-run]
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from baserow_auth import _load_env

WORKFLOW_ID = "SIg2KsWn0oyRkSzR"
FIRESTORE_CRED = {"googleApi": {"id": "twUKBanMejv0zvkG", "name": "Google Service Account account"}}
PROJECT_ID = "auntieos-ttpc"

PUT_ALLOWED_KEYS = {"name", "nodes", "connections", "settings", "staticData"}
SETTINGS_ALLOWED_KEYS = {
    "saveExecutionProgress", "saveManualExecutions", "saveDataErrorExecution",
    "saveDataSuccessExecution", "executionTimeout", "errorWorkflow", "timezone", "executionOrder",
}


def n8n_request(method, url, token, path, payload=None):
    import urllib.request, urllib.error
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{url}/api/v1{path}",
        data=body,
        headers={
            "X-N8N-API-KEY": token,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "AuntieOS-patch/1.0",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"n8n API {method} {path} -> {e.code}: {e.read().decode()}") from e


def firestore_getall(node, collection):
    """Return a Firestore getAll node replacing an HTTP Request node."""
    return {
        "id": node["id"],
        "name": node["name"],
        "type": "n8n-nodes-base.googleFirebaseCloudFirestore",
        "typeVersion": 1.1,
        "position": node["position"],
        "alwaysOutputData": True,
        "parameters": {
            "authentication": "serviceAccount",
            "resource": "document",
            "operation": "getAll",
            "projectId": PROJECT_ID,
            "collection": collection,
            "returnAll": True,
            "simple": True,
        },
        "credentials": FIRESTORE_CRED,
    }


MATCH_RECIPIENT_JS = r"""
const parsed = $('Parse Input').first().json;
const rows = $('Fetch Kinfolk').all().map(i => i.json);

const recipient = (parsed.recipient || '').toLowerCase();
const match = rows.find(r => {
  const displayName = ((r.firstName || '') + ' ' + (r.lastName || '')).trim();
  return displayName.toLowerCase() === recipient;
});

return [{
  json: {
    ...parsed,
    kinfolk_id: match ? match.id : null,
    kinfolk_name: match ? ((match.firstName || '') + ' ' + (match.lastName || '')).trim() : parsed.recipient,
    is_known_kinfolk: !!match,
  }
}];
""".strip()

BUILD_PROMPT_KNOWN_JS = r"""
const ctx = $('Match Recipient').first().json;
const dossierItems = $('Fetch Dossier').all().map(i => i.json);
const kinItems = $('Fetch Kin').all().map(i => i.json);
const four11Items = $('Fetch 411s').all().map(i => i.json);
const logItems = $('Fetch Visit Logs').all().map(i => i.json);
const trainingItems = $('Fetch Training Docs').all().map(i => i.json);

// Dossier — Firestore docs use camelCase fields
const dossier = dossierItems.find(d => d.kinfolkId === ctx.kinfolk_id) || {};
let dossierBlock = '';
if (dossier.rawSummary) {
  dossierBlock = `KINFOLK DOSSIER:\n${dossier.rawSummary}`;
  if (dossier.communicationStyle) dossierBlock += `\n\nCommunication style: ${dossier.communicationStyle}`;
  if (dossier.householdNotes) dossierBlock += `\nHousehold notes: ${dossier.householdNotes}`;
  if (dossier.preferredContactMethod) dossierBlock += `\nPreferred contact: ${dossier.preferredContactMethod}`;
}

// Kin + 411s for this kinfolk
const allKin = kinItems.filter(k => k.kinfolkId === ctx.kinfolk_id);
const allKinIds = new Set(allKin.map(k => k.id));
const all411s = four11Items.filter(k => allKinIds.has(k.kinId));

let kinBlock = '';
if (allKin.length > 0) {
  kinBlock = 'KIN IN THIS HOUSEHOLD AND THEIR 411s:\n';
  for (const kin of allKin) {
    const f411 = all411s.find(k => k.kinId === kin.id) || {};
    kinBlock += `\n${kin.name} (${kin.species || 'unknown species'})`;
    if (f411.personality) kinBlock += `\nPersonality: ${f411.personality}`;
    if (f411.quirksAndPreferences) kinBlock += `\nQuirks: ${f411.quirksAndPreferences}`;
    if (f411.medicalNotes && f411.medicalNotes !== 'Not yet documented.') kinBlock += `\nMedical: ${f411.medicalNotes}`;
    if (f411.dietaryDetails && f411.dietaryDetails !== 'Not yet documented.') kinBlock += `\nDiet: ${f411.dietaryDetails}`;
    kinBlock += '\n';
  }
}

// Last 5 visit logs for tone anchoring
const logs = logItems
  .filter(l => l.auntieNotes && l.auntieNotes.trim())
  .sort((a, b) => (b.submitted || '').localeCompare(a.submitted || ''))
  .slice(0, 5);
let logsBlock = '';
if (logs.length > 0) {
  logsBlock = 'RECENT VISIT NOTES (tone anchors — do not copy):\n';
  logsBlock += logs.map(l => `--- ${l.submitted || ''} (${l.serviceType || ''}) ---\n${l.auntieNotes}`).join('\n\n');
}

// Training docs — filter by communicationType in JS (Firestore getAll has no filter param)
const trainingDocs = trainingItems.filter(t => t.content && t.content.trim() && t.communicationType === ctx.communication_type);
let trainingBlock = '';
if (trainingDocs.length > 0) {
  trainingBlock = 'VOICE TRAINING EXAMPLES (reference only — do not copy directly):\n';
  trainingBlock += trainingDocs.map(t => `[${t.title}]\n${t.content}`).join('\n\n');
}

// Build user message
const parts = [
  `COMMUNICATION TYPE: ${ctx.communication_type}`,
  `RECIPIENT: ${ctx.kinfolk_name}`,
  `TONE HINT: ${ctx.tone_hint}`,
  `LENGTH: ${ctx.max_length}`,
];
if (dossierBlock) parts.push(dossierBlock);
if (kinBlock) parts.push(kinBlock);
if (logsBlock) parts.push(logsBlock);
if (trainingBlock) parts.push(trainingBlock);
parts.push(`RAW NOTES FROM SYD (transform these into the communication):\n${ctx.raw_notes}`);

return [{
  json: {
    ...ctx,
    user_message: parts.join('\n\n'),
    context_loaded: true,
  }
}];
""".strip()

BUILD_PROMPT_GENERIC_JS = r"""
const ctx = $('Match Recipient').first().json;
const trainingItems = $('Fetch Training Docs (Generic)').all().map(i => i.json);

const trainingDocs = trainingItems.filter(t => t.content && t.content.trim() && t.communicationType === ctx.communication_type);
let trainingBlock = '';
if (trainingDocs.length > 0) {
  trainingBlock = 'VOICE TRAINING EXAMPLES (reference only — do not copy directly):\n';
  trainingBlock += trainingDocs.map(t => `[${t.title}]\n${t.content}`).join('\n\n');
}

const parts = [
  `COMMUNICATION TYPE: ${ctx.communication_type}`,
  `RECIPIENT: ${ctx.recipient}`,
  `TONE HINT: ${ctx.tone_hint}`,
  `LENGTH: ${ctx.max_length}`,
];
if (trainingBlock) parts.push(trainingBlock);
parts.push(`RAW NOTES FROM SYD (transform these into the communication):\n${ctx.raw_notes}`);

return [{
  json: {
    ...ctx,
    user_message: parts.join('\n\n'),
    context_loaded: false,
  }
}];
""".strip()

FIRESTORE_NODES = {
    "Fetch Kinfolk":               "kinfolk",
    "Fetch Dossier":               "dossiers",
    "Fetch Kin":                   "kin",
    "Fetch 411s":                  "411",
    "Fetch Visit Logs":            "visit_logs",
    "Fetch Training Docs":         "training_documents",
    "Fetch Training Docs (Generic)": "training_documents",
}

CODE_UPDATES = {
    "Match Recipient":       MATCH_RECIPIENT_JS,
    "Build Prompt (Known)":  BUILD_PROMPT_KNOWN_JS,
    "Build Prompt (Generic)": BUILD_PROMPT_GENERIC_JS,
}


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    env = _load_env()
    n8n_url = (os.environ.get("N8N_URL") or env.get("N8N_URL", "")).rstrip("/")
    n8n_token = os.environ.get("N8N_TOKEN") or env.get("N8N_TOKEN", "")
    if not n8n_url or not n8n_token:
        print("ERROR: N8N_URL or N8N_TOKEN missing", file=sys.stderr)
        return 1

    print(f"Fetching workflow {WORKFLOW_ID} from {n8n_url}…")
    wf = n8n_request("GET", n8n_url, n8n_token, f"/workflows/{WORKFLOW_ID}")
    print(f"  name: {wf.get('name')}, nodes: {len(wf.get('nodes', []))}")

    snapshot_dir = Path(__file__).parent / "_workflow_snapshots"
    snapshot_dir.mkdir(exist_ok=True)
    snapshot_path = snapshot_dir / f"{WORKFLOW_ID}_pre_firestore.json"
    snapshot_path.write_text(json.dumps(wf, indent=2))
    print(f"  snapshot saved: {snapshot_path}")

    by_name = {n["name"]: n for n in wf["nodes"]}

    # --- Replace HTTP Baserow nodes with Firestore getAll ---
    print("\nFirestore node replacements:")
    for node_name, collection in FIRESTORE_NODES.items():
        if node_name not in by_name:
            print(f"  ⚠  {node_name} not found — skipping")
            continue
        original = by_name[node_name]
        by_name[node_name] = firestore_getall(original, collection)
        print(f"  ✓ {node_name} → Firestore getAll '{collection}'")

    # --- Update Code nodes ---
    print("\nCode node updates:")
    for node_name, new_js in CODE_UPDATES.items():
        if node_name not in by_name:
            print(f"  ⚠  {node_name} not found — skipping")
            continue
        by_name[node_name]["parameters"]["jsCode"] = new_js
        print(f"  ✓ {node_name}")

    # Rebuild nodes list from dict (preserves order, replaces in-place)
    wf["nodes"] = list(by_name.values())

    # --- PUT ---
    put_payload = {k: v for k, v in wf.items() if k in PUT_ALLOWED_KEYS}
    if "settings" in put_payload and isinstance(put_payload["settings"], dict):
        put_payload["settings"] = {
            k: v for k, v in put_payload["settings"].items() if k in SETTINGS_ALLOWED_KEYS
        }

    if dry_run:
        out = snapshot_dir / f"{WORKFLOW_ID}_post_firestore_DRYRUN.json"
        out.write_text(json.dumps(put_payload, indent=2))
        print(f"\nDry run — preview at {out}")
        return 0

    print(f"\nPUT /workflows/{WORKFLOW_ID}…")
    result = n8n_request("PUT", n8n_url, n8n_token, f"/workflows/{WORKFLOW_ID}", put_payload)
    print(f"  ✅ Updated. updatedAt={result.get('updatedAt')}, nodes={len(result.get('nodes', []))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
