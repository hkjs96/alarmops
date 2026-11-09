import { isMock } from "@/lib/api";

/** Google SSO placeholder (DECISIONS 이전 원칙 1: app-level Google SSO, no Supabase Auth). Not wired yet. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const mock = isMock();
  const devHref = "/auth/dev-login" + (next ? `?next=${encodeURIComponent(next)}` : "");
  return (
    <div className="page" style={{ maxWidth: 420, paddingTop: 72 }}>
      <div className="card">
        <div className="card-b" style={{ padding: 28 }}>
          <div className="logo" style={{ marginBottom: 18 }}><i />AlarmOps</div>
          <h1 style={{ fontSize: 22, margin: "0 0 6px", fontWeight: 600 }}>Sign in</h1>
          <p className="sm mut" style={{ margin: "0 0 20px" }}>Use your company Google account.</p>
          <button type="button" className="btn lg" style={{ width: "100%" }} disabled aria-describedby="sso-note">
            Continue with Google
          </button>
          <p id="sso-note" className="xs mut" style={{ marginTop: 12 }}>
            Google SSO is not connected in this build.{" "}
            {mock ? <>Mock mode: <a href={devHref}>sign in as Haeun Kim (dev) →</a></> : "Sign-in is unavailable until SSO is configured."}
          </p>
        </div>
      </div>
    </div>
  );
}
