/**
 * Call-order limits, the same numbers the API enforces (API-CONTRACT §2 "한도", D-38; server: packages/core limits.ts).
 * The editor shows them and stops at them, so a save is never refused for a reason the screen did not state.
 * `estimateSends` is the server's own arithmetic (escalation.ts): the number the PUT is judged by.
 */
import type { PagingStep } from "../api/types";

export const MAX_STEPS = 12;
export const MAX_MINUTE = 24 * 60;
export const MAX_REPEAT = 5;
/** notifications one incident may produce in one pass of the steps (steps × people × channels) */
export const MAX_SENDS_PER_CYCLE = 60;
/** … and in any 60 minutes, repeats included */
export const MAX_SENDS_PER_HOUR = 120;
/** people a step that pages "everyone in Responders" may reach */
export const MAX_ALL_RESPONDERS = 20;
/** channels a step can have: one of each kind */
export const MAX_CHANNELS = 5;
const REPEAT_GAP_DEFAULT_MIN = 5;

export const LIMITS_TEXT = `Up to ${MAX_STEPS} steps · minutes 0–${MAX_MINUTE.toLocaleString("en-US")}, each later than the one before · repeat 0–${MAX_REPEAT} · at most ${MAX_SENDS_PER_CYCLE} notifications per incident in one pass and ${MAX_SENDS_PER_HOUR} in an hour · “everyone” reaches at most ${MAX_ALL_RESPONDERS} people`;

type S = Pick<PagingStep, "atMin" | "targetType" | "channels">;
export interface Sends { perCycle: number; perHour: number }

/** A step sends one message per person and person-channel, plus one for the Slack channel. `everyone` = pageable responders now. */
export function estimateSends(steps: readonly S[], repeatCount: number, everyone: number): Sends {
  if (steps.length === 0) return { perCycle: 0, perHour: 0 };
  const people = (s: S) => (s.targetType === "ALL_RESPONDERS" ? Math.max(1, Math.min(everyone, MAX_ALL_RESPONDERS)) : 1);
  const n = steps.map((s) => s.channels.reduce((a, ch) => a + (ch === "SLACK_CHANNEL" ? 1 : people(s)), 0));
  const perCycle = n.reduce((a, b) => a + b, 0);
  // the engine's clock: a step waits atMin(i) − atMin(i−1) after the one before; a repeat waits the last gap
  const last = steps.length >= 2 ? steps[steps.length - 1]!.atMin - steps[steps.length - 2]!.atMin : 0;
  const gap = (last > 0 ? last : REPEAT_GAP_DEFAULT_MIN) + steps[0]!.atMin;
  const repeat = Number.isFinite(repeatCount) ? Math.max(0, Math.min(MAX_REPEAT, Math.floor(repeatCount))) : 0;
  const sends: { at: number; n: number }[] = [];
  let t = 0;
  for (let cycle = 0; cycle <= repeat; cycle++) {
    steps.forEach((s, i) => {
      t += i === 0 ? (cycle === 0 ? s.atMin : gap) : Math.max(0, s.atMin - steps[i - 1]!.atMin);
      sends.push({ at: t, n: n[i]! });
    });
  }
  let perHour = 0, sum = 0, lo = 0;
  for (let hi = 0; hi < sends.length; hi++) {
    sum += sends[hi]!.n;
    while (sends[hi]!.at - sends[lo]!.at >= 60) sum -= sends[lo++]!.n;
    perHour = Math.max(perHour, sum);
  }
  return { perCycle, perHour };
}

export type CapViolation =
  | { code: "RESPONDER_LIMIT_EXCEEDED"; stepIndex: number; responders: number; limit: number }
  | { code: "SEND_CAP_EXCEEDED"; perCycle: number; perHour: number };

/** The rule the PUT applies (sendCapViolation): the people limit first, then the two send limits. */
export function capViolation(steps: readonly S[], repeatCount: number, everyone: number): CapViolation | null {
  const all = steps.findIndex((s) => s.targetType === "ALL_RESPONDERS");
  if (all >= 0 && everyone > MAX_ALL_RESPONDERS) return { code: "RESPONDER_LIMIT_EXCEEDED", stepIndex: all, responders: everyone, limit: MAX_ALL_RESPONDERS };
  const s = estimateSends(steps, repeatCount, everyone);
  return s.perCycle > MAX_SENDS_PER_CYCLE || s.perHour > MAX_SENDS_PER_HOUR ? { code: "SEND_CAP_EXCEEDED", ...s } : null;
}
export function capText(v: CapViolation): string {
  if (v.code === "RESPONDER_LIMIT_EXCEEDED") {
    return `Step ${v.stepIndex + 1} calls everyone in Responders: ${v.responders} people, and the limit is ${v.limit}. Call a rotation or named people instead, or reduce the Responders.`;
  }
  const over = v.perCycle > MAX_SENDS_PER_CYCLE
    ? `${v.perCycle} notifications per incident in one pass of the steps (limit ${MAX_SENDS_PER_CYCLE})`
    : `${v.perHour} notifications per incident within one hour, repeats included (limit ${MAX_SENDS_PER_HOUR})`;
  return `This call order would send ${over}. Use fewer steps, channels or repeats, or call fewer people per step.`;
}
