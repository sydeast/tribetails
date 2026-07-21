"""Swap the Auntie OS - Generate (n8n workflow SIg2KsWn0oyRkSzR) voice source.

Replaces the old auntie_voice_rules.md text inlined in the "Call Claude" node's
`system` field with the consolidated Voice Bible + Channel Playbook + exemplars
(read from voice/), and de-weights the "Build Prompt (Known)" visit-log "tone
anchors" (5 -> 1, factual-continuity-only, explicit do-not-imitate). This is the
n8n half of Scope A; the Firebase Function `generate` is the primary path.

This module is import-safe and the transform is pure, so it can run against the
in-repo snapshot (version-controlled proof) or live n8n (when the local server
is up). Auth mirrors patch_generate_firestore.py (X-N8N-API-KEY, /api/v1).

Run:
    # transform the version-controlled snapshot (dry-run prints a summary):
    python3 patch_generate_voice.py --snapshot
    python3 patch_generate_voice.py --snapshot --apply

    # patch live n8n (needs the Debian server up + N8N_URL/N8N_TOKEN in .env):
    N8N_URL=https://n8n.tribetails.com python3 patch_generate_voice.py --live --apply
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate  # reuse the single source of truth for the voice  # noqa: E402
from baserow_auth import _load_env  # noqa: E402

WORKFLOW_ID = "SIg2KsWn0oyRkSzR"
_SNAP_DIR = Path(__file__).resolve().parent / "_workflow_snapshots"
SNAPSHOT_PATH = _SNAP_DIR / f"{WORKFLOW_ID}_pre_firestore.json"      # read-only historical capture
SNAPSHOT_OUT = _SNAP_DIR / f"{WORKFLOW_ID}_voice_swapped.json"      # transformed artifact we write

# n8n is multi-channel (sms/email/visit_report/social_post/blog_post/general),
# so its framing keeps the channel adaptation + Kin/Kinfolk vocabulary that the
# KinTale-focused generate.py framing does not. The OPENER RULE matches Voice
# Bible §0 / §11.8 and replaces the v1 "start with the arrival energy" default.
N8N_FRAMING = (
    "You are Auntie. You write communications for Tribe Tails Pet Care in Auntie's authentic voice.\n\n"
    "HARD RULES:\n"
    "- Output ONLY the communication itself. No preamble, no 'here is your message', no meta-commentary.\n"
    "- No em dashes. No en dashes. Ever. Use ellipses (.....), commas, or parentheses.\n"
    "- First person, contractions always. Never corporate. No generic filler.\n"
    "- Pets are always 'Kin', never 'pet' or 'animal'. Clients are always 'Kinfolk', never 'client', 'customer', or 'owner'.\n"
    "- Specific moments over vague summaries.\n"
    "- Sparse emoji: a single warmth-stamp at most, never scattered.\n"
    "- Tone and length adapt to communication_type:\n"
    "  - sms: conversational, 2 to 4 sentences max\n"
    "  - email: warm opener, full body, closing\n"
    "  - visit_report: one flowing paragraph narrative (Auntie's KinTale format)\n"
    "  - social_post: punchy brand voice, emoji sparingly\n"
    "  - blog_post: longer storytelling, multiple paragraphs ok\n"
    "  - general: match the tone_hint if provided\n\n"
    "OPENER RULE (the single most important correction, read it twice):\n"
    "- Do NOT default to an interjection opener. \"Well\", \"Welllll\", \"Ooooweee\", \"Guuuurrlll\", "
    "\"Howdy\", \"Goodness gracious\" are NOT the default first word. In Auntie's real writing only "
    "about 1% of pieces open with \"Well.\"\n"
    "- Vary the opening every single time. Never repeat the previous piece's opener.\n"
    "- Open from the specific moment: the Kin's name, the first real thing that actually happened, "
    "\"I...\", \"The...\", \"What a...\". Not a stock sound.\n"
    "- Reserve an interjection opener for a genuinely surprising or delightful beat, about 1 in 10 at most.\n"
    "- Vary the GRAMMATICAL opener too, not just avoid interjections. Do NOT default to starting with "
    "\"I\". Rotate naturally among: the Kin's name first, \"The...\", \"What a...\", \"We...\", the time or "
    "weather, a sound or the first action, \"It...\", \"Oh...\". Across several pieces the opening words "
    "should look varied, never a column of \"I\".\n"
    "- The exemplars below are for studying rhythm, structure, specificity, and warmth. Do not copy "
    "their openings or sentences. Note the first gold exemplar opens with \"Well!!!!\"; that is exactly "
    "the tic to avoid, not a template to follow.\n"
)


def build_n8n_system() -> str:
    """The new system prompt: channel framing + Voice Bible + Playbook + exemplars."""
    return N8N_FRAMING + "\n" + generate._load_voice_source()


# Matches the `system: "<JSON string literal>"` segment of the Call Claude
# jsonBody expression. The alternation is linear (no catastrophic backtracking).
_SYSTEM_RE = re.compile(r'system:\s*"(?:\\.|[^"\\])*"')


def extract_system_text(node: dict) -> str:
    """Decode the current Call Claude `system` JSON string literal to plain text."""
    body = node.get("parameters", {}).get("jsonBody", "")
    m = _SYSTEM_RE.search(body)
    if not m:
        return ""
    literal = m.group(0)[len("system:"):].strip()
    return json.loads(literal)


def _transform_call_claude(node: dict, new_system: str, summary: list) -> None:
    body = node.get("parameters", {}).get("jsonBody", "")
    replacement = "system: " + json.dumps(new_system)  # JSON string == valid JS string literal
    new_body, n = _SYSTEM_RE.subn(lambda _m: replacement, body, count=1)
    node["parameters"]["jsonBody"] = new_body
    summary.append(("Call Claude: system prompt swapped to Voice Bible", n))


# (old_substring, new_substring) edits to the Build Prompt (Known) jsCode.
# `—` is the literal em-dash char in the JS source; `\\n` is backslash+n.
_BUILD_EDITS = [
    ("slice(0, 5)", "slice(0, 1)"),
    (
        "// Last 5 visit logs for tone anchoring",
        "// Most recent visit only, for factual continuity (de-weighted; NOT a tone/style anchor)",
    ),
    (
        "'RECENT VISIT NOTES (tone anchors — do not copy):\\n'",
        "'PRIOR VISIT (factual continuity only. Do NOT imitate its opening, wording, rhythm, or "
        "structure. Write this one fresh, with a different opening):\\n'",
    ),
    (
        "'VOICE TRAINING EXAMPLES (reference only — do not copy directly):\\n'",
        "'VOICE TRAINING EXAMPLES (reference only, do not copy directly. Do NOT imitate their "
        "openings):\\n'",
    ),
]


def _transform_build_prompt(node: dict, summary: list) -> None:
    js = node.get("parameters", {}).get("jsCode", "")
    for old, new in _BUILD_EDITS:
        count = js.count(old)
        js = js.replace(old, new)
        summary.append((f"Build Prompt edit {old[:42]!r}", count))
    node["parameters"]["jsCode"] = js


def transform_workflow(wf: dict) -> tuple[dict, list]:
    """Swap voice + de-weight journals in a workflow dict. Returns (wf, summary).

    summary is a list of (description, match_count); a count of 0 means the
    target text was not found (live drift) and is surfaced fail-loud by callers.
    """
    summary: list = []
    new_system = build_n8n_system()
    nodes = wf.get("nodes", [])

    def find(name: str):
        return next((x for x in nodes if x.get("name") == name), None)

    cc = find("Call Claude")
    if cc:
        _transform_call_claude(cc, new_system, summary)
    else:
        summary.append(("Call Claude: NODE NOT FOUND", 0))

    bk = find("Build Prompt (Known)")
    if bk:
        _transform_build_prompt(bk, summary)
    else:
        summary.append(("Build Prompt (Known): NODE NOT FOUND", 0))

    return wf, summary


# ---- live n8n I/O (mirrors patch_generate_firestore.py) -------------------

_PUT_ALLOWED = {"name", "nodes", "connections", "settings", "staticData"}


def _n8n(method: str, path: str, env: dict, payload: dict | None = None) -> dict:
    url = (env.get("N8N_URL") or "").rstrip("/")
    token = env.get("N8N_TOKEN") or ""
    if not (url and token):
        raise SystemExit("N8N_URL / N8N_TOKEN missing from .env; cannot reach live n8n.")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{url}/api/v1{path}",
        data=data,
        method=method,
        headers={"X-N8N-API-KEY": token, "Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _print_summary(summary: list) -> bool:
    ok = True
    print("Transform summary:")
    for name, count in summary:
        flag = "OK " if count else "MISS"
        if not count:
            ok = False
        print(f"  [{flag}] x{count}  {name}")
    if not ok:
        print("\nWARNING: one or more targets did not match (workflow drift?). Nothing written on a MISS.")
    return ok


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Swap the n8n Generate workflow voice to the Voice Bible.")
    ap.add_argument("--snapshot", action="store_true", help="Transform the in-repo workflow snapshot (default target).")
    ap.add_argument("--live", action="store_true", help="Transform the live n8n workflow (needs the server up).")
    ap.add_argument("--apply", action="store_true", help="Write changes (default is dry-run).")
    args = ap.parse_args(argv)

    if not args.live:
        args.snapshot = True

    if args.snapshot:
        wf = json.loads(SNAPSHOT_PATH.read_text())
        wf, summary = transform_workflow(wf)
        ok = _print_summary(summary)
        if args.apply and ok:
            SNAPSHOT_OUT.write_text(json.dumps(wf, indent=2, ensure_ascii=False))
            print(f"\nWROTE {SNAPSHOT_OUT} (historical {SNAPSHOT_PATH.name} preserved)")
        elif args.apply:
            print("\nNOT WRITTEN (a target missed).")
            return 1
        else:
            print("\nDRY-RUN (snapshot). Re-run with --apply to write.")
        return 0

    # live
    env = _load_env()
    wf = _n8n("GET", f"/workflows/{WORKFLOW_ID}", env)
    wf, summary = transform_workflow(wf)
    ok = _print_summary(summary)
    if not ok:
        print("\nAborting live PUT: a target missed.")
        return 1
    if not args.apply:
        print("\nDRY-RUN (live). Re-run with --apply to PUT.")
        return 0
    payload = {k: wf[k] for k in _PUT_ALLOWED if k in wf}
    _n8n("PUT", f"/workflows/{WORKFLOW_ID}", env, payload)
    print(f"\nPUT live workflow {WORKFLOW_ID} updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
