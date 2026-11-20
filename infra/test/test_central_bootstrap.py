"""central-bootstrap.yaml must carry the same policies as infra/aws/deploy-role-policy.md (D-58). Offline; needs PyYAML.

The JSON blocks of the document (sections 1, 2, 3, 3-1) are parsed, the placeholders <PARTITION>, <ACCOUNT_ID>, <REGION>
and <SAM_ARTIFACT_BUCKET> are replaced, and the result is compared with the template's policies after Fn::Sub, Ref and
Fn::If are resolved with the parameter defaults. A second render with other parameter values checks that no name stays
hardcoded.

Run from the repo root:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import copy
import json
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "aws" / "central-bootstrap.yaml"
DOC = ROOT / "aws" / "deploy-role-policy.md"

ACCOUNT, PARTITION, REGION = "123456789012", "aws", "ap-northeast-2"
OIDC_ARN = f"arn:{PARTITION}:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"
INLINE_LIMIT = 10240  # total inline policy characters per role (whitespace excluded)


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


T = _load(TEMPLATE)
RES = T["Resources"]


def doc_blocks() -> dict[str, list]:
    """json blocks of the document keyed by the heading they sit under."""
    out: dict[str, list] = {}
    head, cur = "", None
    for line in DOC.read_text(encoding="utf-8").splitlines():
        if cur is None:
            if line.startswith("#"):
                head = line
            elif line.strip() == "```json":
                cur = []
        elif line.strip() == "```":
            out.setdefault(head, []).append(json.loads("\n".join(cur)))
            cur = None
        else:
            cur.append(line)
    return out


def doc_policy(prefix: str, index: int = 0) -> dict:
    blocks = [v for k, v in doc_blocks().items() if k.startswith(prefix)]
    assert blocks, f"no json block under heading {prefix!r}"
    return blocks[0][index]


def fill(node, mapping: dict[str, str]):
    if isinstance(node, dict):
        return {k: fill(v, mapping) for k, v in node.items()}
    if isinstance(node, list):
        return [fill(v, mapping) for v in node]
    if isinstance(node, str):
        for a, b in mapping.items():
            node = node.replace(a, b)
    return node


def defaults() -> dict[str, str]:
    return {k: str(v.get("Default", "")) for k, v in T["Parameters"].items()}


class Renderer:
    def __init__(self, params: dict[str, str]):
        self.p = dict(params)
        self.pseudo = {"AWS::Partition": PARTITION, "AWS::AccountId": ACCOUNT, "AWS::Region": REGION}
        self.cond = {name: self.expr(c) for name, c in T["Conditions"].items()}

    def bucket_name(self) -> str:
        return f"{self.p['ResourcePrefix']}-central-artifacts-{ACCOUNT}"

    def ref(self, name: str) -> str:
        if name in self.pseudo:
            return self.pseudo[name]
        if name in self.p:
            return self.p[name]
        if name == "GitHubOidcProvider":
            return OIDC_ARN
        if name == "SamArtifactBucket":
            return self.bucket_name()
        raise KeyError(name)

    def expr(self, n):
        if isinstance(n, dict) and len(n) == 1 and (next(iter(n)) == "Ref" or next(iter(n)).startswith("Fn::")):
            (k, v), = n.items()
            if k == "Ref":
                return self.ref(v)
            if k == "Fn::Equals":
                return self.expr(v[0]) == self.expr(v[1])
            if k == "Fn::If":
                return self.expr(v[1] if self.cond[v[0]] else v[2])
            if k == "Fn::Sub":
                tmpl, local = (v, {}) if isinstance(v, str) else (v[0], {a: self.expr(b) for a, b in v[1].items()})
                return re.sub(r"\$\{([^}]+)\}", lambda m: local[m.group(1)] if m.group(1) in local else self.ref(m.group(1)), tmpl)
            raise ValueError(f"unsupported intrinsic {k}")
        if isinstance(n, dict):
            return {k: self.expr(v) for k, v in n.items()}
        if isinstance(n, list):
            return [self.expr(v) for v in n]
        return n

    def resource(self, name: str, *path):
        n = RES[name]["Properties"]
        for p in path:
            n = n[p]
        return self.expr(n)


def expected_docs(bucket: str) -> dict:
    m = {"<PARTITION>": PARTITION, "<ACCOUNT_ID>": ACCOUNT, "<REGION>": REGION, "<SAM_ARTIFACT_BUCKET>": bucket}
    return {
        "boundary": fill(doc_policy("## 2."), m),
        "trust_central": fill(doc_policy("## 1."), m),
        "policy_central": fill(doc_policy("## 3."), m),
        "trust_bus": fill(doc_policy("### 3-1.", 0), m),
        "policy_bus": fill(doc_policy("### 3-1.", 1), m),
    }


def rendered(r: Renderer) -> dict:
    return {
        "boundary": r.resource("RoleBoundaryPolicy", "PolicyDocument"),
        "trust_central": r.resource("DeployCentralRole", "AssumeRolePolicyDocument"),
        "policy_central": r.resource("DeployCentralRole", "Policies", 0, "PolicyDocument"),
        "trust_bus": r.resource("DeployBusRole", "AssumeRolePolicyDocument"),
        "policy_bus": r.resource("DeployBusRole", "Policies", 0, "PolicyDocument"),
    }


def compact_len(doc: dict) -> int:
    return len(re.sub(r"\s", "", json.dumps(doc, separators=(",", ":"))))


def norm(doc: dict) -> dict:
    """IAM treats a one-element list and a string alike for Action/Resource; keep the document's form but sort statements
    by position only (order is not changed)."""
    return copy.deepcopy(doc)


class SameAsDocument(unittest.TestCase):
    def setUp(self):
        self.params = defaults()
        self.params["SamArtifactBucketName"] = "my-artifacts-bucket"  # an existing bucket passed in
        self.exp = expected_docs("my-artifacts-bucket")
        self.got = rendered(Renderer(self.params))

    def test_each_policy_equals_the_document(self):
        for name in self.exp:
            with self.subTest(policy=name):
                self.assertEqual(norm(self.got[name]), norm(self.exp[name]))

    def test_statement_sids_and_order_equal_the_document(self):
        for name in ("boundary", "policy_central", "policy_bus"):
            with self.subTest(policy=name):
                self.assertEqual([s.get("Sid") for s in self.got[name]["Statement"]],
                                 [s.get("Sid") for s in self.exp[name]["Statement"]])

    def test_created_bucket_name_is_the_documented_example(self):
        params = defaults()  # SamArtifactBucketName empty -> the stack creates the bucket
        got = rendered(Renderer(params))["policy_central"]
        exp = expected_docs(f"alarmops-central-artifacts-{ACCOUNT}")["policy_central"]
        self.assertEqual(got, exp)

    def test_existing_oidc_provider_arn_is_used_when_given(self):
        other = f"arn:{PARTITION}:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"
        params = defaults()
        params["GitHubOidcProviderArn"] = other
        for key in ("trust_central", "trust_bus"):
            self.assertEqual(rendered(Renderer(params))[key]["Statement"][0]["Principal"]["Federated"], other)


class NamesAreParameters(unittest.TestCase):
    def test_changing_every_name_leaves_no_hardcoded_default(self):
        params = defaults()
        params.update({"ResourcePrefix": "zzz", "CentralStackName": "cstack", "BusStackName": "bstack", "BusName": "bname",
                       "PermissionsBoundaryName": "ZzzBoundary", "GitHubRepo": "own/repo",
                       "SamArtifactBucketName": "zbucket"})
        got = rendered(Renderer(params))
        for name, doc in got.items():
            with self.subTest(policy=name):
                self.assertNotIn("alarmops", json.dumps(doc))
                self.assertNotIn("AlarmOpsCentral-RoleBoundary", json.dumps(doc))
        self.assertIn("repo:own/repo:environment:central", json.dumps(got["trust_central"]))
        self.assertIn("repo:own/repo:environment:central-bus", json.dumps(got["trust_bus"]))


class RoleShape(unittest.TestCase):
    def test_roles_and_names(self):
        self.assertEqual(RES["DeployCentralRole"]["Properties"]["RoleName"], "AlarmOpsDeployCentral")
        self.assertEqual(RES["DeployBusRole"]["Properties"]["RoleName"], "AlarmOpsDeployBus")
        self.assertEqual(RES["DeployCentralRole"]["Properties"]["Policies"][0]["PolicyName"], "AlarmOpsDeployCentral-Policy")
        self.assertEqual(RES["DeployBusRole"]["Properties"]["Policies"][0]["PolicyName"], "AlarmOpsDeployBus-Policy")
        self.assertEqual(T["Parameters"]["PermissionsBoundaryName"]["Default"], "AlarmOpsCentral-RoleBoundary")

    def test_session_is_one_hour_at_most(self):
        for n in ("DeployCentralRole", "DeployBusRole"):
            self.assertLessEqual(RES[n]["Properties"]["MaxSessionDuration"], 3600)

    def test_trust_is_exact_sub_without_wildcards(self):
        r = Renderer(defaults())
        for key, sub in (("trust_central", "repo:hkjs96/alarmops:environment:central"),
                         ("trust_bus", "repo:hkjs96/alarmops:environment:central-bus")):
            cond = rendered(r)[key]["Statement"][0]["Condition"]
            self.assertEqual(list(cond), ["StringEquals"])
            self.assertEqual(cond["StringEquals"]["token.actions.githubusercontent.com:sub"], sub)
            self.assertEqual(cond["StringEquals"]["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com")

    def test_only_the_expected_resource_types(self):
        types = sorted(v["Type"] for v in RES.values())
        self.assertEqual(types, sorted(["AWS::IAM::OIDCProvider", "AWS::IAM::OIDCProvider", "AWS::S3::Bucket",
                                        "AWS::IAM::ManagedPolicy", "AWS::IAM::Role", "AWS::IAM::Role"]))

    def test_outputs(self):
        for o in ("DeployCentralRoleArn", "DeployBusRoleArn", "PermissionsBoundaryArn", "GitHubOidcProviderArn",
                  "VercelOidcProviderArn", "SamArtifactBucketName"):
            self.assertIn(o, T["Outputs"])


class CreateOrReuse(unittest.TestCase):
    def test_each_shared_resource_is_conditional_and_retained(self):
        for name in ("GitHubOidcProvider", "VercelOidcProvider", "SamArtifactBucket"):
            with self.subTest(resource=name):
                self.assertIn("Condition", RES[name])
                self.assertEqual(RES[name]["DeletionPolicy"], "Retain")
                self.assertEqual(RES[name]["UpdateReplacePolicy"], "Retain")

    def test_default_creates_everything(self):
        r = Renderer(defaults())
        self.assertTrue(all(r.cond.values()), r.cond)

    def test_passing_an_existing_value_creates_nothing(self):
        p = defaults()
        p.update({"GitHubOidcProviderArn": OIDC_ARN, "SamArtifactBucketName": "b",
                  "VercelOidcProviderArn": f"arn:{PARTITION}:iam::{ACCOUNT}:oidc-provider/oidc.vercel.com"})
        self.assertFalse(any(Renderer(p).cond.values()))

    def test_bucket_is_private_versioned_encrypted(self):
        p = RES["SamArtifactBucket"]["Properties"]
        self.assertEqual(set(p["PublicAccessBlockConfiguration"].values()), {True})
        self.assertEqual(p["VersioningConfiguration"]["Status"], "Enabled")
        self.assertEqual(p["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]["ServerSideEncryptionByDefault"]["SSEAlgorithm"], "AES256")

    def test_providers(self):
        g, v = RES["GitHubOidcProvider"]["Properties"], RES["VercelOidcProvider"]["Properties"]
        self.assertEqual((g["Url"], g["ClientIdList"]), ("https://token.actions.githubusercontent.com", ["sts.amazonaws.com"]))
        self.assertEqual(v["Url"], "https://oidc.vercel.com")
        self.assertEqual(v["ClientIdList"], [{"Fn::Sub": "https://vercel.com/${VercelTeamSlug}"}])


class InlinePolicySize(unittest.TestCase):
    def test_expanded_size_stays_under_the_inline_limit_with_the_trust_change_policy_room(self):
        got = rendered(Renderer({**defaults(), "SamArtifactBucketName": "alarmops-central-artifacts-123456789012"}))
        # The temporary TrustChange policy (document section 4) is about 400 characters and shares the limit.
        for key in ("policy_central", "policy_bus"):
            size = compact_len(got[key])
            with self.subTest(policy=key, size=size):
                self.assertLess(size + 400, INLINE_LIMIT)


class Portability(unittest.TestCase):
    """No account id, region or partition is written into the template (D-58)."""

    def strings(self, n):
        if isinstance(n, str):
            yield n
        elif isinstance(n, dict):
            for v in n.values():
                yield from self.strings(v)
        elif isinstance(n, list):
            for v in n:
                yield from self.strings(v)

    def test_no_account_region_or_literal_partition(self):
        for s in self.strings(RES):
            self.assertIsNone(re.search(r"(?<![0-9])[0-9]{12}(?![0-9])", s), s)
            self.assertIsNone(re.search(r"\b[a-z]{2}-[a-z]+-[0-9]\b", s), s)
            for m in re.finditer(r"arn:(\$\{AWS::Partition\}|[^:\s$]*):", s):
                self.assertEqual(m.group(1), "${AWS::Partition}", s)

    def test_no_organizations_dependency(self):
        text = TEMPLATE.read_text(encoding="utf-8")
        for needle in ("PrincipalOrgID", "PrincipalOrgPaths", "aws:ResourceOrgID", "AWS::Organizations"):
            self.assertNotIn(needle, text)


class DeployRolesCannotTouchThisStack(unittest.TestCase):
    """Section 5 of the document: nothing the deploy roles may do matches the bootstrap stack, its roles or providers."""

    STACK = "alarmops-central-bootstrap"

    def statements(self):
        got = rendered(Renderer({**defaults(), "SamArtifactBucketName": "b"}))
        return got["policy_central"]["Statement"] + got["policy_bus"]["Statement"]

    def resources_of_allows(self):
        for s in self.statements():
            if s["Effect"] == "Allow":
                res = s["Resource"]
                yield s, ([res] if isinstance(res, str) else res)

    def test_no_allow_resource_matches_the_stack_or_its_iam_objects(self):
        import fnmatch
        targets = [f"arn:{PARTITION}:cloudformation:{REGION}:{ACCOUNT}:stack/{self.STACK}/00000000-0000-0000-0000-000000000000",
                   f"arn:{PARTITION}:iam::{ACCOUNT}:role/AlarmOpsDeployCentral",
                   f"arn:{PARTITION}:iam::{ACCOUNT}:role/AlarmOpsDeployBus",
                   f"arn:{PARTITION}:iam::{ACCOUNT}:policy/AlarmOpsCentral-RoleBoundary",
                   OIDC_ARN,
                   f"arn:{PARTITION}:iam::{ACCOUNT}:oidc-provider/oidc.vercel.com"]
        for s, resources in self.resources_of_allows():
            if resources == ["*"]:
                # Wildcard resources are allowed only for actions that cannot change these objects.
                for a in ([s["Action"]] if isinstance(s["Action"], str) else s["Action"]):
                    self.assertFalse(a.startswith(("iam:Put", "iam:Create", "iam:Update", "iam:Delete", "iam:Attach", "cloudformation:")), (s["Sid"], a))
                continue
            for pattern in resources:
                for t in targets:
                    with self.subTest(sid=s["Sid"], pattern=pattern, target=t):
                        self.assertFalse(fnmatch.fnmatchcase(t, pattern))


if __name__ == "__main__":
    unittest.main()
