import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "@/components/AccountMenu";
import { ShellContext, SIGN_OUT, type ShellApi } from "@/components/ShellContext";
import { signOutNow } from "./sign-out";
import { sameOriginPost } from "./auth/origin";

let submitted: HTMLFormElement[] = [];
beforeEach(() => {
  submitted = [];
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) { submitted.push(this); });
  sessionStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); document.querySelectorAll("form[data-sign-out]").forEach((f) => f.remove()); });

describe("QA 재점검 P2-A: Sign out signs out", () => {
  it("signOutNow removes the ao- keys and posts to /auth/sign-out from a form of its own", () => {
    sessionStorage.setItem("ao-draft:call-order:usr_haeun/iruda", "{}");
    sessionStorage.setItem("other", "kept");
    signOutNow();
    expect(Object.keys(sessionStorage)).toEqual(["other"]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.method).toBe("post");
    expect(new URL(submitted[0]!.action).pathname).toBe("/auth/sign-out");
    expect(submitted[0]!.parentElement).toBe(document.body);
  });

  const shellWith = (requestLeave: ShellApi["requestLeave"]) => ({ requestLeave } as unknown as ShellApi);
  it("without an unsaved edit, Sign out posts at once", () => {
    render(<ShellContext.Provider value={shellWith((go) => go())}><AccountMenu name="Haeun Kim" role="ADMIN" /></ShellContext.Provider>);
    fireEvent.click(screen.getByTestId("account"));
    fireEvent.click(screen.getByTestId("sign-out"));
    expect(submitted).toHaveLength(1);
  });

  it("with an unsaved edit the guard decides — and the choice still signs out after the menu has closed", () => {
    let pending: (() => void) | null = null;
    let asked: string | undefined;
    render(
      <ShellContext.Provider value={shellWith((go, to) => { pending = go; asked = to; })}>
        <AccountMenu name="Haeun Kim" role="ADMIN" />
        <button type="button" data-testid="guard-choice">Sign out without saving</button>
      </ShellContext.Provider>,
    );
    sessionStorage.setItem("ao-draft:call-order:usr_haeun/iruda", "{}");
    fireEvent.click(screen.getByTestId("account"));
    fireEvent.click(screen.getByTestId("sign-out"));
    expect(asked).toBe(SIGN_OUT);
    expect(submitted).toHaveLength(0); // asked first
    expect(sessionStorage.getItem("ao-draft:call-order:usr_haeun/iruda")).toBe("{}"); // and nothing is removed until it is answered
    // pressing the guard's button is a press outside the menu: the menu goes away (this is what lost the form before)
    fireEvent.pointerDown(screen.getByTestId("guard-choice"));
    expect(screen.queryByTestId("sign-out")).toBeNull();
    pending!();
    expect(submitted).toHaveLength(1);
    expect(sessionStorage.getItem("ao-draft:call-order:usr_haeun/iruda")).toBeNull();
  });
});

describe("security 재검토 권고 3: the sign-out origin check does not believe X-Forwarded-Host by itself", () => {
  const base = { origin: null, host: "console.example", forwardedHost: null, secFetchSite: null, proto: "https" };
  it("same origin passes; another origin, a null origin, another port do not", () => {
    expect(sameOriginPost({ ...base, origin: "https://console.example" }, {})).toBe(true);
    expect(sameOriginPost({ ...base, origin: "https://CONSOLE.example" }, {})).toBe(true);
    expect(sameOriginPost({ ...base, origin: "https://evil.example" }, {})).toBe(false);
    expect(sameOriginPost({ ...base, origin: "null" }, {})).toBe(false);
    expect(sameOriginPost({ ...base, origin: "https://console.example:8443" }, {})).toBe(false);
  });
  it("the reviewer's request — Origin: evil with X-Forwarded-Host: evil — is refused unless a trusted proxy is declared", () => {
    const forged = { ...base, origin: "https://evil.example", forwardedHost: "evil.example" };
    expect(sameOriginPost(forged, {})).toBe(false);
    expect(sameOriginPost(forged, { TRUSTED_PROXY: "0" })).toBe(false);
    expect(sameOriginPost(forged, { TRUSTED_PROXY: "true" })).toBe(false); // only the exact value "1"
  });
  it("TRUSTED_PROXY=1: the proxy's X-Forwarded-Host is what the browser addressed; Host is the fallback", () => {
    const viaProxy = { ...base, host: "console.internal:3107", origin: "https://console.example", forwardedHost: "console.example" };
    expect(sameOriginPost(viaProxy, {})).toBe(false);
    expect(sameOriginPost(viaProxy, { TRUSTED_PROXY: "1" })).toBe(true);
    expect(sameOriginPost({ ...viaProxy, forwardedHost: "console.example, inner.proxy" }, { TRUSTED_PROXY: "1" })).toBe(true);
    expect(sameOriginPost({ ...base, origin: "https://console.example" }, { TRUSTED_PROXY: "1" })).toBe(true);
    expect(sameOriginPost({ ...viaProxy, origin: "https://evil.example" }, { TRUSTED_PROXY: "1" })).toBe(false);
    // the request reached the console as http (no proxy said otherwise): an https Origin is not the same origin
    expect(sameOriginPost({ ...viaProxy, proto: "http" }, { TRUSTED_PROXY: "1" })).toBe(false);
  });
  it("Sec-Fetch-Site other than same-origin is refused, with or without Origin; neither header is let through", () => {
    expect(sameOriginPost({ ...base, secFetchSite: "cross-site" }, {})).toBe(false);
    expect(sameOriginPost({ ...base, secFetchSite: "same-site" }, {})).toBe(false);
    expect(sameOriginPost({ ...base, origin: "https://console.example", secFetchSite: "cross-site" }, {})).toBe(false);
    expect(sameOriginPost({ ...base, origin: "https://console.example", secFetchSite: "same-origin" }, {})).toBe(true);
    expect(sameOriginPost(base, {})).toBe(true);
  });
});

describe("security 재검토 3 권고 2: the origin is compared as scheme + host + port", () => {
  const http = { origin: null, host: "localhost:3142", forwardedHost: null, secFetchSite: null, proto: "http" };
  it("the reviewer's request — Origin: https://localhost:3142 to a console served over http — is refused", () => {
    expect(sameOriginPost({ ...http, origin: "https://localhost:3142" }, {})).toBe(false);
    expect(sameOriginPost({ ...http, origin: "http://localhost:3142" }, {})).toBe(true);
    // and the other way round: an http page is not the origin of an https console
    expect(sameOriginPost({ ...http, proto: "https", origin: "http://localhost:3142" }, {})).toBe(false);
    expect(sameOriginPost({ ...http, proto: "https:", origin: "https://localhost:3142" }, {})).toBe(true);
  });
  it("default ports are the same origin written two ways; any other port is another origin", () => {
    const tls = { ...http, host: "console.example", proto: "https" };
    expect(sameOriginPost({ ...tls, origin: "https://console.example:443" }, {})).toBe(true);
    expect(sameOriginPost({ ...tls, host: "console.example:443", origin: "https://console.example" }, {})).toBe(true);
    expect(sameOriginPost({ ...tls, origin: "https://console.example:444" }, {})).toBe(false);
    expect(sameOriginPost({ ...tls, proto: "http", host: "console.example:80", origin: "http://console.example" }, {})).toBe(true);
  });
  it("no scheme, an unknown scheme, or an Origin that is not a URL is refused", () => {
    expect(sameOriginPost({ ...http, origin: "http://localhost:3142", proto: null }, {})).toBe(false);
    expect(sameOriginPost({ ...http, origin: "ftp://localhost:3142", proto: "ftp" }, {})).toBe(false);
    expect(sameOriginPost({ ...http, origin: "not a url" }, {})).toBe(false);
  });
  it("CONSOLE_ORIGIN, when set, is the one origin that counts (TLS ends at a load balancer, the console sees http)", () => {
    const behindLb = { ...http, host: "console.example.com", proto: "http" };
    const env = { CONSOLE_ORIGIN: "https://console.example.com" };
    expect(sameOriginPost({ ...behindLb, origin: "https://console.example.com" }, {})).toBe(false); // without it: http ≠ https
    expect(sameOriginPost({ ...behindLb, origin: "https://console.example.com" }, env)).toBe(true);
    expect(sameOriginPost({ ...behindLb, origin: "http://console.example.com" }, env)).toBe(false);
    expect(sameOriginPost({ ...behindLb, origin: "https://console.example.com:8443" }, env)).toBe(false);
    expect(sameOriginPost({ ...behindLb, origin: "https://evil.example", forwardedHost: "evil.example", proto: "https" }, { ...env, TRUSTED_PROXY: "1" })).toBe(false);
    expect(sameOriginPost({ ...behindLb, origin: "https://console.example.com", secFetchSite: "cross-site" }, env)).toBe(false);
  });
});
