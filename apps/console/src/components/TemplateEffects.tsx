"use client";
import type { TemplateEffect } from "@/lib/api/types";
import { BLOCK_FIX, blockingText, blockingTitle, effectLine, type BlockedCustomer } from "@/lib/templates";
import "./template-effects.css";

/** What a change does to one customer's Responders, one line each: a mark (+ − = !) and the words, never a colour alone. */
export function EffectList({ effects, testId = "tpl-effects" }: { effects: TemplateEffect[]; testId?: string }) {
  if (effects.length === 0) return <p className="te-none sm mut" data-testid={`${testId}-none`}>No change to the list.</p>;
  return (
    <ul className="te-list" data-testid={testId}>
      {effects.map((e) => {
        const l = effectLine(e);
        return (
          <li key={`${e.kind}-${e.contactId}`} className={`te-fx te-${l.kind}`} data-effect={e.kind}>
            <span className="te-mark" aria-hidden="true">{l.mark}</span>
            <span>{l.strong ? <b>{l.strong}</b> : null}{l.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The customers a change is refused for, with the reason, and what to do. Save stays off while this is shown. */
export function BlockedBox({ blocked, testId = "tpl-blocked" }: { blocked: BlockedCustomer[]; testId?: string }) {
  if (blocked.length === 0) return null;
  return (
    <div className="te-blocked" role="alert" data-testid={testId}>
      <p className="te-blocked-h"><span aria-hidden="true">✕</span> <b>{blockingTitle(blocked.length)}</b></p>
      <ul>
        {blocked.flatMap((c) => c.reasons.map((r) => <li key={`${c.customerId}-${r}`} data-reason={r}>{blockingText(r, c.name)}</li>))}
      </ul>
      <p className="sm">{BLOCK_FIX}</p>
    </div>
  );
}
