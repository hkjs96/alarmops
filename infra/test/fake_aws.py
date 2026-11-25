#!/usr/bin/env python3
"""Fake `aws` CLI used by test_rehearsal_*.py (test support, not a test module).

Every invocation is appended as one JSON line to $FAKE_AWS_LOG. Responses come from the
JSON scenario file $FAKE_AWS_SCENARIO. Nothing here talks to a network.

Recorded fields per call: argv, service, op, files (contents of every `file://` / `fileb://`
argument, read at call time), stdin (when piped).

Scenario keys (all optional):
  account            sts get-caller-identity Account
  stacks             [{StackName, StackStatus, Tags:[{Key,Value}], Parameters:[...], ...}]
  queues             {name: {"tags": {k: v}}}
  alarms             [{AlarmName, Namespace, MetricName, Dimensions:[{Name,Value}], "tags": {k: v}}]
  simulate           {"with_request_tag": "allowed", "without_request_tag": "implicitDeny"}
  leak               string echoed into stderr of every non-sts call (a secret leaking via warnings)
  fail_writes        message; every non-read operation exits 255 with it in the error text
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


def query(data, expr: str):
    """Tiny JMESPath subset: a.b, a[].b, a[*].b, a[0]. Uses jmespath when installed."""
    try:
        import jmespath  # type: ignore

        return jmespath.search(expr, data)
    except ImportError:
        pass
    cur = data
    for part in re.findall(r"[^.]+", expr):
        m = re.fullmatch(r"([A-Za-z0-9_]*)(\[(\*|\d*)\])?", part)
        if not m:
            return data
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


def emit(data, opts):
    q = (opts.get("--query") or [None])[0]
    fmt = (opts.get("--output") or ["json"])[0]
    if q:
        data = query(data, q)
    if fmt == "text":
        if data is None:
            print("None")
        elif isinstance(data, (list, tuple)):
            print("\t".join(str(x) for x in data))
        elif isinstance(data, dict):
            print("\t".join(str(v) for v in data.values()))
        else:
            print(data)
    else:
        print(json.dumps(data, ensure_ascii=False))


def error(code: str, op: str, msg: str, rc: int = 254):
    sys.stderr.write(f"\nAn error occurred ({code}) when calling the {op} operation: {msg}\n")
    sys.exit(rc)


def tags_list(d: dict):
    return [{"Key": k, "Value": v} for k, v in (d or {}).items()]


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
    rec = {"argv": argv, "service": service, "op": op, "files": read_files(argv), "stdin": stdin}
    with open(os.environ["FAKE_AWS_LOG"], "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    account = scen.get("account", "111111111111")
    is_read = op.startswith(READ_PREFIXES)

    if scen.get("leak") and service != "sts":
        sys.stderr.write(f"warning: request context ExternalId={scen['leak']}\n")
    if scen.get("fail_writes") and not is_read and service != "sts":
        error("AccessDenied", op, f"not allowed ({scen['fail_writes']})", 255)

    key = f"{service} {op}"
    first = lambda name: (opts.get(name) or [None])[0]  # noqa: E731

    if key == "sts get-caller-identity":
        return emit({"UserId": "AIDAFAKE", "Account": account,
                     "Arn": f"arn:aws:sts::{account}:assumed-role/fake/rehearsal"}, opts)

    if key == "cloudformation describe-stacks":
        name = first("--stack-name")
        stacks = scen.get("stacks", [])
        if name:
            stacks = [s for s in stacks if s.get("StackName") == name]
            if not stacks:
                error("ValidationError", "DescribeStacks", f"Stack with id {name} does not exist")
        return emit({"Stacks": stacks}, opts)
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
        return emit({"Label": "x", "Datapoints": []}, opts)

    # delete-*, tag-*, untag-*, wait, anything unknown: succeed quietly.
    if op.startswith(("delete-", "tag-", "untag-", "wait")) or key.endswith("deploy"):
        return emit({}, opts)
    return emit({}, opts)


if __name__ == "__main__":
    main()
