import { redirect } from "next/navigation";
import { isMock } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { liveDevLogin } from "@/lib/mode";
import { safeNextPath } from "@/lib/safe-next";
import { isEndedFlag } from "@/lib/auth/ended-flags";
import { ssoConfig } from "@/lib/auth/sso-config";

const DEV_LIST = { display: "flex", flexDirection: "column" } as const;
const DEV_LINK = { display: "flex", alignItems: "center", minHeight: 44 } as const;

const SSO_NOTICE: Record<string, string> = {
  refused: "This Google account can't sign in to AlarmOps. If you think it should, contact the person who gave you access.",
  failed: "Sign-in didn't complete. Try again.",
  unavailable: "Google sign-in is unavailable right now. Contact your administrator.",
};

/** Sign-in page: app-level Google SSO (DECISIONS 개발 원칙 1, D-55; routes in app/auth/google), plus the dev links where they are allowed. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; ended?: string | string[]; sso?: string | string[] }> }) {
  const { next, ended, sso } = await searchParams;
  // ?sso=refused|failed|unavailable: fixed keys only, the text is ours; one calm line for every identity reason
  const ssoNotice = typeof sso === "string" && Object.hasOwn(SSO_NOTICE, sso) ? SSO_NOTICE[sso] : null;
  const ssoReady = ssoConfig().ok;
  // ?ended=1 (fixed flag from /auth/ended or a refused dev login): one calm line, nothing about why (no customer status)
  const endedNotice = isEndedFlag(ended);
  const mock = isMock();
  const live = !mock && liveDevLogin();
  const safe = safeNextPath(next, ""); // anything that is not a path on this origin is dropped (security S-3)
  // QA P3-M: signed in again in another tab, then "Sign in" here — go straight back instead of showing this page once more
  if (await getSession().catch(() => null)) redirect(safe || "/incidents");
  const googleHref = "/auth/google/start" + (safe ? `?next=${encodeURIComponent(safe)}` : "");
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
          <p className="sm mut" style={{ margin: "0 0 20px" }}>Use your Google account.</p>
          {ssoNotice ? (
            <p className="banner red" role="alert" data-testid="login-sso-notice" style={{ margin: "0 0 16px", overflowWrap: "anywhere" }}>{ssoNotice}</p>
          ) : null}
          {ssoReady ? (
            <a href={googleHref} className="btn pri lg" data-testid="sign-in-google" style={{ width: "100%", minHeight: 44 }}>Sign in with Google</a>
          ) : (
            <button type="button" className="btn lg" style={{ width: "100%", minHeight: 44 }} disabled aria-describedby="sso-note">Sign in with Google</button>
          )}
          <p id="sso-note" className="xs mut" style={{ marginTop: 12 }}>
            {ssoReady || sso === "unavailable" ? null : <>Google sign-in is not set up in this environment.{" "}</>}
            {mock ? (
              <>Mock mode: <span className="dev-links" style={DEV_LIST}>
                  <a href={devHref} style={DEV_LINK}>Sign in as Haeun Kim (dev) →</a>
                  <a href={devHref + (safe ? "&" : "?") + "as=operator"} style={DEV_LINK}>Sign in as an operator (dev)</a>
                  <a href={devHref + (safe ? "&" : "?") + "as=viewer"} style={DEV_LINK}>Sign in as a viewer (dev)</a></span></>
            ) : live ? (
              <>Live dev mode: <span className="dev-links" style={DEV_LIST}>
                  <a href={devHref} style={DEV_LINK}>Sign in as Demo Admin (dev) →</a>
                  <a href={devHref + (safe ? "&" : "?") + "as=operator"} style={DEV_LINK}>Sign in as an operator (dev)</a>
                  <a href={devHref + (safe ? "&" : "?") + "as=viewer"} style={DEV_LINK}>Sign in as a viewer (dev)</a></span></>
            ) : ssoReady || sso === "unavailable" ? null : "Sign-in is unavailable until Google sign-in is configured."}
          </p>
        </div>
      </div>
    </div>
  );
}
