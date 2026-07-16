"""Gap #22 — surgical patch for Auntie OS — Send Message workflow.

Reclassifies HTTP status codes + restructures error response bodies on the
existing Respond-to-Webhook nodes per the Section 2 contract from the design
brainstorm.

Strategy: GET the live workflow JSON via the n8n public API, modify only the
`responseCode` and `responseBody` on the targeted Respond nodes, and PUT the
full workflow back. No node graph changes — connections, credentials, and all
non-Respond nodes are preserved verbatim.

Run:
    python3 patch_send_message_gap22.py [--dry-run]

Reads N8N_URL + N8N_TOKEN from .env via baserow_auth._load_env.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from baserow_auth import _load_env

WORKFLOW_ID = "PqlFQHKjoB04rRN2"

# Each entry: respond-node name -> (new_status, new_response_body_expression)
KINFOLK_ID_EXPR = '($("Incoming Send Message").item.json.body.kinfolk_id || "missing")'

PATCHES: dict[str, tuple[int, str]] = {
    "Respond Unknown Channel": (
        422,
        '={{ JSON.stringify({ error: "unknown_channel", channel: ($json.body.channel || "missing"), allowed: ["sms","email","fcm"] }) }}',
    ),
    "Respond Email Lookup Error": (
        404,
        '={{ JSON.stringify({ error: "kinfolk_not_found", kinfolk_id: ' + KINFOLK_ID_EXPR + ' }) }}',
    ),
    "Respond Kinfolk Lookup Error (FCM)": (
        404,
        '={{ JSON.stringify({ error: "kinfolk_not_found", kinfolk_id: ' + KINFOLK_ID_EXPR + ' }) }}',
    ),
    "Respond FCM No UID": (
        422,
        '={{ JSON.stringify({ error: "channel_unavailable", channel: "fcm", kinfolk_id: ' + KINFOLK_ID_EXPR + ', reason: "mytribe_not_installed", available_channels: ["sms","email"] }) }}',
    ),
    "Respond FCM Token Lookup Error": (
        422,
        '={{ JSON.stringify({ error: "channel_unavailable", channel: "fcm", kinfolk_id: ' + KINFOLK_ID_EXPR + ', reason: "no_fcm_token", available_channels: ["sms","email"] }) }}',
    ),
    "Respond SMS Error": (
        502,
        '={{ JSON.stringify({ error: "upstream_provider_failure", provider: "twilio", provider_error: ($("Shape SMS Failure Log").item.json.errorMessage || "unknown"), kinfolk_id: ' + KINFOLK_ID_EXPR + ' }) }}',
    ),
    "Respond Email Send Error": (
        502,
        '={{ JSON.stringify({ error: "upstream_provider_failure", provider: "sendgrid", provider_error: ($("Shape Email Failure Log").item.json.errorMessage || "unknown"), kinfolk_id: ' + KINFOLK_ID_EXPR + ' }) }}',
    ),
    "Respond FCM Send Error": (
        502,
        '={{ JSON.stringify({ error: "upstream_provider_failure", provider: "fcm", provider_error: ($("Shape FCM Send Failure Log").item.json.errorMessage || "unknown"), kinfolk_id: ' + KINFOLK_ID_EXPR + ' }) }}',
    ),
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
            # Cloudflare in front of n8n.tribetails.com bans the default Python-urllib UA.
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


# n8n PUT /workflows/{id} only accepts these top-level fields (others are read-only).
# Keys not in this allowlist are stripped before PUT.
PUT_ALLOWED_KEYS = {"name", "nodes", "connections", "settings", "staticData"}

# n8n public API rejects unknown settings keys (e.g. availableInMCP, binaryMode).
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
    # Shell env overrides .env so callers can target a different host without mutating .env.
    n8n_url = (os.environ.get("N8N_URL") or env.get("N8N_URL", "")).rstrip("/")
    n8n_token = os.environ.get("N8N_TOKEN") or env.get("N8N_TOKEN", "")
    if not n8n_url or not n8n_token:
        print("ERROR: N8N_URL or N8N_TOKEN missing in .env", file=sys.stderr)
        return 1

    print(f"Fetching workflow {WORKFLOW_ID} from {n8n_url}…")
    wf = n8n_request("GET", n8n_url, n8n_token, f"/workflows/{WORKFLOW_ID}")
    print(f"  name: {wf.get('name')}")
    print(f"  nodes: {len(wf.get('nodes', []))}")
    print(f"  active: {wf.get('active')}")

    # Snapshot before mutating.
    snapshot_dir = Path(__file__).parent / "_workflow_snapshots"
    snapshot_dir.mkdir(exist_ok=True)
    snapshot_path = snapshot_dir / f"{WORKFLOW_ID}_pre_gap22.json"
    snapshot_path.write_text(json.dumps(wf, indent=2))
    print(f"  snapshot saved: {snapshot_path}")

    # Apply patches in place.
    by_name = {n["name"]: n for n in wf["nodes"]}
    missing = [name for name in PATCHES if name not in by_name]
    if missing:
        print(f"ERROR: patch targets not found in workflow: {missing}", file=sys.stderr)
        return 2

    print("\nApplying patches:")
    for name, (new_code, new_body) in PATCHES.items():
        node = by_name[name]
        params = node.setdefault("parameters", {})
        opts = params.setdefault("options", {})
        old_code = opts.get("responseCode")
        old_body = params.get("responseBody", "")
        opts["responseCode"] = new_code
        params["responseBody"] = new_body
        print(f"  • {name}: {old_code} -> {new_code}")

    # Strip read-only fields before PUT.
    put_payload = {k: v for k, v in wf.items() if k in PUT_ALLOWED_KEYS}
    if "settings" in put_payload and isinstance(put_payload["settings"], dict):
        put_payload["settings"] = {
            k: v for k, v in put_payload["settings"].items() if k in SETTINGS_ALLOWED_KEYS
        }

    if dry_run:
        out_path = Path(__file__).parent / "_workflow_snapshots" / f"{WORKFLOW_ID}_post_gap22_DRYRUN.json"
        out_path.write_text(json.dumps(put_payload, indent=2))
        print(f"\nDry run — would PUT {len(put_payload)} top-level keys.")
        print(f"Preview written to: {out_path}")
        return 0

    print(f"\nPUT /workflows/{WORKFLOW_ID} with {len(put_payload)} top-level keys…")
    result = n8n_request("PUT", n8n_url, n8n_token, f"/workflows/{WORKFLOW_ID}", put_payload)
    print(f"  ✅ Updated. updatedAt={result.get('updatedAt')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
