"""Tests for the n8n 'Auntie OS - Generate' workflow voice swap.

transform_workflow() rewrites the Call Claude system prompt (old v1 rules ->
Voice Bible + exemplars + the anti-formula opener rule) and de-weights the
Build Prompt visit-log 'tone anchors'. Runs on the in-repo snapshot here; the
same function patches live n8n when the server is reachable.

Run: python3 -m unittest test_patch_generate_voice -v
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import patch_generate_voice as pv

SNAP = Path("_workflow_snapshots/SIg2KsWn0oyRkSzR_pre_firestore.json")
DASH_RE = re.compile("[—–]")


def _transformed():
    wf = json.loads(SNAP.read_text())
    return pv.transform_workflow(wf)


def _node(wf, name):
    return next(n for n in wf["nodes"] if n["name"] == name)


class CallClaudeSystemTests(unittest.TestCase):
    def setUp(self):
        self.wf, self.summary = _transformed()
        self.cc = _node(self.wf, "Call Claude")
        self.body = self.cc["parameters"]["jsonBody"]
        self.system = pv.extract_system_text(self.cc)

    def test_old_v1_rules_removed(self):
        # v1 file markers must be gone from the embedded voice source.
        self.assertNotIn("Extracted from 76 real", self.system)
        self.assertNotIn("Opening energy phrase samples", self.system)
        # Our framing must not carry the v1 "start with the arrival energy" directive.
        # (The Bible legitimately QUOTES the phrase in §0 to reframe it, so we check
        # the framing we control, not the whole system.)
        self.assertNotIn("arrival energy", pv.N8N_FRAMING.lower())

    def test_new_voice_bible_and_exemplars_embedded(self):
        self.assertIn("NO formula", self.system)      # Bible §0
        self.assertIn("GOLD STANDARD", self.system)    # exemplars

    def test_anti_formula_opener_rule_present(self):
        low = self.system.lower()
        self.assertIn("vary the opening", low)
        self.assertTrue("1 in 10" in low or "10%" in low)
        self.assertIn("well", low)

    def test_system_has_no_em_or_en_dashes(self):
        self.assertIsNone(DASH_RE.search(self.system), "system prompt must have no em/en dashes")

    def test_jsonbody_remains_valid_n8n_expression(self):
        self.assertTrue(self.body.startswith("={{"))
        self.assertIn("JSON.stringify", self.body)
        self.assertIn("claude-sonnet-4-5", self.body)
        # the messages wiring to the Build Prompt output must survive
        self.assertIn("$json.user_message", self.body)
        self.assertIn("messages", self.body)


class BuildPromptDeWeightTests(unittest.TestCase):
    def setUp(self):
        self.wf, self.summary = _transformed()
        self.js = _node(self.wf, "Build Prompt (Known)")["parameters"]["jsCode"]

    def test_visit_logs_deweighted_to_one(self):
        self.assertNotIn("slice(0, 5)", self.js)
        self.assertIn("slice(0, 1)", self.js)

    def test_no_tone_anchor_label(self):
        self.assertNotIn("tone anchor", self.js.lower())

    def test_no_imitate_instruction_present(self):
        self.assertIn("do not imitate", self.js.lower())

    def test_build_prompt_has_no_em_or_en_dashes(self):
        self.assertIsNone(DASH_RE.search(self.js), "Build Prompt jsCode must have no em/en dashes")


class TransformSummaryTests(unittest.TestCase):
    def test_summary_reports_each_op_matched(self):
        _, summary = _transformed()
        # every reported op must have applied at least once (fail-loud on a miss)
        misses = [name for name, count in summary if count == 0]
        self.assertEqual(misses, [], f"unmatched transform ops (live drift?): {misses}")

    def test_build_n8n_system_is_standalone(self):
        sys_text = pv.build_n8n_system()
        self.assertIn("NO formula", sys_text)
        self.assertIn("GOLD STANDARD", sys_text)
        self.assertIsNone(DASH_RE.search(sys_text))


if __name__ == "__main__":
    unittest.main()
