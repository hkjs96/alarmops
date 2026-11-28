/**
 * Call order › Rotations, the screen's pure rules (API-CONTRACT §8.3 PATCH /rotations/{id}; docs/ui/screens/oncall-rotations.md).
 * The expected values come from the contract and the screen spec, not from what the code returns.
 *
 * Assumed module: `@/lib/rotations` exports `buildChange(saved, draft)` and `rotationErrorText(failure, ctx?)`, like lib/templates.ts.
 * `saved` and `draft` are `{ name, members: contactId[], handover: { minute, dow? } }`.
 */
import { describe, expect, it } from "vitest";
import { buildChange, rotationErrorText } from "./rotations";

const saved = { name: "MSP night desk", members: ["ct_haeun", "ct_junho", "ct_jiwoo"], handover: { minute: 540 } };

describe("buildChange: only what changed, never the cadence", () => {
  it("a rename alone is {name}", () => expect(buildChange(saved, { ...saved, name: "Night desk" })).toEqual({ name: "Night desk" }));
  it("the name is trimmed before it is compared and sent", () => {
    expect(buildChange(saved, { ...saved, name: "  MSP night desk  " })).toBeNull();
    expect(buildChange(saved, { ...saved, name: "  Night desk " })).toEqual({ name: "Night desk" });
  });
  it("the order is a change: swapping 2 and 3 sends the whole new list", () => {
    expect(buildChange(saved, { ...saved, members: ["ct_haeun", "ct_jiwoo", "ct_junho"] })).toEqual({ members: ["ct_haeun", "ct_jiwoo", "ct_junho"] });
  });
  it("a person added or removed is a members change", () => {
    expect(buildChange(saved, { ...saved, members: [...saved.members, "ct_taemin"] })).toEqual({ members: [...saved.members, "ct_taemin"] });
    expect(buildChange(saved, { ...saved, members: ["ct_haeun", "ct_junho"] })).toEqual({ members: ["ct_haeun", "ct_junho"] });
  });
  it("the handover is a change only when the time differs", () => {
    expect(buildChange(saved, { ...saved, handover: { minute: 540 } })).toBeNull();
    expect(buildChange(saved, { ...saved, handover: { minute: 600 } })).toEqual({ handover: { minute: 600 } });
    const weekly = { ...saved, handover: { minute: 540, dow: 1 } };
    expect(buildChange(weekly, { ...weekly, handover: { minute: 540, dow: 1 } })).toBeNull();
    expect(buildChange(weekly, { ...weekly, handover: { minute: 540, dow: 2 } })).toEqual({ handover: { minute: 540, dow: 2 } });
  });
  it("several changes: each changed field, and nothing else", () => {
    const c = buildChange(saved, { name: "Night desk", members: ["ct_junho", "ct_haeun", "ct_jiwoo"], handover: { minute: 540 } });
    expect(Object.keys(c!).sort()).toEqual(["members", "name"]);
  });
  it("nothing changed is null", () => expect(buildChange(saved, { ...saved, members: [...saved.members] })).toBeNull());
  it("no input puts a cadence key in the result (a cadence is never changed: make a new rotation)", () => {
    type D = typeof saved;
    const daily = { ...saved, cadence: "DAILY" } as unknown as D;
    // only the cadence differs: that is not a change
    expect(buildChange(daily, { ...saved, cadence: "WEEKLY" } as unknown as D)).toBeNull();
    // other changes next to a different cadence: the cadence is not carried along
    const c = buildChange(daily, { ...saved, name: "Night desk", cadence: "WEEKLY" } as unknown as D);
    expect(c).toEqual({ name: "Night desk" });
    expect(c).not.toHaveProperty("cadence");
    const all = buildChange(saved, { name: "x", members: ["a"], handover: { minute: 1 }, cadence: "WEEKLY" } as unknown as D);
    expect(all).not.toHaveProperty("cadence");
  });
});

describe("rotationErrorText: one fixed sentence per code", () => {
  const f = (code: string, details?: Record<string, unknown>) => ({ code, message: "server words", requestId: "r", details });
  const CODES = ["PREVIEW_STALE", "VERSION_CONFLICT", "IN_USE", "ALREADY_EXISTS", "BUSY", "ROLE_REQUIRED", "FORBIDDEN", "VALIDATION_FAILED", "CUSTOMER_TERMINATED"];

  it("every code has its own English sentence, not the server's message", () => {
    const seen = new Set<string>();
    for (const c of CODES) {
      const t = rotationErrorText(f(c, c === "ROLE_REQUIRED" ? { role: "ADMIN" } : undefined));
      expect(t, c).not.toBe("");
      expect(t, c).not.toContain("server words");
      expect(t, c).not.toContain(c);
      expect(t, c).toMatch(/^[\x20-\x7e’“”—–…]+$/);
      seen.add(t);
    }
    expect(seen.size).toBe(CODES.length);
  });
  it("the same code always gives the same words", () => {
    for (const c of CODES) expect(rotationErrorText(f(c)), c).toBe(rotationErrorText(f(c)));
  });
  it("each says what happened to the data and what to do", () => {
    expect(rotationErrorText(f("PREVIEW_STALE"))).toMatch(/Nothing was changed/);
    expect(rotationErrorText(f("PREVIEW_STALE"))).toMatch(/preview/i);
    expect(rotationErrorText(f("VERSION_CONFLICT"))).toMatch(/Nothing was changed/);
    expect(rotationErrorText(f("VERSION_CONFLICT"))).toMatch(/Reload/);
    expect(rotationErrorText(f("IN_USE"))).toMatch(/Nothing was (changed|deleted)/);
    expect(rotationErrorText(f("ALREADY_EXISTS"))).toContain("Choose a different name.");
    expect(rotationErrorText(f("BUSY"))).toMatch(/Try again/);
    expect(rotationErrorText(f("BUSY"))).toMatch(/Nothing was changed/);
    expect(rotationErrorText(f("ROLE_REQUIRED", { role: "ADMIN" }))).toMatch(/Admin/);
    expect(rotationErrorText(f("FORBIDDEN"))).toMatch(/Nothing was changed/);
    expect(rotationErrorText(f("CUSTOMER_TERMINATED"))).toMatch(/terminated/);
  });
  it("PREVIEW_STALE and VERSION_CONFLICT are told apart: one says preview again, the other says Reload", () => {
    expect(rotationErrorText(f("PREVIEW_STALE"))).not.toMatch(/Reload/);
    expect(rotationErrorText(f("VERSION_CONFLICT"))).not.toMatch(/Review the new preview/);
  });
});
