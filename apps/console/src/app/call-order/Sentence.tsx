import { partsText, type Part } from "@/lib/call-order/model";

/** The call-order sentence. Changed values are bold and marked; the value they replace follows, struck through. `data-plain` is the sentence as it would be saved. */
export function Sentence({ parts, live, id }: { parts: readonly Part[]; live?: boolean; id?: string }) {
  return (
    <p className="co-sent" id={id} data-testid="co-sentence" data-plain={partsText(parts)} aria-live={live ? "polite" : undefined}>
      {parts.map((p, n) =>
        p.k === "old" ? <s key={n} className="co-old"><span className="sr-only">was </span>{p.t}</s>
          : p.k === "new" ? <b key={n} className="co-new">{p.t}</b>
            : p.k === "b" ? <b key={n}>{p.t}</b> : <span key={n}>{p.t}</span>)}
    </p>
  );
}
