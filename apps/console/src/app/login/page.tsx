import { redirect } from "next/navigation";
import { isMock } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { liveDevLogin } from "@/lib/mode";
import { safeNextPath } from "@/lib/safe-next";
import { isEndedFlag } from "@/lib/auth/ended-flags";

/** Google SSO placeholder (DECISIONS 이전 원칙 1: app-level Google SSO, no Supabase Auth). Not wired yet. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; ended?: string | string[] }> }) {
  const { next, ended } = await searchParams;
  // ?ended=1 (fixed flag from /auth/ended or a refused dev login): one calm line, nothing about why (no customer status)
  const endedNotice = isEndedFlag(ended);
  const mock = isMock();
  const live = !mock && liveDevLogin();
  const safe = safeNextPath(next, ""); // anything that is not a path on this origin is dropped (security S-3)
  // QA P3-M: signed in again in another tab, then "Sign in" here — go straight back instead of showing this page once more
  if (await getSession().catch(() => null)) redirect(safe || "/incidents");
  const devHref = "/auth/dev-login" + (safe ? `?next=${encodeURIComponent(safe)}` : "");
  return (
    <div className="page" style={{ maxWidth: 420, paddingTop: 72 }}>
      <div className="card">
        <div className="card-b" style={{ padding: 28 }}>
          <div className="logo" style={{ marginBottom: 18 }}><i />AlarmOps</div>
          <h1 style={{ fontSize: 22, margin: "0 0 6px", fontWeight: 600 }}>Sign in</h1>
          {endedNotice ? (
            <p className="note" role="status" data-testid="login-ended" style={{ margin: "0 0 16px", overflowWrap: "anywhere" }}>
              You were signed out. If you can&apos;t sign back in, contact your administrator.
            </p>
          ) : null}
          <p className="sm mut" style={{ margin: "0 0 20px" }}>Use your company Google account.</p>
          <button type="button" className="btn lg" style={{ width: "100%" }} disabled aria-describedby="sso-note">
            Continue with Google
          </button>
          <p id="sso-note" className="xs mut" style={{ marginTop: 12 }}>
            Google SSO is not connected in this build.{" "}
            {mock ? (
              <>Mock mode: <a href={devHref}>sign in as Haeun Kim (dev) →</a>{" "}
                <span className="mut">or as{" "}
                  <a href={devHref + (safe ? "&" : "?") + "as=operator"}>an operator</a> / <a href={devHref + (safe ? "&" : "?") + "as=viewer"}>a viewer</a></span></>
            ) : live ? (
              <>Live dev mode: <a href={devHref}>sign in as Demo Admin (dev) →</a>{" "}
                <span className="mut">or as <a href={devHref + (safe ? "&" : "?") + "as=operator"}>an operator</a> / <a href={devHref + (safe ? "&" : "?") + "as=viewer"}>a viewer</a></span></>
            ) : "Sign-in is unavailable until SSO is configured."}
          </p>
        </div>
      </div>
    </div>
  );
}
