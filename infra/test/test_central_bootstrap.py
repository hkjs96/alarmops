"""central-bootstrap.yaml must carry the same policies as infra/aws/deploy-role-policy.md (D-58). Offline; needs PyYAML.

The JSON blocks of the document (sections 1, 2, 3, 3-1) are parsed, the placeholders <PARTITION>, <ACCOUNT_ID>, <REGION>
and <SAM_ARTIFACT_BUCKET> are replaced, and the result is compared with the template's policies after Fn::Sub, Ref and
Fn::If are resolved with the parameter defaults. A second render with other parameter values checks that no name stays
hardcoded.

Run from the repo root:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import hashlib
import json
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "aws" / "central-bootstrap.yaml"
DOC = ROOT / "aws" / "deploy-role-policy.md"

ACCOUNT, PARTITION, REGION = "123456789012", "aws", "ap-northeast-2"
REPO_SUBJECT = "hkjs96@75015048/alarmops@1451138684"  # GitHubRepo default: the sub format GitHub sends (immutable IDs)
OIDC_ARN = f"arn:{PARTITION}:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"
MANAGED_LIMIT = 6144  # characters of one customer managed policy (whitespace excluded)
CENTRAL_PARTS = ("cfn", "iam", "services")
CENTRAL_RESOURCES = {"cfn": "DeployCentralCfnPolicy", "iam": "DeployCentralIamPolicy", "services": "DeployCentralServicesPolicy"}
CENTRAL_NAMES = {"cfn": "AlarmOpsDeployCentral-Cfn", "iam": "AlarmOpsDeployCentral-Iam", "services": "AlarmOpsDeployCentral-Services"}


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
    m = {"<PARTITION>": PARTITION, "<ACCOUNT_ID>": ACCOUNT, "<REGION>": REGION, "<SAM_ARTIFACT_BUCKET>": bucket,
         "<GITHUB_REPO_SUBJECT>": REPO_SUBJECT}
    return {
        "boundary": fill(doc_policy("## 2."), m),
        "trust_central": fill(doc_policy("## 1."), m),
        "policy_central_cfn": fill(doc_policy("### 3a."), m),
        "policy_central_iam": fill(doc_policy("### 3b."), m),
        "policy_central_services": fill(doc_policy("### 3c."), m),
        "trust_bus": fill(doc_policy("### 3-1.", 0), m),
        "policy_bus": fill(doc_policy("### 3-1.", 1), m),
    }


def rendered(r: Renderer) -> dict:
    return {
        "boundary": r.resource("RoleBoundaryPolicy", "PolicyDocument"),
        "trust_central": r.resource("DeployCentralRole", "AssumeRolePolicyDocument"),
        "policy_central_cfn": r.resource("DeployCentralCfnPolicy", "PolicyDocument"),
        "policy_central_iam": r.resource("DeployCentralIamPolicy", "PolicyDocument"),
        "policy_central_services": r.resource("DeployCentralServicesPolicy", "PolicyDocument"),
        "trust_bus": r.resource("DeployBusRole", "AssumeRolePolicyDocument"),
        "policy_bus": r.resource("DeployBusPolicy", "PolicyDocument"),
    }


def compact_len(doc: dict) -> int:
    return len(re.sub(r"\s", "", json.dumps(doc, separators=(",", ":"))))


# SHA-256 of each document JSON block (placeholders unreplaced, keys sorted, compact). Changing a policy in
# deploy-role-policy.md fails this test until the hash is updated on purpose, in the same commit as the template change.
DOC_HASHES = {
    ("## 1.", 0): "a0bea8d89843e52d7805d6b8b2b7f215a87f16afb3b27b1cbe189da25dfc9bdb",
    ("## 2.", 0): "c1563d02d4dc8336eb36c6473ff951b995d5746c753a65addc5d5c6d0e604c74",
    ("### 3a.", 0): "f312d3465cfee7a1cacb55df0e268c2ee67aba9e8ff8e341637e35fd126a29be",
    ("### 3b.", 0): "dd0bc86677afefd2568c898b8c11315dfd5b93ad629e025bc281d57354c639ed",
    ("### 3c.", 0): "ded691a7909312d6e83e9a6f228d6d7de53b1ffedb0391ac7c472a4c190724fe",
    ("### 3-1.", 0): "71fc111a3162ef97264aa3dd69ecf81dbaf97834ba17431c6045a1b8d14bbab8",
    ("### 3-1.", 1): "dba3cb5ded82c23d33113e68f395bad1cac68ce8ff875cf882b9363d3f79546e",
}


class DocumentIsPinned(unittest.TestCase):
    def test_document_json_hashes(self):
        for (heading, idx), want in DOC_HASHES.items():
            with self.subTest(heading=heading, index=idx):
                canon = json.dumps(doc_policy(heading, idx), sort_keys=True, separators=(",", ":"))
                self.assertEqual(hashlib.sha256(canon.encode()).hexdigest(), want,
                                 "document JSON changed: update the template and this hash together")


class SameAsDocument(unittest.TestCase):
    def setUp(self):
        self.params = defaults()
        self.params["SamArtifactBucketName"] = "my-artifacts-bucket"  # an existing bucket passed in
        self.exp = expected_docs("my-artifacts-bucket")
        self.got = rendered(Renderer(self.params))

    def test_each_policy_equals_the_document(self):
        for name in self.exp:
            with self.subTest(policy=name):
                self.assertEqual(self.got[name], self.exp[name])

    def test_statement_sids_and_order_equal_the_document(self):
        for name in ("boundary", "policy_central_cfn", "policy_central_iam", "policy_central_services", "policy_bus"):
            with self.subTest(policy=name):
                self.assertEqual([s.get("Sid") for s in self.got[name]["Statement"]],
                                 [s.get("Sid") for s in self.exp[name]["Statement"]])

    def test_created_bucket_name_is_the_documented_example(self):
        params = defaults()  # SamArtifactBucketName empty -> the stack creates the bucket
        got = rendered(Renderer(params))["policy_central_cfn"]  # the bucket is only in the Cfn policy
        exp = expected_docs(f"alarmops-central-artifacts-{ACCOUNT}")["policy_central_cfn"]
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


class GitHubRepoParameter(unittest.TestCase):
    PATTERN = re.compile(T["Parameters"]["GitHubRepo"]["AllowedPattern"])

    def test_default_is_the_immutable_id_form_and_passes(self):
        self.assertEqual(T["Parameters"]["GitHubRepo"]["Default"], REPO_SUBJECT)
        self.assertTrue(self.PATTERN.match(REPO_SUBJECT))

    def test_new_and_old_forms_pass(self):
        for v in ("owner@123/repo@456", "hkjs96/alarmops", "owner@123/repo", "owner/repo@456"):
            with self.subTest(value=v):
                self.assertTrue(self.PATTERN.match(v))

    def test_wildcards_and_malformed_are_rejected(self):
        for v in ("*", "owner/*", "*/repo", "owner@*/repo@1", "owner@1/repo@*", "owner@abc/repo", "owner/repo/x", "owner", "", "a b/c"):
            with self.subTest(value=v):
                self.assertFalse(self.PATTERN.match(v))

    def test_condition_stays_string_equals(self):
        for n in ("DeployCentralRole", "DeployBusRole"):
            cond = RES[n]["Properties"]["AssumeRolePolicyDocument"]["Statement"][0]["Condition"]
            self.assertEqual(list(cond), ["StringEquals"])


class RoleShape(unittest.TestCase):
    def test_roles_and_names(self):
        self.assertEqual(RES["DeployCentralRole"]["Properties"]["RoleName"], "AlarmOpsDeployCentral")
        self.assertEqual(RES["DeployBusRole"]["Properties"]["RoleName"], "AlarmOpsDeployBus")
        for part in CENTRAL_PARTS:
            self.assertEqual(RES[CENTRAL_RESOURCES[part]]["Properties"]["ManagedPolicyName"], CENTRAL_NAMES[part])
        self.assertEqual(RES["DeployBusPolicy"]["Properties"]["ManagedPolicyName"], "AlarmOpsDeployBus")
        self.assertEqual(T["Parameters"]["PermissionsBoundaryName"]["Default"], "AlarmOpsCentral-RoleBoundary")

    def test_roles_use_managed_policies_only(self):
        for n, want in (("DeployCentralRole", [{"Ref": v} for v in CENTRAL_RESOURCES.values()]),
                        ("DeployBusRole", [{"Ref": "DeployBusPolicy"}])):
            props = RES[n]["Properties"]
            self.assertNotIn("Policies", props)  # no inline policy: ISMS-P audit wants version history
            self.assertEqual(props["ManagedPolicyArns"], want)

    def test_session_is_one_hour_at_most(self):
        for n in ("DeployCentralRole", "DeployBusRole"):
            self.assertLessEqual(RES[n]["Properties"]["MaxSessionDuration"], 3600)

    def test_trust_is_exact_sub_without_wildcards(self):
        r = Renderer(defaults())
        for key, sub in (("trust_central", f"repo:{REPO_SUBJECT}:environment:central"),
                         ("trust_bus", f"repo:{REPO_SUBJECT}:environment:central-bus")):
            cond = rendered(r)[key]["Statement"][0]["Condition"]
            self.assertEqual(list(cond), ["StringEquals"])
            self.assertEqual(cond["StringEquals"]["token.actions.githubusercontent.com:sub"], sub)
            self.assertEqual(cond["StringEquals"]["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com")

    def test_only_the_expected_resource_types(self):
        types = sorted(v["Type"] for v in RES.values())
        self.assertEqual(types, sorted(["AWS::IAM::OIDCProvider", "AWS::IAM::OIDCProvider", "AWS::S3::Bucket", "AWS::S3::BucketPolicy",
                                        "AWS::IAM::ManagedPolicy", "AWS::IAM::ManagedPolicy", "AWS::IAM::ManagedPolicy",
                                        "AWS::IAM::ManagedPolicy", "AWS::IAM::ManagedPolicy", "AWS::IAM::Role", "AWS::IAM::Role"]))

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


class StackNameRules(unittest.TestCase):
    BOOT = "alarmops-central-bootstrap"

    def assertions(self):
        return T["Rules"]["StackNamesAreDifferent"]["Assertions"]

    def passes(self, central, bus):
        r = Renderer({**defaults(), "CentralStackName": central, "BusStackName": bus})

        def ev(n):
            (k, v), = n.items()
            if k == "Fn::Not":
                return not ev(v[0])
            if k == "Fn::Equals":
                return r.expr(v[0]) == r.expr(v[1])
            raise ValueError(k)
        return all(ev(a["Assert"]) for a in self.assertions())

    def test_defaults_pass(self):
        self.assertTrue(self.passes("alarmops-central", "alarmops-central-bus"))

    def test_equal_or_bootstrap_names_fail(self):
        self.assertFalse(self.passes("same-name", "same-name"))
        self.assertFalse(self.passes(self.BOOT, "alarmops-central-bus"))
        self.assertFalse(self.passes("alarmops-central", self.BOOT))

    def test_minimum_length_is_five(self):
        for name in ("ResourcePrefix", "CentralStackName"):
            pat = re.compile(T["Parameters"][name]["AllowedPattern"])
            with self.subTest(parameter=name):
                self.assertIsNone(pat.match("abcd"))
                self.assertIsNotNone(pat.match("abcde"))


class BucketHardening(unittest.TestCase):
    def test_owner_enforced(self):
        rules = RES["SamArtifactBucket"]["Properties"]["OwnershipControls"]["Rules"]
        self.assertEqual(rules, [{"ObjectOwnership": "BucketOwnerEnforced"}])

    def test_policy_denies_plain_http_on_bucket_and_objects(self):
        r = Renderer({**defaults()})
        pol = r.resource("SamArtifactBucketPolicy", "PolicyDocument")
        self.assertEqual(RES["SamArtifactBucketPolicy"]["Condition"], "CreateSamArtifactBucket")
        (s,) = pol["Statement"]
        self.assertEqual((s["Effect"], s["Principal"], s["Action"]), ("Deny", "*", "s3:*"))
        self.assertEqual(s["Condition"], {"Bool": {"aws:SecureTransport": "false"}})
        b = r.bucket_name()
        self.assertEqual(s["Resource"], [f"arn:{PARTITION}:s3:::{b}", f"arn:{PARTITION}:s3:::{b}/*"])


class ManagedPolicySize(unittest.TestCase):
    """One customer managed policy holds at most 6,144 characters (whitespace excluded), counted after Fn::Sub is expanded."""

    def test_every_managed_policy_is_within_the_limit(self):
        got = rendered(Renderer({**defaults(), "SamArtifactBucketName": "alarmops-central-artifacts-123456789012"}))
        for key in ("boundary", "policy_central_cfn", "policy_central_iam", "policy_central_services", "policy_bus"):
            size = compact_len(got[key])
            with self.subTest(policy=key, size=size):
                self.assertLessEqual(size, MANAGED_LIMIT)

    def test_size_is_checked_with_long_names_too(self):
        params = {**defaults(), "ResourcePrefix": "p" * 20, "CentralStackName": "c" * 30, "BusStackName": "b" * 30,
                  "BusName": "n" * 30, "PermissionsBoundaryName": "B" * 40, "SamArtifactBucketName": "x" * 63}
        got = rendered(Renderer(params))
        for key in ("policy_central_cfn", "policy_central_iam", "policy_central_services", "policy_bus"):
            with self.subTest(policy=key):
                self.assertLessEqual(compact_len(got[key]), MANAGED_LIMIT)

    def test_trust_change_policy_still_fits_the_inline_limit(self):
        # The temporary TrustChange policy (document section 4) is the only inline policy; about 400 characters of 10,240.
        self.assertEqual(sum("Policies" in RES[n]["Properties"] for n in ("DeployCentralRole", "DeployBusRole")), 0)


class DeployPolicyIsProtected(unittest.TestCase):
    """The deploy roles cannot edit their own managed policies; the Deny statements stay in the attached policies."""

    def setUp(self):
        self.got = rendered(Renderer({**defaults(), "SamArtifactBucketName": "b"}))
        self.iam = {s["Sid"]: s for s in self.got["policy_central_iam"]["Statement"]}
        self.own = [f"arn:{PARTITION}:iam::{ACCOUNT}:policy/AlarmOpsCentral-RoleBoundary",
                    f"arn:{PARTITION}:iam::{ACCOUNT}:policy/AlarmOpsDeployCentral-*",
                    f"arn:{PARTITION}:iam::{ACCOUNT}:policy/AlarmOpsDeployBus"]

    def test_all_deny_statements_live_in_the_iam_policy(self):
        for key in ("policy_central_cfn", "policy_central_services"):
            self.assertEqual([s["Sid"] for s in self.got[key]["Statement"] if s["Effect"] == "Deny"], [])
        for sid in ("DenyBoundaryRemoval", "DenyOtherBoundary", "DenyBoundaryPolicyChange", "DenyDeployPolicyAttachment",
                    "DenyForceDeleteSecret", "DenySecretValues", "DenyPivotAndQueueData"):
            self.assertEqual(self.iam[sid]["Effect"], "Deny", sid)

    def test_policy_edit_is_denied_on_boundary_and_deploy_policies(self):
        s = self.iam["DenyBoundaryPolicyChange"]
        self.assertEqual(sorted(s["Action"]), ["iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion"])
        self.assertEqual(s["Resource"], self.own)

    def test_attach_detach_of_own_policies_is_denied(self):
        s = self.iam["DenyDeployPolicyAttachment"]
        self.assertEqual(s["Resource"], "*")
        self.assertIn("iam:AttachRolePolicy", s["Action"])
        self.assertIn("iam:DetachRolePolicy", s["Action"])
        self.assertEqual(s["Condition"], {"ArnLike": {"iam:PolicyARN": self.own}})

    def test_no_allow_grants_policy_writes(self):
        import fnmatch
        banned = ("iam:CreatePolicy", "iam:SetDefaultPolicyVersion", "iam:DeletePolicy", "iam:PutRolePolicy", "iam:AttachRolePolicy")
        for key in ("policy_central_cfn", "policy_central_iam", "policy_central_services", "policy_bus"):
            for s in self.got[key]["Statement"]:
                if s["Effect"] != "Allow":
                    continue
                acts = [s["Action"]] if isinstance(s["Action"], str) else s["Action"]
                for a in acts:
                    if a in ("iam:PutRolePolicy", "iam:AttachRolePolicy"):
                        continue  # on roles of the central stack only, checked below
                    self.assertFalse(any(fnmatch.fnmatchcase(a, b) for b in banned), (key, s["Sid"], a))

    def test_attach_allow_condition_is_unchanged(self):
        s = self.iam["IamAttachLambdaManagedPolicies"]
        self.assertEqual(s["Action"], ["iam:AttachRolePolicy", "iam:DetachRolePolicy"])
        self.assertEqual(s["Resource"], f"arn:{PARTITION}:iam::{ACCOUNT}:role/alarmops-central-*")
        self.assertEqual(s["Condition"], {"StringEquals": {
            "iam:PermissionsBoundary": f"arn:{PARTITION}:iam::{ACCOUNT}:policy/AlarmOpsCentral-RoleBoundary",
            "iam:PolicyARN": [f"arn:{PARTITION}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                              f"arn:{PARTITION}:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole"]}})

    def test_apigateway_tagging_is_in_the_services_policy(self):
        s = {x["Sid"]: x for x in self.got["policy_central_services"]["Statement"]}["ApiGatewayHttpApi"]
        self.assertIn("apigateway:TagResource", s["Action"])
        self.assertIn("apigateway:UntagResource", s["Action"])


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
        return got["policy_central_cfn"]["Statement"] + got["policy_central_iam"]["Statement"] + got["policy_central_services"]["Statement"] + got["policy_bus"]["Statement"]

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
                   f"arn:{PARTITION}:iam::{ACCOUNT}:policy/AlarmOpsDeployCentral-Cfn",
                   f"arn:{PARTITION}:iam::{ACCOUNT}:policy/AlarmOpsDeployCentral-Iam",
                   f"arn:{PARTITION}:iam::{ACCOUNT}:policy/AlarmOpsDeployCentral-Services",
                   f"arn:{PARTITION}:iam::{ACCOUNT}:policy/AlarmOpsDeployBus",
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
