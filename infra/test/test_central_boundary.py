"""central.yaml permissions boundary and portability tests (D-58). Offline; needs only PyYAML.

Run from the repo root:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CENTRAL = ROOT / "aws" / "central.yaml"


def _load(path: Path) -> dict:
    class L(yaml.SafeLoader):
        pass

    def tag(loader, suffix, node):
        if isinstance(node, yaml.ScalarNode):
            val = loader.construct_scalar(node)
        elif isinstance(node, yaml.SequenceNode):
            val = loader.construct_sequence(node, deep=True)
        else:
            val = loader.construct_mapping(node, deep=True)
        return {("Ref" if suffix == "Ref" else f"Fn::{suffix}"): val}

    L.add_multi_constructor("!", tag)
    return yaml.load(path.read_text(encoding="utf-8"), Loader=L)


T = _load(CENTRAL)
EXPECTED = {"Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/${PermissionsBoundaryName}"}


def walk(node):
    yield node
    if isinstance(node, dict):
        for v in node.values():
            yield from walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v)


class PermissionsBoundary(unittest.TestCase):
    def test_boundary_parameter_defaults_to_the_documented_name(self):
        self.assertEqual(T["Parameters"]["PermissionsBoundaryName"]["Default"], "AlarmOpsCentral-RoleBoundary")

    def test_every_iam_role_has_the_boundary(self):
        roles = {k: v for k, v in T["Resources"].items() if v["Type"] == "AWS::IAM::Role"}
        self.assertGreaterEqual(len(roles), 3)
        for name, r in roles.items():
            with self.subTest(role=name):
                self.assertEqual(r["Properties"].get("PermissionsBoundary"), EXPECTED)

    def test_globals_function_has_the_boundary(self):
        self.assertEqual(T["Globals"]["Function"].get("PermissionsBoundary"), EXPECTED)

    def test_no_function_overrides_the_boundary(self):
        for name, r in T["Resources"].items():
            if r["Type"] == "AWS::Serverless::Function":
                with self.subTest(function=name):
                    self.assertEqual(r["Properties"].get("PermissionsBoundary", EXPECTED), EXPECTED)


class Portability(unittest.TestCase):
    """No account id, region or partition is written into the template (D-58)."""

    def test_no_twelve_digit_account_id_in_resources(self):
        for s in walk(T["Resources"]):
            if isinstance(s, str):
                self.assertIsNone(re.search(r"(?<![0-9])[0-9]{12}(?![0-9])", s), s)

    def test_no_literal_region_in_resources(self):
        for s in walk(T["Resources"]):
            if isinstance(s, str):
                self.assertIsNone(re.search(r"\b[a-z]{2}-[a-z]+-[0-9]\b", s), s)

    def test_arns_in_resources_use_the_partition_pseudo_parameter(self):
        for s in walk(T["Resources"]):
            if isinstance(s, str):
                for m in re.finditer(r"arn:(\$\{AWS::Partition\}|[^:\s$]*):", s):
                    self.assertEqual(m.group(1), "${AWS::Partition}", f"hardcoded partition in: {s}")

    def test_parameter_patterns_do_not_pin_partition_or_region(self):
        for name, p in T["Parameters"].items():
            pat = p.get("AllowedPattern", "")
            with self.subTest(parameter=name):
                self.assertNotIn("arn:aws:", pat)
                self.assertNotRegex(pat, r"[a-z]{2}-[a-z]+-[0-9]")

    def test_no_organizations_dependency(self):
        text = CENTRAL.read_text(encoding="utf-8")
        for needle in ("PrincipalOrgID", "PrincipalOrgPaths", "aws:ResourceOrgID", "AWS::Organizations"):
            self.assertNotIn(needle, text)


if __name__ == "__main__":
    unittest.main()
