"""Gap #26 — surgical patch for Auntie OS — Send Message workflow.

Root cause: `Log SMS Outbound Success` and `Log SMS Outbound Failure` (Firestore
write nodes) have `continueOnFail=False` (default). When the reverse-lookup by
phone returns 0 results (unknown phone number), `kinfolkId` is null in the log
document. If the Firestore write rejects the null field or fails for any other
reason, the branch terminates silently — `Respond SMS OK` / `Respond SMS Error`
never fire — n8n returns the default HTTP 200 empty body.

Fix: set `continueOnFail: true` on both Firestore logging nodes so logging
failure is best-effort and never blocks the response node.

Run:
    N8N_URL=https://n8n.tribetails.com python3 patch_send_message_gap26.py [--dry-run]
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

TARGETS = ["Log SMS Outbound Success", "Log SMS Outbound Failure"]

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
    snapshot_path = snapshot_dir / f"{WORKFLOW_ID}_pre_gap26.json"
    snapshot_path.write_text(json.dumps(wf, indent=2))
    print(f"  snapshot saved: {snapshot_path}")

    by_name = {n["name"]: n for n in wf["nodes"]}
    missing = [t for t in TARGETS if t not in by_name]
    if missing:
        print(f"ERROR: targets not found: {missing}", file=sys.stderr)
        return 2

    print("\nApplying patches:")
    for name in TARGETS:
        node = by_name[name]
        prev = node.get("continueOnFail", False)
        node["continueOnFail"] = True
        print(f"  • {name}: continueOnFail {prev} -> True")

    put_payload = {k: v for k, v in wf.items() if k in PUT_ALLOWED_KEYS}
    if "settings" in put_payload and isinstance(put_payload["settings"], dict):
        put_payload["settings"] = {
            k: v for k, v in put_payload["settings"].items() if k in SETTINGS_ALLOWED_KEYS
        }

    if dry_run:
        out = snapshot_dir / f"{WORKFLOW_ID}_post_gap26_DRYRUN.json"
        out.write_text(json.dumps(put_payload, indent=2))
        print(f"\nDry run — preview at {out}")
        return 0

    print(f"\nPUT /workflows/{WORKFLOW_ID}…")
    result = n8n_request("PUT", n8n_url, n8n_token, f"/workflows/{WORKFLOW_ID}", put_payload)
    print(f"  ✅ Updated. updatedAt={result.get('updatedAt')}, nodes={len(result.get('nodes', []))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
