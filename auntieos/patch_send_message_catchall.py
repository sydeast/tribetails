"""Catch-all error handler — surgical patch for AuntieOS Send Message workflow.

Two parts:

Part A — Fix remaining Firestore logging nodes (continueOnFail=False):
  Log Email Outbound Success, Log Email Outbound Failure,
  Log FCM Outbound Success, Log FCM No UID Failure,
  Log FCM Token Lookup Failure, Log FCM Send Failure

Part B — Create error workflow "AuntieOS — Send Message Error Handler":
  Error Trigger → Shape Error Log (Set) → Log Workflow Error (Firestore)
  Writes to `workflow_errors` collection on any uncaught n8n crash.

Part C — Link error workflow in main workflow settings.errorWorkflow.

Note: the error workflow logs failures but cannot retroactively respond to the
original HTTP caller — n8n closes the webhook connection on uncaught crash. The
log provides visibility into infra failures for manual investigation.

Run:
    N8N_URL=https://n8n.tribetails.com python3 patch_send_message_catchall.py [--dry-run]
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
FIRESTORE_CRED = {"googleApi": {"id": "twUKBanMejv0zvkG", "name": "Google Service Account account"}}

COF_TARGETS = [
    "Log Email Outbound Success",
    "Log Email Outbound Failure",
    "Log FCM Outbound Success",
    "Log FCM No UID Failure",
    "Log FCM Token Lookup Failure",
    "Log FCM Send Failure",
]

ERROR_WORKFLOW_NAME = "AuntieOS — Send Message Error Handler"

ERROR_LOG_JS = "={{ JSON.stringify({ workflowId: $json.workflow.id, workflowName: $json.workflow.name, executionId: $json.execution.id, errorMessage: ($json.error && $json.error.message) || \"unknown\", errorNode: ($json.error && $json.error.node && $json.error.node.name) || \"unknown\", errorStack: ($json.error && $json.error.stack) || \"\", timestamp: $now.toISO() }) }}"

PUT_ALLOWED_KEYS = {"name", "nodes", "connections", "settings", "staticData"}
SETTINGS_ALLOWED_KEYS = {
    "saveExecutionProgress", "saveManualExecutions", "saveDataErrorExecution",
    "saveDataSuccessExecution", "executionTimeout", "errorWorkflow", "timezone", "executionOrder",
}


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


def _build_error_workflow():
    trigger_id = str(uuid.uuid4())
    shape_id    = str(uuid.uuid4())
    log_id      = str(uuid.uuid4())

    trigger = {
        "id": trigger_id,
        "name": "On Workflow Error",
        "type": "n8n-nodes-base.errorTrigger",
        "typeVersion": 1,
        "position": [0, 300],
        "parameters": {},
    }
    shape = {
        "id": shape_id,
        "name": "Shape Error Log",
        "type": "n8n-nodes-base.set",
        "typeVersion": 3.4,
        "position": [220, 300],
        "parameters": {
            "mode": "raw",
            "jsonOutput": ERROR_LOG_JS,
            "options": {},
        },
    }
    log = {
        "id": log_id,
        "name": "Log Workflow Error",
        "type": "n8n-nodes-base.googleFirebaseCloudFirestore",
        "typeVersion": 1.1,
        "position": [440, 300],
        "continueOnFail": True,
        "parameters": {
            "authentication": "serviceAccount",
            "operation": "create",
            "projectId": "auntieos-ttpc",
            "collection": "workflow_errors",
            "columns": "workflowId,workflowName,executionId,errorMessage,errorNode,errorStack,timestamp",
        },
        "credentials": FIRESTORE_CRED,
    }

    return {
        "name": ERROR_WORKFLOW_NAME,
        "nodes": [trigger, shape, log],
        "connections": {
            "On Workflow Error": {
                "main": [[{"node": "Shape Error Log", "type": "main", "index": 0}]]
            },
            "Shape Error Log": {
                "main": [[{"node": "Log Workflow Error", "type": "main", "index": 0}]]
            },
        },
        "settings": {"executionOrder": "v1"},
        "staticData": None,
    }


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    env = _load_env()
    n8n_url = (os.environ.get("N8N_URL") or env.get("N8N_URL", "")).rstrip("/")
    n8n_token = os.environ.get("N8N_TOKEN") or env.get("N8N_TOKEN", "")
    if not n8n_url or not n8n_token:
        print("ERROR: N8N_URL or N8N_TOKEN missing", file=sys.stderr)
        return 1

    # --- Fetch main workflow ---
    print(f"Fetching workflow {WORKFLOW_ID} from {n8n_url}…")
    wf = n8n_request("GET", n8n_url, n8n_token, f"/workflows/{WORKFLOW_ID}")
    print(f"  name: {wf.get('name')}, nodes: {len(wf.get('nodes', []))}")

    snapshot_dir = Path(__file__).parent / "_workflow_snapshots"
    snapshot_dir.mkdir(exist_ok=True)
    snapshot_path = snapshot_dir / f"{WORKFLOW_ID}_pre_catchall.json"
    snapshot_path.write_text(json.dumps(wf, indent=2))
    print(f"  snapshot saved: {snapshot_path}")

    # --- Part A: fix continueOnFail on remaining logging nodes ---
    by_name = {n["name"]: n for n in wf["nodes"]}
    missing = [t for t in COF_TARGETS if t not in by_name]
    if missing:
        print(f"ERROR: COF targets not found: {missing}", file=sys.stderr)
        return 2

    print("\nPart A — continueOnFail:")
    for name in COF_TARGETS:
        node = by_name[name]
        prev = node.get("continueOnFail", False)
        node["continueOnFail"] = True
        print(f"  • {name}: {prev} -> True")

    # --- Part B: create / find error workflow ---
    # Check if already exists.
    existing_workflows = n8n_request("GET", n8n_url, n8n_token, "/workflows?limit=100")
    existing = next(
        (w for w in existing_workflows.get("data", []) if w.get("name") == ERROR_WORKFLOW_NAME),
        None,
    )

    if existing:
        error_wf_id = existing["id"]
        print(f"\nPart B — error workflow exists (id={error_wf_id}), updating nodes…")
        if not dry_run:
            error_wf_payload = _build_error_workflow()
            n8n_request("PUT", n8n_url, n8n_token, f"/workflows/{error_wf_id}", error_wf_payload)
            n8n_request("POST", n8n_url, n8n_token, f"/workflows/{error_wf_id}/activate")
            print(f"  updated + activated")
    elif dry_run:
        error_wf_id = "<DRY-RUN-ID>"
        print(f"\nPart B — dry run: would create '{ERROR_WORKFLOW_NAME}'")
    else:
        error_wf_payload = _build_error_workflow()
        created = n8n_request("POST", n8n_url, n8n_token, "/workflows", error_wf_payload)
        error_wf_id = created["id"]
        print(f"\nPart B — created error workflow: id={error_wf_id}")
        # Activate it so n8n can trigger it.
        n8n_request("POST", n8n_url, n8n_token, f"/workflows/{error_wf_id}/activate")
        print(f"  activated")

    # --- Part C: link error workflow in main workflow settings ---
    current_error_wf = wf.get("settings", {}).get("errorWorkflow")
    if current_error_wf == error_wf_id:
        print(f"\nPart C — settings.errorWorkflow already = {error_wf_id}")
    else:
        wf.setdefault("settings", {})["errorWorkflow"] = error_wf_id
        print(f"\nPart C — settings.errorWorkflow: {current_error_wf!r} -> {error_wf_id!r}")

    # --- PUT main workflow ---
    put_payload = {k: v for k, v in wf.items() if k in PUT_ALLOWED_KEYS}
    if "settings" in put_payload and isinstance(put_payload["settings"], dict):
        put_payload["settings"] = {
            k: v for k, v in put_payload["settings"].items() if k in SETTINGS_ALLOWED_KEYS
        }

    if dry_run:
        out = snapshot_dir / f"{WORKFLOW_ID}_post_catchall_DRYRUN.json"
        out.write_text(json.dumps(put_payload, indent=2))
        print(f"\nDry run — preview at {out}")
        return 0

    print(f"\nPUT /workflows/{WORKFLOW_ID}…")
    result = n8n_request("PUT", n8n_url, n8n_token, f"/workflows/{WORKFLOW_ID}", put_payload)
    print(f"  ✅ Updated. updatedAt={result.get('updatedAt')}, nodes={len(result.get('nodes', []))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
