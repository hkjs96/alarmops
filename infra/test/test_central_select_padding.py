"""Regression: Fn::Select on Fn::Split of an optional parameter must not fail when the parameter is empty.

CloudFormation evaluates every Fn::Select inside Conditions (no short-circuit in Fn::And), so
`!Select [4, !Split [":", !Ref Param]]` fails the whole change set when Param is "" ("cannot select
nonexistent value at index 4", first deploy-central run on 11/23). Each such split must be padded.
"""
import pathlib
import re
import unittest

TEMPLATE = pathlib.Path(__file__).resolve().parents[2] / "infra" / "aws" / "central.yaml"


class SelectPadding(unittest.TestCase):
    def test_no_unpadded_select_on_parameter_split(self):
        text = TEMPLATE.read_text(encoding="utf-8")
        unpadded = re.findall(r"!Select \[\d+, !Split \[\":\", !Ref [A-Za-z]+\]\]", text)
        self.assertEqual(unpadded, [], "pad the split: !Split [\":\", !Join [\"\", [!Ref P, \":::::\"]]]")

    def test_padding_keeps_account_field(self):
        arn = "arn:aws:ses:ap-northeast-2:111122223333:identity/example.com"
        self.assertEqual((arn + ":::::").split(":")[4], "111122223333")
        self.assertEqual(("" + ":::::").split(":")[4], "")


if __name__ == "__main__":
    unittest.main()
