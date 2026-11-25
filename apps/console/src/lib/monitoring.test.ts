import { describe, expect, it } from "vitest";
import { canRetag, canStop, monitoringError, monitoringStats, outsideText, reasonText, stopPrompt } from "./monitoring";
import type { ManagedAlarmItem, ResourceItem } from "./api/types";

const f = (code: string, extra: Record<string, unknown> = {}) => ({ code, message: "raw", requestId: "req_9", ...extra });

describe("monitoring error sentences", () => {
  it("403 CAPABILITY_DISABLED on Re-tag names the TagWriter role and where to enable it", () => {
    const s = monitoringError(f("CAPABILITY_DISABLED"), "tag_on", "checkout-alb");
    expect(s).toContain("checkout-alb was not re-tagged");
    expect(s).toContain("TagWriter role is not enabled");
  });
  it("403 CAPABILITY_DISABLED names the role from details.role", () => {
    expect(monitoringError(f("CAPABILITY_DISABLED", { details: { role: "alarmWriter" } }), "stop", "ledger-db")).toContain("AlarmWriter role is not enabled");
    expect(monitoringError(f("CAPABILITY_DISABLED", { details: { role: "tagWriter" } }), "tag_on", "x")).toContain("TagWriter role is not enabled");
  });
  it("409 ACCOUNT_DISABLED says the customer or account is no longer active", () => {
    expect(monitoringError(f("ACCOUNT_DISABLED"), "stop", "x")).toContain("This customer or AWS account is no longer active");
  });
  it("502 and NOT_SUPPORTED are sentences", () => {
    expect(monitoringError(f("COMMAND_PUBLISH_FAILED"), "stop", "x")).toContain("could not be queued");
    expect(monitoringError(f("NOT_SUPPORTED"), "keep", "x")).toContain("not available yet");
  });
  it("503 COMMANDS_UNAVAILABLE says nothing was changed", () => {
    expect(monitoringError(f("COMMANDS_UNAVAILABLE"), "stop", "ledger-db")).toBe("Monitoring of ledger-db was not stopped. The command queue is not available yet, so nothing was changed. Ask whoever manages the console’s deployment.");
  });
  it("409 says someone already handled it and to reload", () => {
    expect(monitoringError(f("INVALID_TRANSITION"), "keep", "x")).toContain("Reload the list");
    expect(monitoringError(f("VERSION_CONFLICT"), "keep", "x")).toContain("Reload the list");
  });
  it("a role refusal says Operator", () => { expect(monitoringError(f("ROLE_REQUIRED"), "stop", "x")).toContain("Operator role"); });
  it("an unknown code keeps the server's words and the request id", () => {
    const s = monitoringError(f("TEAPOT"), "stop", "x");
    expect(s).toContain("raw");
    expect(s).toContain("req_9");
  });
  it("never shows a bare status code", () => { for (const c of ["CAPABILITY_DISABLED", "COMMANDS_UNAVAILABLE", "INVALID_TRANSITION"]) expect(monitoringError(f(c), "stop", "x")).not.toMatch(/\b(403|409|503)\b/); });
});

describe("monitoring numbers and words", () => {
  const r = (state: ResourceItem["monitoringState"]) => ({ monitoringState: state }) as ResourceItem;
  const a = (state: ManagedAlarmItem["state"]) => ({ state }) as ManagedAlarmItem;
  it("one definition per number", () => {
    expect(monitoringStats([r("MONITORED"), r("MONITORED"), r("NEEDS_REVIEW"), r("NOT_MONITORED")], [a("ALARM"), a("OK"), a("ALARM")])).toEqual({ monitored: 2, needsReview: 1, inAlarm: 2 });
  });
  it("outside chip text", () => { expect(outsideText({ needsReview: 2, inAlarm: 3 })).toBe("Outside this view: 2 need review · 3 in alarm"); });
  it("stop prompt", () => {
    expect(stopPrompt({ name: "ledger-db", alarmCount: 5 })).toBe("Delete 5 alarms for ledger-db? This cannot be undone.");
    expect(stopPrompt({ name: "q", alarmCount: 1 })).toBe("Delete 1 alarm for q? This cannot be undone.");
  });
  it("reason words and Re-tag availability", () => {
    expect(reasonText("tag_removed")).toBe("Monitoring tag was removed");
    expect(reasonText(null)).toBe("—");
    expect(canRetag({ account: { awsAccountId: "1", tagWriterEnabled: true } })).toBe(true);
    expect(canStop({ account: { awsAccountId: null, alarmWriterEnabled: true } })).toBe(true);
    expect(canStop({ account: { awsAccountId: null } })).toBe(false);
    expect(canRetag({ account: { awsAccountId: "1" } })).toBe(false);
    expect(canRetag({ account: null })).toBe(false);
  });
});
