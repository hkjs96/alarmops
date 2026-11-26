#!/usr/bin/env python3
"""Fake `aws` CLI used by test_rehearsal_*.py (test support, not a test module).

Every invocation is appended as one JSON line to $FAKE_AWS_LOG. Responses come from the
JSON scenario file $FAKE_AWS_SCENARIO. Nothing here talks to a network.

Recorded fields per call: argv, service, op, files (contents of every `file://` / `fileb://`
argument, read at call time), stdin (when piped).

Unsupported --query expressions exit 97 and are recorded in $FAKE_AWS_LOG.unsupported-query.
Each record has `echo`: the secret-echo paths taken by that call.

Scenario keys (all optional):
  account            sts get-caller-identity Account
  stacks             [{StackName, StackStatus, Tags:[{Key,Value}], Parameters:[...], ...}]
  queues             {name: {"tags": {k: v}}}
  alarms             [{AlarmName, Namespace, MetricName, Dimensions:[{Name,Value}], "tags": {k: v}}]
  simulate           {"with_request_tag": "allowed", "without_request_tag": "implicitDeny"}
  leak               string echoed into stderr of every non-sts call (a secret leaking via warnings)
  fail_writes        message; every non-read operation exits 255 with it in the error text
  fail_reads         message; read operations in fail_read_ops (default: validate-template, list-roles,
                     describe-trails) exit 255 with it in the error text (lets read-only scripts hit the
                     error-response path). describe-stacks is never failed so its echo path stays testable.
  fail_ops           ["service op", ...]; those calls exit 254 with a plain error (no secret)
  role_trust         {roleName: trust policy document}   iam get-role
  role_policies      {roleName: [inline policy names]}   iam list-role-policies
  caller_arn         sts get-caller-identity Arn (default assumed-role/fake/rehearsal)
  iam_roles          {roleName: {"boundary": arn|null, "policies": {policyName: doc}, "tags": {k: v}}}. Presence switches
                     iam get-role to strict mode (NoSuchEntity for unknown roles) and enables the replica-check model
                     (replica-check.sh, #159): iam get-role-policy/create-role/put-role-policy/delete-role-policy/
                     delete-role and cloudwatch put-metric-alarm/tag-resource/delete-alarms keep state in
                     $FAKE_AWS_LOG.state. sts assume-role returns the fixed REPLICA_* credentials. Calls carrying
                     AWS_ACCESS_KEY_ID in env are "replica" calls: the credentials must match, and the allow/deny
                     decision comes from the role's stored inline policy (StringEquals + ForAnyValue/ForAllValues on
                     aws:RequestTag/*, aws:ResourceTag/*, aws:TagKeys; explicit Deny wins).
  cw_overwrite_unmanaged_denied  true: a replica PutMetricAlarm on an existing alarm WITHOUT ManagedBy=AlarmOps is denied
                     (models CloudWatch applying the resource tag on update); false/absent: the policy decides, so a
                     request tag ManagedBy=AlarmOps overwrites it (the suspected hole checked by replica-check (f))
  fail_nth           {"service op": N}: the N-th call (1-based) of that operation exits 254 with InternalFailure
  sleep_ops          {"service op": seconds}: that call touches $FAKE_AWS_LOG.sleeping then sleeps (signal tests)
  iam_roles entries may carry "path": "/aws-reserved/sso.amazonaws.com/ap-northeast-2/" (iam get-role Arn includes it)
  assume_crlf        true: sts assume-role output ends every line with CRLF (Windows aws.exe)
  assume_fail_first  N: the first N sts assume-role calls fail with AccessDenied (IAM propagation)
  metric_sums        {"Invocations": {"start": N, "step": S, "empty_first": bool}}; the n-th get-metric-statistics call for that
                     metric returns one datapoint with Sum = start + S*n (n counts from 0)
"""

from __future__ import annotations

import json
import os
import re
import sys

READ_PREFIXES = ("get-", "describe-", "list-", "validate-", "simulate-", "wait")
NO_VALUE_FLAGS = {"--no-cli-pager", "--no-paginate", "--no-sign-request", "--debug", "--no-verify-ssl",
                  "--no-cli-auto-prompt", "--cli-auto-prompt"}


MULTI = {"--alarm-names", "--action-names", "--resource-arns", "--context-entries", "--tag-filters",
         "--parameters", "--capabilities", "--tags", "--attribute-names", "--parameter-overrides",
         "--attributes", "--resource-type-filters", "--entries", "--alarm-types"}


def split_argv(argv: list[str]):
    """Return (service, op, options) where options maps --name -> list of values."""
    positional, opts = [], {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            if "=" in a:
                k, v = a.split("=", 1)
                opts.setdefault(k, []).append(v)
            elif a in NO_VALUE_FLAGS:
                opts.setdefault(a, [])
            else:
                vals = []
                while i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                    vals.append(argv[i + 1])
                    i += 1
                    if a not in MULTI:
                        break
                opts.setdefault(a, []).extend(vals)
        else:
            positional.append(a)
        i += 1
    service = positional[0] if positional else ""
    op = positional[1] if len(positional) > 1 else ""
    return service, op, opts


def read_files(argv: list[str]) -> dict:
    out = {}
    for a in argv:
        m = re.search(r"file(?:b)?://(\S+)", a)
        if m:
            path = m.group(1)
            try:
                with open(path, "rb") as f:
                    out[path] = f.read().decode("utf-8", "replace")
            except OSError:
                out[path] = ""
    return out


class UnsupportedQuery(Exception):
    pass


def query(data, expr: str):
    """Tiny JMESPath subset: a.b, a[].b, a[*].b, a[0], [a.b,c.d] (flat multiselect list). Deliberately NOT jmespath, so the verdict never
    depends on what is installed. Anything else (filters, pipes, functions, multiselect) raises."""
    if expr.startswith("[") and expr.endswith("]") and "." in expr:   # [a.b,c.d] multiselect list
        return [query(data, e.strip()) for e in expr[1:-1].split(",")]
    cur = data
    for part in expr.split("."):
        m = re.fullmatch(r"([A-Za-z0-9_]*)(\[(\*|\d*)\])?", part)
        if not m or not part:
            raise UnsupportedQuery(expr)
        name, brk, idx = m.group(1), m.group(2), m.group(3)
        if name:
            if isinstance(cur, list):
                cur = [c.get(name) for c in cur if isinstance(c, dict)]
            else:
                cur = cur.get(name) if isinstance(cur, dict) else None
        if brk:
            if idx in ("", "*"):
                cur = cur if isinstance(cur, list) else []
            else:
                cur = cur[int(idx)] if isinstance(cur, list) and int(idx) < len(cur) else None
    return cur


RECORD = None   # callable writing this call's log line exactly once; set by main()


def emit(data, opts, on_text=None):
    """Print the response. on_text(text) sees the exact stdout body (after --query) before it is printed."""
    q = (opts.get("--query") or [None])[0]
    fmt = (opts.get("--output") or ["json"])[0]
    if q:
        try:
            data = query(data, q)
        except UnsupportedQuery:
            if RECORD:
                RECORD()
            # Tests fail on this marker file even if the script under test swallows our non-zero exit.
            with open(os.environ["FAKE_AWS_LOG"] + ".unsupported-query", "a", encoding="utf-8") as f:
                f.write(q + "\n")
            sys.stderr.write(f"fake aws: unsupported --query expression: {q}\n")
            sys.exit(97)
    if fmt == "text":
        if data is None:
            text = "None"
        elif isinstance(data, (list, tuple)):
            text = "\t".join(str(x) for x in data)
        elif isinstance(data, dict):
            text = "\t".join(str(v) for v in data.values())
        else:
            text = str(data)
    else:
        text = json.dumps(data, ensure_ascii=False)
    if on_text:
        on_text(text)
    print(text)


def error(code: str, op: str, msg: str, rc: int = 254):
    if RECORD:
        RECORD()
    sys.stderr.write(f"\nAn error occurred ({code}) when calling the {op} operation: {msg}\n")
    sys.exit(rc)


REPLICA_KEY = "ASIAFAKEREPLICAKEY0001"
REPLICA_SECRET = "fakeReplicaSecretAccessKey+/0123456789ABCDEFGH"
REPLICA_TOKEN = "FwoGZXIvYXdzFAKEreplicaSESSIONtoken0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
REPLICA_NAME = "AlarmOpsRehearsal-WriterReplica"


def tags_list(d: dict):
    return [{"Key": k, "Value": v} for k, v in (d or {}).items()]


def parse_tags(vals):
    out = {}
    for v in vals or []:
        m = re.fullmatch(r"Key=([^,]+),Value=(.*)", v)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def _ctx_values(key, ctx):
    if key.startswith("aws:RequestTag/"):
        v = ctx["request_tags"].get(key.split("/", 1)[1])
        return [] if v is None else [v]
    if key.startswith("aws:ResourceTag/"):
        v = ctx["resource_tags"].get(key.split("/", 1)[1])
        return [] if v is None else [v]
    if key == "aws:TagKeys":
        return list(ctx["request_tags"])
    raise ValueError("fake aws: unsupported condition key " + key)


def _cond_ok(cond, ctx):
    for op, block in (cond or {}).items():
        mode, _, base = op.rpartition(":")
        if base != "StringEquals":
            raise ValueError("fake aws: unsupported condition operator " + op)
        for key, want in block.items():
            want = want if isinstance(want, list) else [want]
            have = _ctx_values(key, ctx)
            if mode == "ForAnyValue":
                ok = any(h in want for h in have)
            elif mode == "ForAllValues":
                ok = all(h in want for h in have)
            else:
                ok = bool(have) and all(h in want for h in have)
            if not ok:
                return False
    return True


def evaluate(policy, action, ctx):
    """True = allowed. Explicit Deny wins; no matching Allow = implicit deny."""
    import fnmatch

    stmts = policy.get("Statement", [])
    stmts = [stmts] if isinstance(stmts, dict) else stmts
    allowed = False
    for st in stmts:
        acts = st.get("Action", [])
        acts = [acts] if isinstance(acts, str) else acts
        if not any(fnmatch.fnmatch(action.lower(), a.lower()) for a in acts):
            continue
        if not _cond_ok(st.get("Condition"), ctx):
            continue
        if st.get("Effect") == "Deny":
            return False
        if st.get("Effect") == "Allow":
            allowed = True
    return allowed


def camel(op):
    return "".join(p.capitalize() for p in op.split("-"))


def replica_model(scen, service, op, opts, rec, account, first):
    """Stateful IAM/STS/CloudWatch model for replica-check.sh. Returns True when the call was handled."""
    sp = os.environ["FAKE_AWS_LOG"] + ".state"
    if os.path.exists(sp):
        with open(sp, encoding="utf-8") as f:
            st = json.load(f)
    else:
        st = {"roles": {k: {"boundary": v.get("boundary"), "policies": dict(v.get("policies") or {}),
                            "tags": dict(v.get("tags") or {}), "path": v.get("path") or "/"}
                      for k, v in scen["iam_roles"].items()},
              "alarms": {}, "alarm_cfg": {}, "assume_calls": 0}

    def save():
        with open(sp, "w", encoding="utf-8") as f:
            json.dump(st, f)

    key = f"{service} {op}"
    rname = first("--role-name")

    def need_role():
        if rname not in st["roles"]:
            error("NoSuchEntity", camel(op), f"The role with name {rname} cannot be found.")
        return st["roles"][rname]

    replica_call = "AWS_ACCESS_KEY_ID" in os.environ
    if replica_call:
        if (os.environ.get("AWS_ACCESS_KEY_ID"), os.environ.get("AWS_SECRET_ACCESS_KEY"),
                os.environ.get("AWS_SESSION_TOKEN")) != (REPLICA_KEY, REPLICA_SECRET, REPLICA_TOKEN):
            error("InvalidClientTokenId", camel(op), "The security token included in the request is invalid.")
        if REPLICA_NAME not in st["roles"]:
            error("ExpiredToken", camel(op), "The security token included in the request is expired")

    if key == "iam get-role":
        r = need_role()
        out = {"RoleName": rname, "Arn": f"arn:aws:iam::{account}:role/{r.get('path', '/').lstrip('/')}{rname}",
               "Tags": tags_list(r["tags"])}
        if r["boundary"]:
            out["PermissionsBoundary"] = {"PermissionsBoundaryType": "Policy", "PermissionsBoundaryArn": r["boundary"]}
        emit({"Role": out}, opts)
        return True
    if key == "iam get-role-policy":
        r = need_role()
        pn = first("--policy-name")
        if pn not in r["policies"]:
            error("NoSuchEntity", "GetRolePolicy", f"The role policy with name {pn} cannot be found.")
        emit({"RoleName": rname, "PolicyName": pn, "PolicyDocument": r["policies"][pn]}, opts)
        return True
    if key == "iam create-role":
        if rname in st["roles"]:
            error("EntityAlreadyExists", "CreateRole", f"Role with name {rname} already exists.")
        st["roles"][rname] = {"boundary": first("--permissions-boundary"), "policies": {},
                              "tags": parse_tags(opts.get("--tags"))}
        save()
        emit({"Role": {"RoleName": rname, "Arn": f"arn:aws:iam::{account}:role/{rname}"}}, opts)
        return True
    if key == "iam put-role-policy":
        r = need_role()
        doc = None
        for v in opts.get("--policy-document", []):
            m = re.fullmatch(r"file(?:b)?://(.*)", v)
            doc = json.loads(rec["files"][m.group(1)] if m else v)
        r["policies"][first("--policy-name")] = doc
        save()
        emit({}, opts)
        return True
    if key == "iam delete-role-policy":
        r = need_role()
        pn = first("--policy-name")
        if pn not in r["policies"]:
            error("NoSuchEntity", "DeleteRolePolicy", f"The role policy with name {pn} cannot be found.")
        del r["policies"][pn]
        save()
        emit({}, opts)
        return True
    if key == "iam delete-role":
        r = need_role()
        if r["policies"]:
            error("DeleteConflict", "DeleteRole", "Cannot delete entity, must delete policies first.")
        del st["roles"][rname]
        save()
        emit({}, opts)
        return True

    if key == "sts assume-role":
        st["assume_calls"] += 1
        save()
        arn_role = (first("--role-arn") or "").rsplit("/", 1)[-1]
        if st["assume_calls"] <= int(scen.get("assume_fail_first") or 0) or arn_role not in st["roles"]:
            error("AccessDenied", "AssumeRole", "not authorized to perform: sts:AssumeRole")
        doc = {"Credentials": {"AccessKeyId": REPLICA_KEY, "SecretAccessKey": REPLICA_SECRET,
                               "SessionToken": REPLICA_TOKEN, "Expiration": "2030-01-01T00:00:00Z"},
               "AssumedRoleUser": {"Arn": f"arn:aws:sts::{account}:assumed-role/{arn_role}/x"}}
        if scen.get("assume_crlf"):   # Windows aws.exe: every output line ends with CRLF
            import io

            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, newline="\r\n", write_through=True)
        emit(doc, opts)
        return True

    if service == "cloudwatch" and op in ("put-metric-alarm", "tag-resource", "delete-alarms", "describe-alarms",
                                          "list-tags-for-resource"):
        req = parse_tags(opts.get("--tags"))
        if op == "put-metric-alarm":
            names = [first("--alarm-name")]
        elif op == "delete-alarms":
            names = opts.get("--alarm-names", [])
        elif op == "describe-alarms":
            names = []
        else:
            names = [(first("--resource-arn") or "").split(":alarm:")[-1]]
        if replica_call:
            pol = {"Statement": [s for p in st["roles"][REPLICA_NAME]["policies"].values()
                                 for s in (p["Statement"] if isinstance(p["Statement"], list) else [p["Statement"]])]}
            for n in names or [None]:
                ctx = {"request_tags": req, "resource_tags": (st["alarms"].get(n) or {}) if n else {}}
                if not evaluate(pol, "cloudwatch:" + camel(op), ctx):
                    error("AccessDenied", camel(op), "User is not authorized to perform: cloudwatch:" + camel(op))
                if (op == "put-metric-alarm" and scen.get("cw_overwrite_unmanaged_denied") and n in st["alarms"]
                        and st["alarms"][n].get("ManagedBy") != "AlarmOps"):
                    error("AccessDenied", camel(op), "User is not authorized to perform: cloudwatch:" + camel(op))
        if op == "put-metric-alarm":
            st["alarms"].setdefault(names[0], {}).update(req)
            st["alarm_cfg"][names[0]] = {"Threshold": float(first("--threshold") or 0)}
        elif op == "tag-resource":
            if names[0] not in st["alarms"]:
                error("ResourceNotFound", "TagResource", "alarm not found")
            st["alarms"][names[0]].update(req)
        elif op == "delete-alarms":
            for n in names:
                st["alarms"].pop(n, None)
        elif op == "list-tags-for-resource":
            n = names[0]
            if n in st["alarms"]:
                emit({"Tags": tags_list(st["alarms"][n])}, opts)
                return True
            return False   # fall through to the scenario's static alarms
        elif op == "describe-alarms":
            want = opts.get("--alarm-names")
            if not want:
                return False
            emit({"MetricAlarms": [dict(AlarmName=n, **st["alarm_cfg"].get(n, {})) for n in want if n in st["alarms"]],
                  "CompositeAlarms": []}, opts)
            return True
        save()
        emit({}, opts)
        return True
    return False


def main() -> None:
    argv = sys.argv[1:]
    service, op, opts = split_argv(argv)
    scen = {}
    sp = os.environ.get("FAKE_AWS_SCENARIO")
    if sp and os.path.exists(sp):
        with open(sp, encoding="utf-8") as f:
            scen = json.load(f)
    stdin = ""
    try:
        import select

        if not sys.stdin.isatty() and select.select([sys.stdin], [], [], 0.2)[0]:
            stdin = sys.stdin.read()
    except (OSError, ValueError):  # select on pipes is POSIX-only; Windows runs skip stdin capture
        stdin = ""
    account = scen.get("account", "111111111111")
    is_read = op.startswith(READ_PREFIXES)
    # Which secret-echoing paths this call will take (lets tests prove the leak scenario really ran).
    echo = []
    if scen.get("leak") and service != "sts":
        echo.append("stderr-warning")
    if scen.get("fail_writes") and not is_read and service != "sts":
        echo.append("error-response")
    read_fail_ops = scen.get("fail_read_ops") or ["validate-template", "list-roles", "describe-trails"]
    fail_read = bool(scen.get("fail_reads")) and is_read and service != "sts" and op in read_fail_ops
    if fail_read:
        echo.append("error-response")
    secret = scen.get("leak") or scen.get("fail_writes") or scen.get("fail_reads")
    rec = {"argv": argv, "service": service, "op": op, "files": read_files(argv), "stdin": stdin, "echo": echo,
           "as_replica": "AWS_ACCESS_KEY_ID" in os.environ, "env_profile": "AWS_PROFILE" in os.environ}
    done = []

    def record():
        if not done:
            done.append(1)
            with open(os.environ["FAKE_AWS_LOG"], "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    global RECORD
    RECORD = record
    # describe-stacks is logged only once its real response body is known (see `mark` below).
    if (service, op) != ("cloudformation", "describe-stacks"):
        record()

    sleep_for = (scen.get("sleep_ops") or {}).get(f"{service} {op}")
    if sleep_for:
        import time

        open(os.environ["FAKE_AWS_LOG"] + ".sleeping", "w").close()
        time.sleep(float(sleep_for))

    if scen.get("leak") and service != "sts":
        sys.stderr.write(f"warning: request context ExternalId={scen['leak']}\n")
    if scen.get("fail_writes") and not is_read and service != "sts":
        error("AccessDenied", op, f"not allowed ({scen['fail_writes']})", 255)

    if fail_read:
        error("AccessDenied", op, f"not allowed ({scen['fail_reads']})", 255)
    nth = (scen.get("fail_nth") or {}).get(f"{service} {op}")
    if nth:   # the n-th call (1-based) of this operation fails
        cf = os.environ["FAKE_AWS_LOG"] + ".count-" + f"{service}-{op}"
        n = int(open(cf, encoding="utf-8").read() or 0) + 1 if os.path.exists(cf) else 1
        with open(cf, "w", encoding="utf-8") as f:
            f.write(str(n))
        if n == nth:
            error("InternalFailure", op, "simulated failure (nth)")
    if f"{service} {op}" in (scen.get("fail_ops") or []):
        error("InternalFailure", op, "simulated failure")

    key = f"{service} {op}"
    first = lambda name: (opts.get(name) or [None])[0]  # noqa: E731

    if key == "sts get-caller-identity":
        return emit({"UserId": "AIDAFAKE", "Account": account,
                     "Arn": scen.get("caller_arn") or f"arn:aws:sts::{account}:assumed-role/fake/rehearsal"}, opts)

    if "iam_roles" in scen and service in ("iam", "sts", "cloudwatch"):
        if replica_model(scen, service, op, opts, rec, account, first):
            return

    if key == "cloudformation describe-stacks":
        name = first("--stack-name")
        stacks = scen.get("stacks", [])
        if name:
            stacks = [s for s in stacks if s.get("StackName") == name]
            if not stacks:
                error("ValidationError", "DescribeStacks", f"Stack with id {name} does not exist")

        def mark(text):
            # Only a response body that really carries the secret counts as the describe-stacks echo path.
            if secret and secret in text:
                echo.append("describe-stacks")
            record()
        return emit({"Stacks": stacks}, opts, on_text=mark)
    if key == "cloudformation validate-template":
        return emit({"Parameters": []}, opts)
    if key in ("cloudformation create-stack", "cloudformation update-stack"):
        return emit({"StackId": f"arn:aws:cloudformation:ap-northeast-2:{account}:stack/x/1"}, opts)

    if key == "sqs create-queue":
        n = first("--queue-name") or "unknown"
        return emit({"QueueUrl": f"https://sqs.ap-northeast-2.amazonaws.com/{account}/{n}"}, opts)
    if key == "sqs list-queues":
        pre = first("--queue-name-prefix") or ""
        urls = [f"https://sqs.ap-northeast-2.amazonaws.com/{account}/{n}"
                for n in scen.get("queues", {}) if n.startswith(pre)]
        return emit({"QueueUrls": urls} if urls else {}, opts)
    if key == "sqs get-queue-url":
        n = first("--queue-name")
        if n not in scen.get("queues", {}):
            error("QueueDoesNotExist", "GetQueueUrl", "The specified queue does not exist.")
        return emit({"QueueUrl": f"https://sqs.ap-northeast-2.amazonaws.com/{account}/{n}"}, opts)
    if key == "sqs list-queue-tags":
        n = (first("--queue-url") or "").rsplit("/", 1)[-1]
        q = scen.get("queues", {}).get(n)
        if q is None:
            error("QueueDoesNotExist", "ListQueueTags", "The specified queue does not exist.")
        return emit({"Tags": q.get("tags", {})} if q.get("tags") else {}, opts)
    if key == "sqs get-queue-attributes":
        n = (first("--queue-url") or "").rsplit("/", 1)[-1]
        return emit({"Attributes": {"QueueArn": f"arn:aws:sqs:ap-northeast-2:{account}:{n}"}}, opts)

    if key == "cloudwatch describe-alarms":
        names = opts.get("--alarm-names")
        pre = first("--alarm-name-prefix")
        out = []
        for a in scen.get("alarms", []):
            if names and a["AlarmName"] not in names:
                continue
            if pre and not a["AlarmName"].startswith(pre):
                continue
            b = {k: v for k, v in a.items() if k != "tags"}
            b.setdefault("AlarmArn", f"arn:aws:cloudwatch:ap-northeast-2:{account}:alarm:{a['AlarmName']}")
            out.append(b)
        return emit({"MetricAlarms": out, "CompositeAlarms": []}, opts)
    if key == "cloudwatch list-tags-for-resource":
        arn = first("--resource-arn") or ""
        for a in scen.get("alarms", []):
            if arn.endswith(":alarm:" + a["AlarmName"]):
                return emit({"Tags": tags_list(a.get("tags"))}, opts)
        return emit({"Tags": []}, opts)

    if key == "resourcegroupstaggingapi get-resources":
        res = []
        for a in scen.get("alarms", []):
            res.append({"ResourceARN": f"arn:aws:cloudwatch:ap-northeast-2:{account}:alarm:{a['AlarmName']}",
                        "Tags": tags_list(a.get("tags"))})
        for n, q in scen.get("queues", {}).items():
            res.append({"ResourceARN": f"arn:aws:sqs:ap-northeast-2:{account}:{n}", "Tags": tags_list(q.get("tags"))})
        tf = " ".join(opts.get("--tag-filters", []))
        keys = re.findall(r'Key[=":\s]+([A-Za-z0-9_:/.-]+)', tf)
        vals = re.findall(r'Values?[=":\s\[]+([A-Za-z0-9_:/.,-]+)', tf)
        if keys:
            want = set((vals[0].split(",")) if vals else [])
            res = [r for r in res if any(t["Key"] == keys[0] and (not want or t["Value"] in want)
                                         for t in r["Tags"])]
        return emit({"ResourceTagMappingList": res}, opts)

    if key == "iam get-role":
        n = first("--role-name") or ""
        doc = (scen.get("role_trust") or {}).get(n) or {
            "Version": "2012-10-17",
            "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]}
        return emit({"Role": {"RoleName": n, "Arn": f"arn:aws:iam::{account}:role/{n}",
                              "AssumeRolePolicyDocument": doc}}, opts)
    if key == "iam list-role-policies":
        return emit({"PolicyNames": (scen.get("role_policies") or {}).get(first("--role-name") or "", [])}, opts)

    if key == "iam simulate-principal-policy":
        sim = scen.get("simulate", {"with_request_tag": "allowed", "without_request_tag": "implicitDeny"})
        blob = " ".join(argv) + " " + " ".join(rec["files"].values())
        with_tag = "aws:RequestTag/ManagedBy" in blob
        decision = sim["with_request_tag" if with_tag else "without_request_tag"]
        actions = opts.get("--action-names", []) or ["unknown"]
        arns = opts.get("--resource-arns", []) or ["*"]
        return emit({"EvaluationResults": [
            {"EvalActionName": a, "EvalResourceName": r, "EvalDecision": decision,
             "MatchedStatements": [], "MissingContextValues": []}
            for a in actions for r in arns]}, opts)

    if key == "cloudwatch get-metric-statistics":
        name = first("--metric-name") or ""
        spec = (scen.get("metric_sums") or {}).get(name)
        points = []
        if spec:
            counter = os.environ["FAKE_AWS_LOG"] + ".metric-" + name
            n = 0
            if os.path.exists(counter):
                with open(counter, encoding="utf-8") as f:
                    n = int(f.read() or 0)
            with open(counter, "w", encoding="utf-8") as f:
                f.write(str(n + 1))
            if not (spec.get("empty_first") and n == 0):   # empty_first: no datapoints on the first call
                points = [{"Sum": spec.get("start", 0) + spec.get("step", 0) * n}]
        return emit({"Label": "x", "Datapoints": points}, opts)

    # delete-*, tag-*, untag-*, wait, anything unknown: succeed quietly.
    if op.startswith(("delete-", "tag-", "untag-", "wait")) or key.endswith("deploy"):
        return emit({}, opts)
    return emit({}, opts)


if __name__ == "__main__":
    main()
