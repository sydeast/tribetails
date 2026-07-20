"""Migrate Auntie OS — Update Profiles workflow from Baserow to Firestore.

Changes:
  Parse Trigger (Code):
    training_document URL: Baserow → Firebase Function getTrainingDoc

  Fetch Trigger Row (HTTP):
    Remove Baserow-specific Authorization + Host headers (keep x-auntie-key)

  Fetch Current Dossier, Fetch Kin, Fetch 411s:
    HTTP Request (Baserow) → Firestore getAll nodes

  Build Update Prompts (Code):
    Data access: .results arrays → .all().map(i => i.json)
    Field names: snake_case → camelCase (kinfolkId, kinId, name, rawSummary, etc.)

  Update Dossier in Baserow (Code) → renamed "Shape Dossier Patch":
    Output field names: snake_case → camelCase
    Return: { id: dossier_row_id, ...camelCase patch fields }
    (id is the Firestore upsert key)

  Patch Dossier (HTTP Baserow PATCH):
    → Firestore document upsert node (updateKey='id')

Prereq: deploy sotu-hosting/functions/index.js (getTrainingDoc added).

Run:
    N8N_URL=https://n8n.tribetails.com python3 patch_update_profiles_firestore.py [--dry-run]
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from baserow_auth import _load_env

WORKFLOW_ID = "lYa1YFtBIoTgA0t3"
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


PARSE_TRIGGER_JS = r"""
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

const url = trigger_source === 'generated_draft'
  ? `https://us-central1-auntieos-ttpc.cloudfunctions.net/getDraft?id=${row_id}`
  : `https://us-central1-auntieos-ttpc.cloudfunctions.net/getTrainingDoc?id=${row_id}`;

return [{ json: { trigger_source, row_id, kinfolk_id, url } }];
""".strip()

# Build Update Prompts — only the data-access preamble changes.
# The voice rules string (~8 KB) is preserved verbatim from the live node.
# We do targeted string replacements so we don't have to embed the full blob.
BUILD_UPDATE_PROMPTS_REPLACEMENTS = [
    # Data fetching block
    (
        "const dossierData = $('Fetch Current Dossier').first().json;\n"
        "const kinData = $('Fetch Kin').first().json;\n"
        "const four11Data = $('Fetch 411s').first().json;\n"
        "\n"
        "const dossier = (dossierData.results || [])[0] || {};\n"
        "const allKin = kinData.results || [];\n"
        "const allKinIds = new Set(allKin.map(k => k.id));\n"
        "const all411s = (four11Data.results || []).filter(k => allKinIds.has(k.kin_id));",

        "const dossierItems = $('Fetch Current Dossier').all().map(i => i.json);\n"
        "const kinItems = $('Fetch Kin').all().map(i => i.json);\n"
        "const four11Items = $('Fetch 411s').all().map(i => i.json);\n"
        "\n"
        "const dossier = dossierItems.find(d => d.kinfolkId === trigger.kinfolk_id) || {};\n"
        "const allKin = kinItems.filter(k => k.kinfolkId === trigger.kinfolk_id);\n"
        "const allKinIds = new Set(allKin.map(k => k.id));\n"
        "const all411s = four11Items.filter(k => allKinIds.has(k.kinId));",
    ),
    # content_type: also check camelCase communicationType (Firestore field)
    (
        "const content_type = triggerRow.communication_type || triggerRow.title || trigger.trigger_source;",
        "const content_type = triggerRow.communicationType || triggerRow.communication_type || triggerRow.title || trigger.trigger_source;",
    ),
    # dossier.display_name — Dossier has no displayName; fallback already there
    # kinUpdatePrompts: kin.id and kin.Name and f411 fields
    (
        "const kinUpdatePrompts = allKin.map(kin => {\n"
        "  const f411 = all411s.find(k => k.kin_id === kin.id) || {};\n"
        "  return {\n"
        "    kin_id: kin.id,\n"
        "    kin_name: kin.Name,\n"
        "    four11_row_id: f411.id,\n"
        "    prompt: `CURRENT 411 for ${kin.Name}:\n"
        "${f411.raw_summary || 'No existing summary.'}",

        "const kinUpdatePrompts = allKin.map(kin => {\n"
        "  const f411 = all411s.find(k => k.kinId === kin.id) || {};\n"
        "  return {\n"
        "    kin_id: kin.id,\n"
        "    kin_name: kin.name,\n"
        "    four11_row_id: f411.id,\n"
        "    prompt: `CURRENT 411 for ${kin.name}:\n"
        "${f411.rawSummary || 'No existing summary.'}",
    ),
]

SHAPE_DOSSIER_PATCH_JS = r"""
const claudeResp = $('Call Claude — Dossier').first().json;
const ctx = $('Build Update Prompts').first().json;

const text = (claudeResp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

function extract(label, raw, nextLabel) {
  const start = raw.indexOf(label + ':');
  if (start === -1) return null;
  const lineEnd = raw.indexOf('\n', start);
  const contentStart = lineEnd + 1;
  if (nextLabel) {
    const nextStart = raw.indexOf(nextLabel + ':', contentStart);
    return nextStart !== -1 ? raw.slice(contentStart, nextStart).trim() : raw.slice(contentStart).trim();
  }
  return raw.slice(contentStart).trim();
}

const communicationStyle      = extract('COMMUNICATION_STYLE', text, 'HOUSEHOLD_NOTES');
const householdNotes          = extract('HOUSEHOLD_NOTES', text, 'RELATIONSHIP_WITH_AUNTIE');
const relationshipWithAuntie  = extract('RELATIONSHIP_WITH_AUNTIE', text, 'IMPORTANT_LIFE_CONTEXT');
const importantLifeContext    = extract('IMPORTANT_LIFE_CONTEXT', text, 'RAW_SUMMARY');
const rawSummary              = extract('RAW_SUMMARY', text, null);
const lastReconciledAt        = new Date().toISOString();

if (!ctx.dossier_row_id) {
  return [{ json: { dossier_updated: false, reason: 'no dossier row found' } }];
}

// Output flat doc for Firestore upsert node (updateKey = 'id')
const patch = { id: ctx.dossier_row_id };
if (communicationStyle !== null)     patch.communicationStyle     = communicationStyle;
if (householdNotes !== null)         patch.householdNotes         = householdNotes;
if (relationshipWithAuntie !== null) patch.relationshipWithAuntie = relationshipWithAuntie;
if (importantLifeContext !== null)   patch.importantLifeContext   = importantLifeContext;
if (rawSummary !== null)             patch.rawSummary             = rawSummary;
patch.lastReconciledAt = lastReconciledAt;

return [{ json: patch }];
""".strip()

FIRESTORE_NODES = {
    "Fetch Current Dossier": "dossiers",
    "Fetch Kin":             "kin",
    "Fetch 411s":            "411",
}

PATCH_DOSSIER_FIRESTORE = {
    "type": "n8n-nodes-base.googleFirebaseCloudFirestore",
    "typeVersion": 1.1,
    "parameters": {
        "authentication": "serviceAccount",
        "resource": "document",
        "operation": "upsert",
        "projectId": PROJECT_ID,
        "collection": "dossiers",
        "updateKey": "id",
        "columns": "communicationStyle,householdNotes,relationshipWithAuntie,importantLifeContext,rawSummary,lastReconciledAt",
    },
    "credentials": FIRESTORE_CRED,
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

    # --- Parse Trigger: update training_document URL ---
    print("\nParse Trigger — update training_document URL:")
    if "Parse Trigger" in by_name:
        by_name["Parse Trigger"]["parameters"]["jsCode"] = PARSE_TRIGGER_JS
        print("  ✓ Baserow URL → Firebase Function getTrainingDoc")
    else:
        print("  ⚠  Parse Trigger not found")

    # --- Fetch Trigger Row: remove Baserow-specific headers ---
    print("\nFetch Trigger Row — strip Baserow headers:")
    if "Fetch Trigger Row" in by_name:
        node = by_name["Fetch Trigger Row"]
        params = node.get("parameters", {})
        header_params = params.get("headerParameters", {}).get("parameters", [])
        # Keep only x-auntie-key
        kept = [h for h in header_params if h.get("name", "").lower() == "x-auntie-key"]
        params.setdefault("headerParameters", {})["parameters"] = kept
        print(f"  ✓ Kept {len(kept)} header(s), removed Baserow Authorization + Host")
    else:
        print("  ⚠  Fetch Trigger Row not found")

    # --- Replace HTTP Baserow fetch nodes with Firestore getAll ---
    print("\nFirestore node replacements:")
    for node_name, collection in FIRESTORE_NODES.items():
        if node_name not in by_name:
            print(f"  ⚠  {node_name} not found — skipping")
            continue
        original = by_name[node_name]
        by_name[node_name] = firestore_getall(original, collection)
        print(f"  ✓ {node_name} → Firestore getAll '{collection}'")

    # --- Build Update Prompts: targeted string replacements ---
    print("\nBuild Update Prompts — field name patches:")
    if "Build Update Prompts" in by_name:
        code = by_name["Build Update Prompts"]["parameters"]["jsCode"]
        applied = 0
        for old, new in BUILD_UPDATE_PROMPTS_REPLACEMENTS:
            if old in code:
                code = code.replace(old, new, 1)
                applied += 1
            else:
                print(f"  ⚠  replacement pattern not found (already applied?): {old[:60]!r}…")
        by_name["Build Update Prompts"]["parameters"]["jsCode"] = code
        print(f"  ✓ {applied}/{len(BUILD_UPDATE_PROMPTS_REPLACEMENTS)} replacements applied")
    else:
        print("  ⚠  Build Update Prompts not found")

    # --- Update Dossier in Baserow → Shape Dossier Patch ---
    print("\nUpdate Dossier in Baserow → Shape Dossier Patch:")
    old_code_name = "Update Dossier in Baserow"
    new_code_name = "Shape Dossier Patch"
    if old_code_name in by_name:
        node = by_name.pop(old_code_name)
        node["name"] = new_code_name
        node["parameters"]["jsCode"] = SHAPE_DOSSIER_PATCH_JS
        by_name[new_code_name] = node
        print(f"  ✓ Renamed + updated field names to camelCase + Firestore upsert output")

        # Fix connections that referenced old name
        conns = wf.get("connections", {})
        if old_code_name in conns:
            conns[new_code_name] = conns.pop(old_code_name)
        # Fix any node that points TO old name
        for src_node, src_data in conns.items():
            for out_list in src_data.get("main", []):
                for edge in out_list:
                    if edge.get("node") == old_code_name:
                        edge["node"] = new_code_name
        print(f"  ✓ Connections updated")
    else:
        print(f"  ⚠  {old_code_name!r} not found")

    # --- Patch Dossier → Firestore upsert ---
    print("\nPatch Dossier → Firestore upsert:")
    if "Patch Dossier" in by_name:
        node = by_name["Patch Dossier"]
        node["type"] = PATCH_DOSSIER_FIRESTORE["type"]
        node["typeVersion"] = PATCH_DOSSIER_FIRESTORE["typeVersion"]
        node["parameters"] = PATCH_DOSSIER_FIRESTORE["parameters"]
        node["credentials"] = PATCH_DOSSIER_FIRESTORE["credentials"]
        # Remove HTTP-specific keys
        node.pop("continueOnFail", None)
        print(f"  ✓ Patch Dossier → Firestore document upsert (dossiers, updateKey=id)")
    else:
        print("  ⚠  Patch Dossier not found")

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
