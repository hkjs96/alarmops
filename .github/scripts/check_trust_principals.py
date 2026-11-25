"""Trust-policy principal check for deploy-central.yml (step after apply). Standard library only; run as `python3 -I`.

  check_trust_principals.py <account-id> <vercel-oidc-provider-arn> <service,service,...> <label>=<trust.json> ...

Each trust.json is the AssumeRolePolicyDocument of one role (`aws iam get-role --query Role.AssumeRolePolicyDocument`).
Every Statement's Principal must be made only of:
  - AWS: a role ARN of this account (arn:<partition>:iam::<account-id>:role/...); not :root, not a user
  - Service: one of the allowed services                               (the ones central.yaml uses)
  - Federated: exactly the Vercel OIDC provider ARN
Anything else is an error: "*", NotPrincipal, an empty Principal, another account, an unknown service, a unique ID
(AROA... shows up when a trusted principal was deleted), another federated provider, an unknown principal type.

Prints a markdown table to stdout (for $GITHUB_STEP_SUMMARY) and `::error::` lines to stdout. Exit 1 if any error.
"""
import json
import re
import sys


def _as_list(v):
    return v if isinstance(v, list) else [v]


def check_document(doc, account, provider, services):
    """Return a list of (statement-index, principal-type, value, ok, reason) rows."""
    rows = []
    stmts = doc.get("Statement") if isinstance(doc, dict) else None
    if isinstance(stmts, dict):
        stmts = [stmts]
    if not isinstance(stmts, list) or not stmts:
        return [(0, "-", "-", False, "no Statement")]
    # a role of this account only: ":root" (or a user) would let any IAM identity of the account with sts:AssumeRole in.
    same_acct = re.compile(r"^arn:aws[a-z-]*:iam::" + re.escape(account) + r":role/[\w+=,.@/-]+$")
    for i, st in enumerate(stmts):
        if not isinstance(st, dict):
            rows.append((i, "-", "-", False, "Statement is not an object"))
            continue
        if "NotPrincipal" in st:
            rows.append((i, "NotPrincipal", "-", False, "NotPrincipal is not allowed"))
            continue
        pr = st.get("Principal")
        if pr == "*":
            rows.append((i, "*", "*", False, "wildcard principal"))
            continue
        if not isinstance(pr, dict) or not pr:
            rows.append((i, "-", "-", False, "empty or missing Principal"))
            continue
        for ptype, vals in pr.items():
            for v in _as_list(vals):
                if not isinstance(v, str):
                    rows.append((i, ptype, str(v), False, "not a string"))
                elif ptype == "AWS":
                    ok = bool(same_acct.match(v))
                    rows.append((i, ptype, v, ok, "role of this account" if ok else "not a role ARN of this account (root, user, other account)"))
                elif ptype == "Service":
                    ok = v in services
                    rows.append((i, ptype, v, ok, "allowed service" if ok else "service not used by the templates"))
                elif ptype == "Federated":
                    ok = bool(provider) and v == provider
                    rows.append((i, ptype, v, ok, "Vercel OIDC provider" if ok else "not the Vercel OIDC provider"))
                else:
                    rows.append((i, ptype, v, False, "unknown principal type"))
    return rows


def run(account, provider, services, items, out=sys.stdout):
    if not re.fullmatch(r"\d{12}", account):
        print("::error::account id is not 12 digits", file=out)
        return 1
    failed = 0
    table = ["## Trust principals after apply", "", "| Role | Stmt | Type | Principal | Result |", "|---|---|---|---|---|"]
    errors = []
    for label, path in items:
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError) as e:
            rows = [(0, "-", "-", False, f"cannot read trust policy ({type(e).__name__})")]
        else:
            rows = check_document(doc, account, provider, services)
        for idx, ptype, val, ok, why in rows:
            table.append(f"| {label} | {idx} | {ptype} | `{val}` | {'ok' if ok else 'FAIL'}: {why} |")
            if not ok:
                failed += 1
                errors.append(f"::error::Trust policy of {label}, statement {idx}: {ptype} {val} - {why}")
    print("\n".join(table), file=out)
    for e in errors:
        print(e, file=out)
    return 1 if failed else 0


def main(argv):
    if len(argv) < 5:
        print("usage: check_trust_principals.py <account> <provider-arn> <services> <label>=<file> ...", file=sys.stderr)
        return 2
    account, provider, services = argv[1], argv[2], {s for s in argv[3].split(",") if s}
    items = []
    for a in argv[4:]:
        label, sep, path = a.partition("=")
        if not sep or not label or not path:
            print(f"bad argument: {a}", file=sys.stderr)
            return 2
        items.append((label, path))
    return run(account, provider, services, items)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
