"""Regression: the managed policies SAM attaches to the function roles must be the ones the deploy role may attach.

The first apply (11/23) failed with iam:AttachRolePolicy AccessDenied because `Tracing: PassThrough` in Globals made SAM
attach AWSXrayWriteOnlyAccess. The deploy role only allows AWSLambdaBasicExecutionRole and AWSLambdaSQSQueueExecutionRole
(infra/aws/central-bootstrap.yaml, IamAttachLambdaManagedPolicies). Runs the real SAM translator when it is installed.
"""
import json
import os
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
ALLOWED = {
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole",
}

try:
    from samtranslator.translator.transform import transform  # type: ignore
    from cfnlint.decode import cfn_yaml  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    transform = None


class SamManagedPolicies(unittest.TestCase):
    def test_no_tracing_in_globals(self):
        text = (ROOT / "infra" / "aws" / "central.yaml").read_text(encoding="utf-8")
        self.assertNotIn("Tracing:", text, "any Tracing value makes SAM attach AWSXrayWriteOnlyAccess")

    @unittest.skipIf(transform is None, "aws-sam-translator not installed")
    def test_translated_roles_attach_only_allowed_policies(self):
        os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
        t = json.loads(json.dumps(cfn_yaml.load(str(ROOT / "infra" / "aws" / "central.yaml")), default=str))
        for res in t["Resources"].values():
            if res["Type"] == "AWS::Serverless::Function":
                res["Properties"]["CodeUri"] = "s3://bucket/key.zip"

        class Loader:
            def load(self):
                return {}

        out = transform(t, {}, Loader())
        for name, res in out["Resources"].items():
            if res["Type"] != "AWS::IAM::Role":
                continue
            props = res["Properties"]
            self.assertIn("PermissionsBoundary", props, name)
            extra = set(props.get("ManagedPolicyArns") or []) - ALLOWED
            self.assertEqual(extra, set(), f"{name} attaches managed policies the deploy role may not attach")


if __name__ == "__main__":
    unittest.main()
