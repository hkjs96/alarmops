"""Pre-deploy check for deploy-central.yml (before any AWS call). Standard library only; run as `python3 -I`.

  check_vercel_oidc_params.py <vercel-oidc-provider-arn> <team-slug> <project-name>

CloudFormation Rules cannot split strings, so the "provider path equals the team slug" check lives here.
  - Global provider (...:oidc-provider/oidc.vercel.com): nothing to compare.
  - Team provider (...:oidc-provider/oidc.vercel.com/<team>): <team> must equal the team slug exactly (case-sensitive).
Also rejects values the template patterns would reject, with a clearer message. Exit 1 on any error, 2 on usage.
"""
import re
import sys

PROVIDER_RE = re.compile(r"arn:aws[a-z-]*:iam::[0-9]{12}:oidc-provider/oidc\.vercel\.com(?:/([a-z0-9][a-z0-9-]{0,62}))?")
SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
PROJECT_RE = re.compile(r"[A-Za-z0-9._-]{1,100}")


def check(provider, slug, project):
    errors = []
    m = PROVIDER_RE.fullmatch(provider)
    if not m:
        errors.append("VERCEL_OIDC_PROVIDER_ARN is not an oidc.vercel.com provider ARN (Global or Team)")
    if not SLUG_RE.fullmatch(slug):
        errors.append("VERCEL_TEAM_SLUG must be lowercase letters, digits and hyphens (1-63 characters, not starting with a hyphen)")
    if not PROJECT_RE.fullmatch(project):
        errors.append("VERCEL_PROJECT_NAME has characters outside [A-Za-z0-9._-] or a bad length")
    if m and m.group(1) is not None and m.group(1) != slug:
        errors.append("the Team provider path in VERCEL_OIDC_PROVIDER_ARN does not equal VERCEL_TEAM_SLUG; "
                      "the role trust would name a team the provider does not issue for")
    return errors


def main(argv):
    if len(argv) != 4:
        print(__doc__)
        return 2
    errors = check(*argv[1:])
    for e in errors:
        print(f"::error::{e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
