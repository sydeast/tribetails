"""Prospect Gate + Data-Integrity Gate — surgical patch for AuntieOS Send Message workflow.

Adds 11 nodes across all 4 channel branches (SMS, Email Direct, Email Kinfolk, FCM):

Per-branch (×4):
  - `Kinfolk Status Gate (<branch>)` — Code node, checks status + data integrity
  - `Gate Error? (<branch>)` — IF node: true → Route Gate Error, false → original next node

Shared:
  - `Route Gate Error` — IF: code==403 → Respond Prospect Forbidden, else → Respond Data Integrity Error
  - `Respond Prospect Forbidden` (HTTP 403) — prospect status blocked
  - `Respond Data Integrity Error` (HTTP 500) — active kinfolk missing required fields

Gate logic (identical JS for all 4 Code nodes):
  - $json.status empty (kinfolk not found, alwaysOutputData passed empty doc) → pass through
  - status == "prospect" → 403 prospect_forbidden
  - status == "active" AND (no email OR no phoneNumber) → 500 data_integrity_failure
  - all other statuses (active with data, inactive, archived) → pass through

Wiring changes (main outputs only; error outputs preserved verbatim):
  Reverse Lookup Kinfolk by Phone  main  was→ Twilio SMS Send
                                         now→ Kinfolk Status Gate (SMS)
  Reverse Lookup Kinfolk by Email  main  was→ Normalize Email Recipient (Direct)
                                         now→ Kinfolk Status Gate (Email Direct)
  Forward Lookup Kinfolk for Email main  was→ Kinfolk Email Exists?
                                         now→ Kinfolk Status Gate (Email Kinfolk)
  Resolve Kinfolk UID              main  was→ Kinfolk Has UID?
                                         now→ Kinfolk Status Gate (FCM)

Run:
    N8N_URL=https://n8n.tribetails.com python3 patch_send_message_gates.py [--dry-run]
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from baserow_auth import _load_env

WORKFLOW_ID = "PqlFQHKjoB04rRN2"

GATE_JS = """const status = ($json.status || "").toLowerCase();
const kinfolkId = $json.id || null;

if (!status) return [{ json: $json }];

if (status === "prospect") {
  return [{ json: Object.assign({}, $json, {
    __gate_error: { code: 403, error: "prospect_forbidden", kinfolk_status: $json.status, kinfolk_id: kinfolkId }
  })}];
}

if (status === "active") {
  const missing = [];
  if (!$json.email) missing.push("email");
  if (!$json.phoneNumber) missing.push("phoneNumber");
  if (missing.length) {
    return [{ json: Object.assign({}, $json, {
      __gate_error: { code: 500, error: "data_integrity_failure", kinfolk_id: kinfolkId, missing_fields: missing }
    })}];
  }
}

return [{ json: $json }];
"""

GATE_IF_CONDITION = {
    "combinator": "and",
    "options": {"caseSensitive": False, "leftValue": "", "typeValidation": "loose", "version": 1},
    "conditions": [{
        "leftValue": "={{ $json.__gate_error && $json.__gate_error.code }}",
        "rightValue": "",
        "operator": {"type": "string", "operation": "notEmpty"},
    }],
}

# Route Gate Error IF: checks if gate_error.code == 403
ROUTE_IF_CONDITION = {
    "combinator": "and",
    "options": {"caseSensitive": False, "leftValue": "", "typeValidation": "loose", "version": 1},
    "conditions": [{
        "leftValue": "={{ $json.__gate_error.code }}",
        "rightValue": 403,
        "operator": {"type": "number", "operation": "equals"},
    }],
}

PUT_ALLOWED_KEYS = {"name", "nodes", "connections", "settings", "staticData"}
SETTINGS_ALLOWED_KEYS = {
    "saveExecutionProgress", "saveManualExecutions", "saveDataErrorExecution",
    "saveDataSuccessExecution", "executionTimeout", "errorWorkflow", "timezone", "executionOrder",
}


def _node(name, ntype, type_version, position, params, **extra):
    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "type": ntype,
        "typeVersion": type_version,
        "position": position,
        **extra,
        "parameters": params,
    }


def _gate_code(branch, pos):
    return _node(
        f"Kinfolk Status Gate ({branch})",
        "n8n-nodes-base.code", 2, pos,
        {"jsCode": GATE_JS},
    )


def _gate_if(branch, pos):
    return _node(
        f"Gate Error? ({branch})",
        "n8n-nodes-base.if", 2.3, pos,
        {"conditions": GATE_IF_CONDITION, "options": {}},
    )


def _route_gate_if(pos):
    return _node(
        "Route Gate Error",
        "n8n-nodes-base.if", 2.3, pos,
        {"conditions": ROUTE_IF_CONDITION, "options": {}},
    )


def _respond_prospect(pos):
    return _node(
        "Respond Prospect Forbidden",
        "n8n-nodes-base.respondToWebhook", 1.5, pos,
        {
            "respondWith": "json",
            "responseBody": '={{ JSON.stringify({ error: $json.__gate_error.error, kinfolk_id: ($json.__gate_error.kinfolk_id || "unknown"), kinfolk_status: ($json.__gate_error.kinfolk_status || "prospect") }) }}',
            "options": {"responseCode": 403},
        },
    )


def _respond_integrity(pos):
    return _node(
        "Respond Data Integrity Error",
        "n8n-nodes-base.respondToWebhook", 1.5, pos,
        {
            "respondWith": "json",
            "responseBody": '={{ JSON.stringify({ error: $json.__gate_error.error, kinfolk_id: ($json.__gate_error.kinfolk_id || "unknown"), missing_fields: ($json.__gate_error.missing_fields || []) }) }}',
            "options": {"responseCode": 500},
        },
    )


def main_conn(target):
    return {"node": target, "type": "main", "index": 0}


def n8n_request(method, url, token, path, payload=None):
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
    snapshot_path = snapshot_dir / f"{WORKFLOW_ID}_pre_gates.json"
    snapshot_path.write_text(json.dumps(wf, indent=2))
    print(f"  snapshot saved: {snapshot_path}")

    by_name = {n["name"]: n for n in wf["nodes"]}

    # Idempotency: bail if gates already present.
    if "Kinfolk Status Gate (SMS)" in by_name:
        print("  ⚠ 'Kinfolk Status Gate (SMS)' already exists — gates already patched. Aborting.")
        return 0

    # Verify expected wiring before mutating.
    def get_main_targets(src):
        branches = wf.get("connections", {}).get(src, {}).get("main", [])
        return [t["node"] for b in branches for t in b]

    checks = [
        ("Reverse Lookup Kinfolk by Phone", ["Twilio SMS Send"]),
        ("Reverse Lookup Kinfolk by Email", ["Normalize Email Recipient (Direct)"]),
        ("Forward Lookup Kinfolk for Email", ["Kinfolk Email Exists?"]),
        ("Resolve Kinfolk UID", ["Kinfolk Has UID?"]),
    ]
    for src, expected in checks:
        actual = get_main_targets(src)
        if actual != expected:
            print(f"ERROR: unexpected wiring — '{src}' main -> {actual} (expected {expected})", file=sys.stderr)
            return 2

    # Also verify Kinfolk Email Exists? and Kinfolk Has UID? wiring.
    if get_main_targets("Kinfolk Email Exists?") != ["Normalize Email Recipient (Kinfolk)", "Respond Email Lookup Error"]:
        print(f"ERROR: unexpected wiring for 'Kinfolk Email Exists?': {get_main_targets('Kinfolk Email Exists?')}", file=sys.stderr)
        return 2
    if get_main_targets("Kinfolk Has UID?") != ["Lookup FCM Token", "Shape FCM No UID Log"]:
        print(f"ERROR: unexpected wiring for 'Kinfolk Has UID?': {get_main_targets('Kinfolk Has UID?')}", file=sys.stderr)
        return 2

    # Build new nodes.
    # Positions: arbitrary canvas coords grouped near each branch.
    sms_code  = _gate_code("SMS",         [300, 200])
    sms_if    = _gate_if  ("SMS",         [500, 200])
    ed_code   = _gate_code("Email Direct",[300, 400])
    ed_if     = _gate_if  ("Email Direct",[500, 400])
    ek_code   = _gate_code("Email Kinfolk",[300, 600])
    ek_if     = _gate_if  ("Email Kinfolk",[500, 600])
    fcm_code  = _gate_code("FCM",         [300, 800])
    fcm_if    = _gate_if  ("FCM",         [500, 800])
    route_if  = _route_gate_if(           [700, 500])
    resp_403  = _respond_prospect(        [900, 420])
    resp_500  = _respond_integrity(       [900, 580])

    new_nodes = [sms_code, sms_if, ed_code, ed_if, ek_code, ek_if, fcm_code, fcm_if, route_if, resp_403, resp_500]
    wf["nodes"].extend(new_nodes)

    n = lambda node: node["name"]

    conns = wf.setdefault("connections", {})

    # Helper: get existing error connections for a source node.
    def get_error_conns(src):
        return wf.get("connections", {}).get(src, {}).get("error", [])

    # --- SMS branch ---
    # Reverse Lookup Kinfolk by Phone: main → Gate (was → Twilio SMS Send)
    conns["Reverse Lookup Kinfolk by Phone"] = {
        "main": [[main_conn(n(sms_code))]],
        "error": get_error_conns("Reverse Lookup Kinfolk by Phone"),  # none, but preserve
    }
    conns[n(sms_code)] = {"main": [[main_conn(n(sms_if))]]}
    conns[n(sms_if)] = {
        "main": [
            [main_conn(n(route_if))],       # output 0 (true)  → Route Gate Error
            [main_conn("Twilio SMS Send")],  # output 1 (false) → original next
        ]
    }

    # --- Email Direct branch ---
    conns["Reverse Lookup Kinfolk by Email"] = {
        "main": [[main_conn(n(ed_code))]],
    }
    conns[n(ed_code)] = {"main": [[main_conn(n(ed_if))]]}
    conns[n(ed_if)] = {
        "main": [
            [main_conn(n(route_if))],
            [main_conn("Normalize Email Recipient (Direct)")],
        ]
    }

    # --- Email Kinfolk branch ---
    # Forward Lookup Kinfolk for Email: main → Gate (error → Respond Email Lookup Error unchanged)
    conns["Forward Lookup Kinfolk for Email"] = {
        "main": [[main_conn(n(ek_code))]],
        "error": get_error_conns("Forward Lookup Kinfolk for Email"),
    }
    conns[n(ek_code)] = {"main": [[main_conn(n(ek_if))]]}
    conns[n(ek_if)] = {
        "main": [
            [main_conn(n(route_if))],
            [main_conn("Kinfolk Email Exists?")],
        ]
    }

    # --- FCM branch ---
    # Resolve Kinfolk UID: main → Gate (error → Shape FCM Token Lookup Failure Log unchanged)
    conns["Resolve Kinfolk UID"] = {
        "main": [[main_conn(n(fcm_code))]],
        "error": get_error_conns("Resolve Kinfolk UID"),
    }
    conns[n(fcm_code)] = {"main": [[main_conn(n(fcm_if))]]}
    conns[n(fcm_if)] = {
        "main": [
            [main_conn(n(route_if))],
            [main_conn("Kinfolk Has UID?")],
        ]
    }

    # --- Shared route + respond nodes ---
    conns[n(route_if)] = {
        "main": [
            [main_conn(n(resp_403))],  # output 0 (true = code==403) → 403
            [main_conn(n(resp_500))],  # output 1 (false) → 500
        ]
    }
    # resp_403 and resp_500 are terminal (RespondToWebhook) — no outgoing connections.

    print(f"\n  ✚ {len(new_nodes)} nodes added:")
    for node in new_nodes:
        print(f"    {node['name']}")

    # Strip read-only fields before PUT.
    put_payload = {k: v for k, v in wf.items() if k in PUT_ALLOWED_KEYS}
    if "settings" in put_payload and isinstance(put_payload["settings"], dict):
        put_payload["settings"] = {
            k: v for k, v in put_payload["settings"].items() if k in SETTINGS_ALLOWED_KEYS
        }

    if dry_run:
        out = snapshot_dir / f"{WORKFLOW_ID}_post_gates_DRYRUN.json"
        out.write_text(json.dumps(put_payload, indent=2))
        print(f"\nDry run — preview at {out}")
        return 0

    print(f"\nPUT /workflows/{WORKFLOW_ID}…")
    result = n8n_request("PUT", n8n_url, n8n_token, f"/workflows/{WORKFLOW_ID}", put_payload)
    print(f"  ✅ Updated. updatedAt={result.get('updatedAt')}, nodes={len(result.get('nodes', []))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
