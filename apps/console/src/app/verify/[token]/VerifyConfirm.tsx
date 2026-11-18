"use client";
import { useState } from "react";
import type { VerifyChannel } from "@/lib/api/types";
import { confirmVerificationAction } from "./actions";

const WHAT: Record<VerifyChannel, string> = { EMAIL: "e-mail address", SMS: "phone number", SLACK: "Slack account" };

/** The Confirm button of the public page. The token is a prop only: it is not put in storage, a cookie or an analytics call. */
export function VerifyConfirm({ token, channel }: { token: string; channel: VerifyChannel }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "expired" | "error">("idle");
  async function confirm() {
    if (state === "busy") return;
    setState("busy");
    try {
      const r = await confirmVerificationAction(token);
      setState(r.ok ? "done" : r.code === "EXPIRED" ? "expired" : "error");
    } catch {
      setState("error");
    }
  }
  if (state === "done") return <p role="status" data-testid="verify-done"><b>Thank you. Your {WHAT[channel]} is confirmed.</b> You can close this page.</p>;
  if (state === "expired") return <p role="status" data-testid="verify-expired">This link has expired or was already used. If you still need to confirm, ask the person who sent you this link to send a new one.</p>;
  return (
    <div data-testid="verify-pending">
      <p>Someone at an organisation that uses AlarmOps asked you to confirm your {WHAT[channel]}. After you confirm, AlarmOps can use this {WHAT[channel]} to reach you about alerts for your organisation.</p>
      <p>Press the button only if it is yours.</p>
      <p className="sm mut">If you did not expect this, close the page. Nothing changes unless you press the button.</p>
      <button type="button" className="btn pri lg" style={{ minHeight: 44 }} data-testid="verify-confirm" disabled={state === "busy"} onClick={() => { void confirm(); }}>{state === "busy" ? "Confirming…" : "Confirm"}</button>
      <div role="alert" data-testid="verify-error" style={{ marginTop: 12 }}>{state === "error" ? "We could not confirm this just now. Nothing was changed. Please try again." : null}</div>
    </div>
  );
}
