"use client";
import { useId, useState } from "react";
import { cx } from "@alarmops/design-system";
import type { PagingConfigInput, PagingPlan, PagingStep, PagingStyle, StepChannel } from "@/lib/api/types";
import {
  CH_LABEL, MAX_REPEAT, PLAN_LABEL, STYLE_LABEL, addStep, firstName, firstOfStyle, isEdited, moveStep, pageableIds, planSteps, removeStep, repeatText,
  type Directory, type Issue,
} from "@/lib/call-order/model";

const STYLES: PagingStyle[] = ["ALL_AT_ONCE", "CUSTOMER_ROTATION", "SHARED_ROTATION", "CUSTOM"];
const PLANS: PagingPlan[] = ["STANDARD", "URGENT", "QUIET"];
const CHANNELS: StepChannel[] = ["SLACK_DM", "SMS", "VOICE"];
const STYLE_HINT: Record<PagingStyle, string> = {
  ALL_AT_ONCE: "Everyone in Responders, at the same time",
  CUSTOMER_ROTATION: "Whoever is on shift in this customer's own rotation",
  SHARED_ROTATION: "Whoever is on shift in a shared MSP rotation",
  CUSTOM: "Your own mix of people, rotations and everyone",
};
const PLAN_HINT: Record<PagingPlan, string> = { STANDARD: "Slack → 2 min SMS → 7 min call → 12 min everyone", URGENT: "Call at once → 5 min everyone", QUIET: "Slack → 15 min everyone, Slack only" };

const enc = (s: PagingStep) => (s.targetType === "ALL_RESPONDERS" ? "ALL" : `${s.targetType === "ROTATION" ? "R" : "P"}:${s.targetId ?? ""}`);
function dec(v: string): Pick<PagingStep, "targetType" | "targetId"> {
  if (v === "ALL") return { targetType: "ALL_RESPONDERS", targetId: undefined };
  return { targetType: v.startsWith("R:") ? "ROTATION" : "PERSON", targetId: v.slice(2) || undefined };
}

/**
 * The editor that appears after Edit: who is called first, a starting plan, then the steps themselves
 * (minute · who · how), add / remove / reorder, and how often the whole order repeats (D-20: once by default).
 */
export function StepEditor({ value, onChange, dir, customerName, showErrors, issues }: {
  value: PagingConfigInput; onChange: (v: PagingConfigInput) => void; dir: Directory; customerName: string; showErrors: boolean; issues: Issue[];
}) {
  const uid = useId();
  const [undo, setUndo] = useState<{ was: PagingConfigInput; what: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const msp = dir.rotations.filter((r) => r.scope === "MSP");
  const own = dir.rotations.filter((r) => r.scope === "CUSTOMER");
  const currentRot = value.steps.find((s) => s.targetType === "ROTATION")?.targetId;
  const pool = value.style === "SHARED_ROTATION" ? msp : value.style === "CUSTOMER_ROTATION" ? own : [];
  const everyone = pageableIds(dir).length;
  const bad = (i: number, f: Issue["field"]) => issues.some((x) => x.stepIndex === i && x.field === f);

  const regenerate = (style: PagingStyle, plan: PagingPlan, rot: string | undefined, what: string) => {
    const first = firstOfStyle(style, rot, value.steps);
    if (!first) { onChange({ ...value, style, sharedRotationId: undefined }); return; }
    setUndo({ was: value, what });
    setNote(null);
    onChange({ style, plan, ...(style === "SHARED_ROTATION" && rot ? { sharedRotationId: rot } : {}), repeatCount: value.repeatCount, steps: planSteps(plan, first) });
  };
  const setStyle = (style: PagingStyle) => {
    if (style === value.style) return;
    if (style === "CUSTOM") { onChange({ ...value, style, sharedRotationId: undefined }); return; }
    const list = style === "SHARED_ROTATION" ? msp : style === "CUSTOMER_ROTATION" ? own : [];
    regenerate(style, value.plan, list.find((r) => r.id === currentRot)?.id ?? list[0]?.id, `Steps rebuilt for ${STYLE_LABEL[style]}`);
  };
  const setSteps = (steps: PagingStep[], targetChanged = false) => {
    setUndo(null);
    if (targetChanged && value.style !== "CUSTOM") {
      setNote(`Ordering switched from ${STYLE_LABEL[value.style]} to Custom, because you changed who a step calls.`);
      onChange({ ...value, style: "CUSTOM", sharedRotationId: undefined, steps });
    } else onChange({ ...value, steps });
  };
  const patch = (i: number, p: Partial<PagingStep>, targetChanged = false) => setSteps(value.steps.map((s, n) => (n === i ? { ...s, ...p } : s)), targetChanged);
  const toggle = (i: number, c: StepChannel) => {
    const s = value.steps[i]!;
    patch(i, { channels: s.channels.includes(c) ? s.channels.filter((x) => x !== c) : [...s.channels, c] });
  };

  return (
    <div className="co-ed" data-testid="co-editor">
      <fieldset className="co-fs">
        <legend className="ov">Who is called first</legend>
        <div className="co-styles" role="radiogroup" aria-label="Who is called first">
          {STYLES.map((s) => {
            const none = (s === "CUSTOMER_ROTATION" && own.length === 0) || (s === "SHARED_ROTATION" && msp.length === 0);
            return (
              <label key={s} className={cx("co-opt", value.style === s && "on", none && "off")}>
                <input type="radio" name={`${uid}-style`} checked={value.style === s} disabled={none} onChange={() => setStyle(s)} />
                <span><b>{STYLE_LABEL[s]}</b><small>{none ? `${customerName} has no rotation of its own` : STYLE_HINT[s]}</small></span>
              </label>
            );
          })}
        </div>
        {pool.length ? (
          <label className="co-rot">
            <span className="lab" aria-hidden="true">Rotation</span>
            <select className="inp" aria-label="Rotation" value={currentRot ?? ""} onChange={(e) => regenerate(value.style, value.plan, e.target.value, "Steps rebuilt for the rotation")}>
              {pool.some((r) => r.id === currentRot) ? null : <option value="" disabled>Choose a rotation</option>}
              {pool.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.onShift ? `${firstName(r.onShift.name)} now` : "nobody now"})</option>)}
            </select>
          </label>
        ) : null}
      </fieldset>

      <fieldset className="co-fs">
        <legend className="ov">Timing · start from a plan</legend>
        <div className="co-plans">
          {PLANS.map((p) => (
            <button key={p} type="button" className={cx("btn", value.plan === p && "on")} aria-pressed={value.plan === p} title={PLAN_HINT[p]}
              onClick={() => regenerate(value.style, p, currentRot, `Steps replaced with the ${PLAN_LABEL[p]} plan`)}>
              {PLAN_LABEL[p]}{value.plan === p && isEdited(value) ? " (edited)" : ""}
            </button>
          ))}
        </div>
        <div className="hint">A plan is only a starting point for this level. Choosing one replaces the steps below; nothing is shared with other customers.</div>
        {undo ? (
          <div className="note co-undo" role="status">
            <span>{undo.what}.</span>
            <button type="button" className="btn sm" onClick={() => { onChange(undo.was); setUndo(null); }}>Put my steps back</button>
          </div>
        ) : null}
        {note ? <div className="note" role="status"><span>{note}</span></div> : null}
      </fieldset>

      <fieldset className="co-fs">
        <legend className="ov">Steps</legend>
        <ol className="co-steps ed" data-testid="co-step-rows">
          {value.steps.map((s, i) => (
            <li key={i} className="co-step" data-step={i}>
              <span className={cx("ord", i === 0 && "first")}>{i + 1}</span>
              <span className="co-min">
                {i === 0 ? <span className="mono b">0 min</span> : (
                  <>
                    <input className={cx("inp num", bad(i, "atMin") && "bad")} type="text" inputMode="numeric" autoComplete="off" data-field="atMin" data-first-field={i === 1 ? "" : undefined}
                      aria-label={`Step ${i + 1} minutes`} aria-invalid={bad(i, "atMin") || undefined} value={s.atMin < 0 ? "" : String(s.atMin)}
                      onChange={(e) => { const d = e.target.value.replace(/\D/g, "").slice(0, 4); patch(i, { atMin: d === "" ? -1 : Number(d) }); }} />
                    <span className="sm mut">min</span>
                  </>
                )}
              </span>
              <select className={cx("inp co-who", (bad(i, "target") && showErrors) && "bad")} data-field="target" aria-label={`Step ${i + 1} calls`} value={enc(s)} onChange={(e) => patch(i, dec(e.target.value), true)}>
                {s.targetType === "PERSON" && !s.targetId ? <option value="P:" disabled>Choose a person</option> : null}
                <option value="ALL">Everyone in Responders ({everyone})</option>
                <optgroup label="On shift in a rotation">
                  {dir.rotations.map((r) => <option key={r.id} value={`R:${r.id}`}>On shift in {r.name} ({r.onShift ? `${firstName(r.onShift.name)} now` : "nobody now"})</option>)}
                </optgroup>
                <optgroup label="MSP staff">
                  {dir.staff.map((p) => <option key={p.contactId} value={`P:${p.contactId}`}>{p.name}</option>)}
                  {s.targetType === "PERSON" && s.targetId && !dir.staff.some((p) => p.contactId === s.targetId) && !dir.people.some((p) => p.contactId === s.targetId)
                    ? <option value={`P:${s.targetId}`}>{dir.allStaff?.find((p) => p.contactId === s.targetId)?.name ?? "Unknown person"} (not a responder)</option> : null}
                </optgroup>
                {dir.people.some((p) => p.role === "PAGEABLE") ? (
                  <optgroup label={`${customerName} people (Pageable)`}>
                    {dir.people.filter((p) => p.role === "PAGEABLE").map((p) => <option key={p.contactId} value={`P:${p.contactId}`}>{p.name} (customer)</option>)}
                  </optgroup>
                ) : null}
              </select>
              <span className="co-chs" role="group" aria-label={`Step ${i + 1} is sent by`}>
                {CHANNELS.map((c) => (
                  <button key={c} type="button" data-field={c === CHANNELS[0] ? "channels" : undefined} className={cx("co-ch", s.channels.includes(c) && "on", bad(i, "channels") && "bad")} aria-pressed={s.channels.includes(c)} onClick={() => toggle(i, c)}>{CH_LABEL[c]}</button>
                ))}
              </span>
              <span className="co-ops">
                <button type="button" className="btn sm" aria-label={`Move step ${i + 1} up`} title="Move up: swaps who is called with the step above; the minutes stay" disabled={i === 0} onClick={() => setSteps(moveStep(value.steps, i, -1), true)}>↑</button>
                <button type="button" className="btn sm" aria-label={`Move step ${i + 1} down`} title="Move down" disabled={i === value.steps.length - 1} onClick={() => setSteps(moveStep(value.steps, i, 1), true)}>↓</button>
                <button type="button" className="btn sm danger" aria-label={`Remove step ${i + 1}`} disabled={value.steps.length <= 1} onClick={() => setSteps(removeStep(value.steps, i), true)}>✕</button>
              </span>
            </li>
          ))}
        </ol>
        <div className="row co-add">
          <button type="button" className="btn" data-testid="co-add-step" onClick={() => setSteps(addStep(value.steps), true)}>+ Add step</button>
          <label className="co-rep">
            <span className="sm">Then repeat the whole order</span>
            <input className={cx("inp num", issues.some((x) => x.field === "repeat") && "bad")} type="text" inputMode="numeric" data-field="repeat" aria-label="Repeat count" value={value.repeatCount < 0 ? "" : String(value.repeatCount)}
              onChange={(e) => { const d = e.target.value.replace(/\D/g, "").slice(0, 1); onChange({ ...value, repeatCount: d === "" ? -1 : Number(d) }); }} />
            <span className="sm mut">time{value.repeatCount === 1 ? "" : "s"} (0–{MAX_REPEAT}) · {repeatText(value.repeatCount)}</span>
          </label>
        </div>
      </fieldset>
    </div>
  );
}
