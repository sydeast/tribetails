"""Gaps #24 + #25 — surgical patch for Auntie OS — Send Message workflow.

#25 Entry validator: insert `Validate Required Fields` (Code) + `Has Validation Error?` (IF) +
    `Respond Bad Request` (RespondToWebhook 400) between `Incoming Send Message` and
    `Route by Channel`.

#24 SMS branch silent-200 safety net: set `alwaysOutputData: true` on
    `Reverse Lookup Kinfolk by Phone` so an empty reverse-lookup result does not silently
    terminate the SMS branch — execution will still reach `Twilio SMS Send`, which fails on an
    empty `to` and routes to the existing `Respond SMS Error` 502 path. Combined with #25's
    `recipient_phone` requirement for channel=sms, the empty-`to` case is never reached in
    practice; this is the defensive safety net.

Run:
    N8N_URL=https://n8n.tribetails.com python3 patch_send_message_gap2425.py [--dry-run]
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

VALIDATOR_JS = """const body = ($json && $json.body) || {};
const channel = body.channel || '';
const messageBody = body.message_body || '';
const kinfolkId = body.kinfolk_id || '';
const recipientPhone = body.recipient_phone || '';
const recipientEmail = body.recipient_email || '';

function err(field, detail) {
  return [{ json: Object.assign({}, $json, { __validation_error: { field: field, detail: detail } }) }];
}

if (!channel) return err('channel', 'channel is required');
if (!messageBody) return err('message_body', 'message_body is required');
if (channel === 'sms' && !recipientPhone) return err('recipient_phone', 'recipient_phone is required for channel=sms');
if (channel === 'email' && !recipientEmail && !kinfolkId) return err('recipient_email|kinfolk_id', 'either recipient_email or kinfolk_id is required for channel=email');
if (channel === 'fcm' && !kinfolkId) return err('kinfolk_id', 'kinfolk_id is required for channel=fcm');

return [{ json: $json }];
"""

VALIDATOR_NODE_NAME = "Validate Required Fields"
VALIDATION_GATE_NODE_NAME = "Has Validation Error?"
BAD_REQUEST_NODE_NAME = "Respond Bad Request"


def _validator_node():
    return {
        "id": str(uuid.uuid4()),
        "name": VALIDATOR_NODE_NAME,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [16, 800],
        "parameters": {
            "jsCode": VALIDATOR_JS,
        },
    }


def _gate_node():
    return {
        "id": str(uuid.uuid4()),
        "name": VALIDATION_GATE_NODE_NAME,
        "type": "n8n-nodes-base.if",
        "typeVersion": 2.3,
        "position": [144, 800],
        "parameters": {
            "conditions": {
                "combinator": "and",
                "options": {
                    "caseSensitive": False,
                    "leftValue": "",
                    "typeValidation": "loose",
                    "version": 1,
                },
                "conditions": [
                    {
                        "leftValue": "={{ $json.__validation_error && $json.__validation_error.field }}",
                        "rightValue": "",
                        "operator": {"type": "string", "operation": "notEmpty"},
                    }
                ],
            },
            "options": {},
        },
    }


def _bad_request_node():
    return {
        "id": str(uuid.uuid4()),
        "name": BAD_REQUEST_NODE_NAME,
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.5,
        "position": [320, 720],
        "parameters": {
            "respondWith": "json",
            "responseBody": '={{ JSON.stringify({ error: "bad_request", field: $json.__validation_error.field, detail: $json.__validation_error.detail }) }}',
            "options": {"responseCode": 400},
        },
    }


def n8n_request(method: str, url: str, token: str, path: str, payload: dict | None = None) -> dict:
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
        body_txt = e.read().decode()
        raise RuntimeError(f"n8n API {method} {path} -> {e.code}: {body_txt}") from e


PUT_ALLOWED_KEYS = {"name", "nodes", "connections", "settings", "staticData"}
SETTINGS_ALLOWED_KEYS = {
    "saveExecutionProgress",
    "saveManualExecutions",
    "saveDataErrorExecution",
    "saveDataSuccessExecution",
    "executionTimeout",
    "errorWorkflow",
    "timezone",
    "executionOrder",
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
    snapshot_path = snapshot_dir / f"{WORKFLOW_ID}_pre_gap2425.json"
    snapshot_path.write_text(json.dumps(wf, indent=2))
    print(f"  snapshot saved: {snapshot_path}")

    by_name = {n["name"]: n for n in wf["nodes"]}

    # Idempotency: bail if validator already present.
    if VALIDATOR_NODE_NAME in by_name:
        print(f"  ⚠  '{VALIDATOR_NODE_NAME}' already exists — assuming Gap #25 already patched. Skipping node-add.")
    else:
        # Verify wiring assumption: Incoming Send Message currently goes directly to Route by Channel.
        incoming_targets = (
            wf.get("connections", {}).get("Incoming Send Message", {}).get("main", [])
        )
        flat = [t["node"] for branch in incoming_targets for t in branch]
        if flat != ["Route by Channel"]:
            print(
                f"ERROR: unexpected wiring — `Incoming Send Message` -> {flat}. Aborting to avoid graph corruption.",
                file=sys.stderr,
            )
            return 2

        # Insert new nodes.
        validator = _validator_node()
        gate = _gate_node()
        bad_req = _bad_request_node()
        wf["nodes"].extend([validator, gate, bad_req])

        # Rewire:
        #   Incoming Send Message -> Validate Required Fields
        #   Validate Required Fields -> Has Validation Error?
        #   Has Validation Error? (output 0 = true)  -> Respond Bad Request
        #   Has Validation Error? (output 1 = false) -> Route by Channel
        conns = wf.setdefault("connections", {})
        conns["Incoming Send Message"] = {
            "main": [[{"node": VALIDATOR_NODE_NAME, "type": "main", "index": 0}]]
        }
        conns[VALIDATOR_NODE_NAME] = {
            "main": [[{"node": VALIDATION_GATE_NODE_NAME, "type": "main", "index": 0}]]
        }
        conns[VALIDATION_GATE_NODE_NAME] = {
            "main": [
                [{"node": BAD_REQUEST_NODE_NAME, "type": "main", "index": 0}],
                [{"node": "Route by Channel", "type": "main", "index": 0}],
            ]
        }
        print("  ✚ added validator / gate / bad-request nodes and rewired entry chain")

    # Gap #24: alwaysOutputData on Reverse Lookup Kinfolk by Phone.
    rev = by_name.get("Reverse Lookup Kinfolk by Phone") or next(
        (n for n in wf["nodes"] if n.get("name") == "Reverse Lookup Kinfolk by Phone"),
        None,
    )
    if rev is None:
        print("ERROR: `Reverse Lookup Kinfolk by Phone` not found", file=sys.stderr)
        return 3
    prev = rev.get("alwaysOutputData", False)
    rev["alwaysOutputData"] = True
    print(f"  • Reverse Lookup Kinfolk by Phone: alwaysOutputData {prev} -> True")

    put_payload = {k: v for k, v in wf.items() if k in PUT_ALLOWED_KEYS}
    if "settings" in put_payload and isinstance(put_payload["settings"], dict):
        put_payload["settings"] = {
            k: v for k, v in put_payload["settings"].items() if k in SETTINGS_ALLOWED_KEYS
        }

    if dry_run:
        out = snapshot_dir / f"{WORKFLOW_ID}_post_gap2425_DRYRUN.json"
        out.write_text(json.dumps(put_payload, indent=2))
        print(f"\nDry run — preview at {out}")
        return 0

    print(f"\nPUT /workflows/{WORKFLOW_ID}…")
    result = n8n_request("PUT", n8n_url, n8n_token, f"/workflows/{WORKFLOW_ID}", put_payload)
    print(f"  ✅ Updated. updatedAt={result.get('updatedAt')}, nodes={len(result.get('nodes', []))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
