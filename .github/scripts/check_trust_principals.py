"""Trust-policy check for deploy-central.yml (step after apply). Standard library only; run as `python3 -I`.

  check_trust_principals.py <account-id> <vercel-oidc-provider-arn> <role-name>=<trust.json> ...

Each trust.json is the AssumeRolePolicyDocument of one role (`aws iam get-role --query Role.AssumeRolePolicyDocument`).
All three roles must be given. Each is compared with what central.yaml creates, exactly:

  AlarmOpsCentral-Engine            Principal Service == lambda.amazonaws.com only; Action sts:AssumeRole
  AlarmOpsCentral-RemediatorCaller  Principal AWS == the Engine role ARN of this account only; Action sts:AssumeRole
  AlarmOpsCentral-VercelConsole     Principal Federated == the provider ARN only; Action sts:AssumeRoleWithWebIdentity;
                                    Condition.StringEquals has <provider path>:aud and <provider path>:sub (values not checked)

Every statement must be Effect Allow with Action (a string or list) inside the role's allowed set. NotAction, NotPrincipal,
"*", empty lists/objects, other principal types, a second principal in the same statement and any value that is not an
exact (full) match are errors. A role without statements, or an unreadable file, is an error.

Prints a markdown table to stdout (for $GITHUB_STEP_SUMMARY) and `::error::` lines to stdout. Exit 1 if any error, 2 on usage.
"""
import json
import re
import sys

ENGINE = "AlarmOpsCentral-Engine"
CALLER = "AlarmOpsCentral-RemediatorCaller"
CONSOLE = "AlarmOpsCentral-VercelConsole"
PROVIDER_RE = re.compile(r"arn:(aws[a-z-]*):iam::\d{12}:oidc-provider/([A-Za-z0-9._/-]+)")


def _vals(v):
    """A principal/action value as a list of strings; None when it is empty or not made of strings."""
    out = v if isinstance(v, list) else [v]
    if not out or not all(isinstance(x, str) and x for x in out):
        return None
    return out


def expectations(account, provider):
    m = PROVIDER_RE.fullmatch(provider)
    part = m.group(1) if m else "aws"
    engine_arn = f"arn:{part}:iam::{account}:role/{ENGINE}"
    path = m.group(2) if m else None
    return {
        ENGINE: {"ptype": "Service", "expect": {"lambda.amazonaws.com"}, "actions": {"sts:AssumeRole"}},
        CALLER: {"ptype": "AWS", "expect": {engine_arn}, "actions": {"sts:AssumeRole"}},
        CONSOLE: {"ptype": "Federated", "expect": {provider} if m else set(),
                  "actions": {"sts:AssumeRoleWithWebIdentity"},
                  "cond_keys": [f"{path}:aud", f"{path}:sub"] if path else None},
    }


def check_document(doc, exp):
    """Return a list of (statement-index, principal-type, value, ok, reason)."""
    rows = []
    stmts = doc.get("Statement") if isinstance(doc, dict) else None
    if isinstance(stmts, dict):
        stmts = [stmts]
    if not isinstance(stmts, list) or not stmts:
        return [(0, "-", "-", False, "no Statement")]
    for i, st in enumerate(stmts):
        if not isinstance(st, dict):
            rows.append((i, "-", "-", False, "Statement is not an object"))
            continue
        bad = []
        if st.get("Effect") != "Allow":
            bad.append("Effect is not Allow")
        if "NotPrincipal" in st:
            bad.append("NotPrincipal is not allowed")
        if "NotAction" in st:
            bad.append("NotAction is not allowed")
        acts = _vals(st.get("Action")) if "Action" in st else None
        if acts is None:
            bad.append("missing or empty Action")
        elif not set(acts) <= exp["actions"]:
            bad.append("Action outside " + ",".join(sorted(exp["actions"])))
        if "cond_keys" in exp:
            se = (st.get("Condition") or {}).get("StringEquals") if isinstance(st.get("Condition"), dict) else None
            if exp["cond_keys"] is None or not isinstance(se, dict):
                bad.append("Condition.StringEquals missing")
            else:
                for k in exp["cond_keys"]:
                    if not _vals(se.get(k)):
                        bad.append(f"Condition.StringEquals lacks {k}")
        pr = st.get("Principal")
        if pr == "*":
            rows.append((i, "*", "*", False, "wildcard principal"))
        elif not isinstance(pr, dict) or not pr:
            rows.append((i, "-", "-", False, "empty or missing Principal"))
        elif set(pr) != {exp["ptype"]}:
            rows.append((i, ",".join(sorted(pr)), "-", False, f"only a {exp['ptype']} principal is expected"))
        else:
            vals = _vals(pr[exp["ptype"]])
            if vals is None:
                rows.append((i, exp["ptype"], "-", False, "empty or non-string principal list"))
            else:
                for v in vals:
                    ok = v in exp["expect"]
                    rows.append((i, exp["ptype"], v, ok, "expected principal" if ok else "not the expected principal"))
                if set(vals) != exp["expect"]:
                    rows.append((i, exp["ptype"], "-", False, "principal set differs from the expected one"))
        if bad:
            rows.append((i, "-", "-", False, "; ".join(bad)))
        elif not any(r[0] == i and not r[3] for r in rows):
            rows.append((i, "-", "-", True, "action and condition as expected"))
    return rows


def run(account, provider, items, out=sys.stdout):
    if not re.fullmatch(r"\d{12}", account):
        print("::error::account id is not 12 digits", file=out)
        return 1
    exps = expectations(account, provider)
    got = dict(items)
    table = ["## Trust policies after apply", "", "| Role | Stmt | Type | Principal | Result |", "|---|---|---|---|---|"]
    errors, failed = [], 0
    for role in exps:
        if role not in got:
            rows = [(0, "-", "-", False, "trust policy was not provided")]
        else:
            try:
                with open(got[role], encoding="utf-8") as f:
                    rows = check_document(json.load(f), exps[role])
            except (OSError, ValueError) as e:
                rows = [(0, "-", "-", False, f"cannot read trust policy ({type(e).__name__})")]
        for idx, ptype, val, ok, why in rows:
            table.append(f"| {role} | {idx} | {ptype} | `{val}` | {'ok' if ok else 'FAIL'}: {why} |")
            if not ok:
                failed += 1
                errors.append(f"::error::Trust policy of {role}, statement {idx}: {ptype} {val} - {why}")
    for role in got:
        if role not in exps:
            failed += 1
            errors.append(f"::error::unexpected role {role}")
    print("\n".join(table), file=out)
    for e in errors:
        print(e, file=out)
    return 1 if failed else 0


def main(argv):
    if len(argv) < 4:
        print("usage: check_trust_principals.py <account> <provider-arn> <role>=<file> ...", file=sys.stderr)
        return 2
    items = []
    for a in argv[3:]:
        label, sep, path = a.partition("=")
        if not sep or not label or not path:
            print(f"bad argument: {a}", file=sys.stderr)
            return 2
        items.append((label, path))
    return run(argv[1], argv[2], items)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
