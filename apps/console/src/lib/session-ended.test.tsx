// QA 최종 점검 P2-D · security 재검토 3 권고 1·4: a tab whose session is gone fails visibly, for every server action.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen } from "@testing-library/react";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEnded, signInHref } from "@/components/SessionEnded";
import { middleware } from "@/middleware";
import type { ActionResult } from "./action-result";
import { DEV_USER, SESSION_COOKIE, signSession } from "./auth/session";
import { errorText } from "./errors";
import {
  AUTH_CHANNEL, NO_ANSWER, SESSION_ENDED, SESSION_ENDED_EVENT, SESSION_ENDED_TEXT, SIGNED_OUT_KEY, announceSessionEnded, broadcastSignOut, callAction,
  onOtherTabSignOut, resetSessionEnded, sessionEndReason,
} from "./session-ended";
import { signOutNow } from "./sign-out";

beforeEach(() => { resetSessionEnded(); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); document.querySelectorAll("form[data-sign-out]").forEach((f) => f.remove()); });

const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const never = () => Promise.resolve(false);
const gone = () => Promise.resolve(true);

describe("callAction: the one way the page calls a server action", () => {
  it("passes a result through, success or refusal, and says nothing about the session", async () => {
    expect(await callAction(() => Promise.resolve(ok({ version: 3 })), never)).toEqual({ ok: true, data: { version: 3 } });
    const conflict: ActionResult = { ok: false, code: "VERSION_CONFLICT", message: "x", requestId: "r1" };
    expect(await callAction(() => Promise.resolve(conflict), never)).toBe(conflict);
    expect(sessionEndReason()).toBeNull();
  });

  it("the middleware's 401 — the action call throws with the body SESSION_ENDED — settles as a failure, and the tab is told", async () => {
    const heard = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, heard);
    const probe = vi.fn(never);
    const r = await callAction<null>(() => Promise.reject(new Error(SESSION_ENDED)), probe);
    window.removeEventListener(SESSION_ENDED_EVENT, heard);
    expect(r).toEqual({ ok: false, code: SESSION_ENDED, message: "Your session ended — sign in again. Nothing was changed.", requestId: "" });
    expect(probe).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(sessionEndReason()).toBe("expired");
  });

  it("the old failure — a redirect to /login, which Next throws as 'An unexpected response…' — is recognised by asking /auth/session", async () => {
    const r = await callAction<null>(() => Promise.reject(new Error("An unexpected response was received from the server.")), gone);
    expect(r.ok === false && r.code).toBe(SESSION_ENDED);
    expect(sessionEndReason()).toBe("expired");
  });

  it("the action itself found no session (UNAUTHORIZED), or the API refused the token (UNAUTHENTICATED): the same", async () => {
    for (const code of ["UNAUTHORIZED", "UNAUTHENTICATED"]) {
      resetSessionEnded();
      const r = await callAction<null>(() => Promise.resolve({ ok: false, code, message: "Sign in required.", requestId: "" }), never);
      expect(r.ok === false && r.code, code).toBe(SESSION_ENDED);
      expect(sessionEndReason(), code).toBe("expired");
    }
  });

  it("no answer with the session still there is NO_ANSWER: it settles, and does not claim that nothing was changed", async () => {
    const r = await callAction<null>(() => Promise.reject(new TypeError("Failed to fetch")), never);
    expect(r.ok === false && r.code).toBe(NO_ANSWER);
    expect(errorText(r as { code: string; message: string })).toMatch(/not known whether this was applied/);
    expect(sessionEndReason()).toBeNull();
    const none = await callAction<null>(() => Promise.resolve(undefined as unknown as ActionResult<null>), never);
    expect(none.ok === false && none.code).toBe(NO_ANSWER);
  });

  it("once the session is known to be over nothing more is sent", async () => {
    announceSessionEnded("expired");
    const send = vi.fn(() => Promise.resolve(ok(null)));
    const r = await callAction(send, never);
    expect(send).not.toHaveBeenCalled();
    expect(r.ok === false && r.code).toBe(SESSION_ENDED);
  });

  it("the default probe: 401 from /auth/session means gone; 204 or no network does not", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await callAction<null>(() => Promise.reject(new Error("boom")))).ok === false).toBe(true);
    expect(sessionEndReason()).toBe("expired");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/auth/session");
    resetSessionEnded();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const r = await callAction<null>(() => Promise.reject(new Error("boom")));
    expect(r.ok === false && r.code).toBe(NO_ANSWER);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const r2 = await callAction<null>(() => Promise.reject(new Error("boom")));
    expect(r2.ok === false && r2.code).toBe(NO_ANSWER);
    expect(sessionEndReason()).toBeNull();
  });

  it("the words are the same wherever the failure is shown", () => {
    for (const code of [SESSION_ENDED, "UNAUTHORIZED", "UNAUTHENTICATED"]) expect(errorText({ code, message: "" })).toBe(SESSION_ENDED_TEXT);
    expect(SESSION_ENDED_TEXT).toBe("Your session ended — sign in again. Nothing was changed.");
  });
});

describe("every server action goes through callAction", () => {
  const SRC = join(process.cwd(), "src");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  const actionFiles = files.filter((f) => /^\s*["']use server["']/.test(readFileSync(f, "utf8")));
  const names = actionFiles.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/^export async function (\w+)/gm)].map((m) => m[1]!));

  it("finds the actions (ack, resolve, escalate, bulk, undo, call-order save, own steps, Responders)", () => {
    expect(names.sort()).toEqual([
      "ackIncident", "addResponder", "escalateIncident", "executeBulk", "previewBulk", "removeOwnSteps", "removeResponder", "resolveIncident", "saveCallOrder", "setResponderRole", "undoBulk",
    ]);
  });
  it("no client file calls one of them outside callAction(() => …)", () => {
    const bare: string[] = [];
    const clients = files.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(clients.length).toBeGreaterThan(5);
    for (const f of clients) {
      const text = readFileSync(f, "utf8");
      text.split("\n").forEach((line, n) => {
        if (/^\s*(import|export)\b/.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const name of names) {
          if (new RegExp(`\\b${name}\\(`).test(line) && !/callAction\(\(\) => /.test(line)) bare.push(`${f.slice(SRC.length + 1)}:${n + 1} ${name}`);
        }
      });
    }
    expect(bare).toEqual([]);
  });
});

describe("middleware: a server action without a session is answered 401 SESSION_ENDED, not redirected", () => {
  const url = "http://localhost:3107/c/iruda/call-order";
  beforeEach(() => { vi.stubEnv("MOCK_API", "1"); vi.stubEnv("NODE_ENV", "test"); });
  it("POST with Next-Action and no cookie: 401, text/plain, the marker — what Next's client throws as the error message", async () => {
    const res = await middleware(new NextRequest(url, { method: "POST", headers: { "next-action": "abc123" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe(SESSION_ENDED);
  });
  it("an expired or forged cookie is no session either", async () => {
    const expired = await signSession({ ...DEV_USER, exp: Math.floor(Date.now() / 1000) - 10 }, "alarmops-dev-only-session-secret");
    for (const cookie of [expired, "forged.token"]) {
      const res = await middleware(new NextRequest(url, { method: "POST", headers: { "next-action": "abc123", cookie: `${SESSION_COOKIE}=${cookie}` } }));
      expect(res.status, cookie).toBe(401);
    }
  });
  it("a page request without a session still goes to /login?next=…, and a valid session passes", async () => {
    const page = await middleware(new NextRequest(url));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get("location")!).pathname + new URL(page.headers.get("location")!).search).toBe("/login?next=%2Fc%2Firuda%2Fcall-order");
    const valid = await signSession({ ...DEV_USER, exp: Math.floor(Date.now() / 1000) + 600 }, "alarmops-dev-only-session-secret");
    const res = await middleware(new NextRequest(url, { method: "POST", headers: { "next-action": "abc123", cookie: `${SESSION_COOKIE}=${valid}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
  it("/auth/session is public (it is asked when there may be no session)", async () => {
    const res = await middleware(new NextRequest("http://localhost:3107/auth/session"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("the session-ended state on the screen", () => {
  const draftKey = "ao-draft:call-order:usr-haeun/iruda";
  it("an action that came back SESSION_ENDED: the sentence, Sign in back to this address, and the draft is still there", async () => {
    window.history.replaceState(null, "", "/c/iruda/call-order?customer=iruda");
    sessionStorage.setItem(draftKey, "{}");
    render(<SessionEnded />);
    expect(screen.queryByTestId("session-ended")).toBeNull();
    await act(async () => { await callAction<null>(() => Promise.reject(new Error(SESSION_ENDED)), never); });
    const box = screen.getByTestId("session-ended");
    expect(box.getAttribute("role")).toBe("alertdialog");
    expect(box.querySelector("h3")!.textContent).toBe("Your session ended — sign in again. Nothing was changed.");
    const link = screen.getByTestId("session-sign-in") as HTMLAnchorElement;
    expect(link.textContent).toBe("Sign in");
    expect(link.getAttribute("href")).toBe("/login?next=%2Fc%2Firuda%2Fcall-order%3Fcustomer%3Diruda");
    expect(document.activeElement).toBe(link);
    expect(sessionStorage.getItem(draftKey)).toBe("{}");
    expect(box.querySelectorAll("button")).toHaveLength(0); // nothing closes it but signing in
  });

  it("sign-out in another tab (BroadcastChannel or the storage event): this tab's ao- keys go and it says so", () => {
    sessionStorage.setItem(draftKey, "{}");
    sessionStorage.setItem("other", "kept");
    render(<SessionEnded />);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: SIGNED_OUT_KEY, newValue: "1731300000000" })); });
    expect(screen.getByTestId("session-ended").getAttribute("data-reason")).toBe("signed-out");
    expect(screen.getByTestId("session-ended").textContent).toContain("You signed out in another tab — sign in again.");
    expect(screen.getByTestId("session-ended").textContent).toContain("drafts kept in this tab were removed");
    expect(sessionStorage.getItem(draftKey)).toBeNull();
    expect(sessionStorage.getItem("other")).toBe("kept");
    expect(sessionEndReason()).toBe("signed-out");
  });

  it("an unrelated storage event, or the key being removed, changes nothing", () => {
    sessionStorage.setItem(draftKey, "{}");
    render(<SessionEnded />);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "ao-theme", newValue: "dark" }));
      window.dispatchEvent(new StorageEvent("storage", { key: SIGNED_OUT_KEY, newValue: null }));
    });
    expect(screen.queryByTestId("session-ended")).toBeNull();
    expect(sessionStorage.getItem(draftKey)).toBe("{}");
  });

  it("the Sign in address is a path on this origin, whatever the address bar holds", () => {
    expect(signInHref({ pathname: "/incidents", search: "", hash: "" })).toBe("/login?next=%2Fincidents");
    expect(signInHref({ pathname: "/c/daon/call-order", search: "?mine=1", hash: "#x" })).toBe("/login?next=%2Fc%2Fdaon%2Fcall-order%3Fmine%3D1%23x");
    expect(signInHref({ pathname: "//evil.example/x", search: "", hash: "" })).toBe("/login");
    expect(signInHref({ pathname: "/", search: "", hash: "" })).toBe("/login");
  });
});

describe("sign-out tells the other tabs", () => {
  it("signOutNow posts on the ao-auth channel and stamps localStorage, before the form goes", () => {
    const posted: unknown[] = [];
    class FakeChannel { constructor(public name: string) {} postMessage(m: unknown) { posted.push([this.name, m]); } close() {} }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const order: string[] = [];
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => { order.push(`submit after ${posted.length} message`); });
    signOutNow();
    vi.unstubAllGlobals();
    expect(posted).toEqual([[AUTH_CHANNEL, { type: "signed-out" }]]);
    expect(Number(localStorage.getItem(SIGNED_OUT_KEY))).toBeGreaterThan(0);
    expect(order).toEqual(["submit after 1 message"]);
  });
  it("a browser without BroadcastChannel still signs out, and still stamps localStorage", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => broadcastSignOut()).not.toThrow();
    const cb = vi.fn();
    const off = onOtherTabSignOut(cb);
    window.dispatchEvent(new StorageEvent("storage", { key: SIGNED_OUT_KEY, newValue: "1" }));
    off();
    window.dispatchEvent(new StorageEvent("storage", { key: SIGNED_OUT_KEY, newValue: "2" }));
    vi.unstubAllGlobals();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SIGNED_OUT_KEY)).not.toBeNull();
  });
  it("a message on the channel reaches the listener; other messages do not", () => {
    const made: { onmessage: ((e: MessageEvent) => void) | null }[] = [];
    class FakeChannel { onmessage: ((e: MessageEvent) => void) | null = null; constructor() { made.push(this); } postMessage() {} close() {} }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const cb = vi.fn();
    const off = onOtherTabSignOut(cb);
    made[0]!.onmessage!({ data: { type: "something-else" } } as MessageEvent);
    made[0]!.onmessage!({ data: null } as MessageEvent);
    expect(cb).not.toHaveBeenCalled();
    made[0]!.onmessage!({ data: { type: "signed-out" } } as MessageEvent);
    off();
    vi.unstubAllGlobals();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
