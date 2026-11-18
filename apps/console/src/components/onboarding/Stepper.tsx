"use client";

export type StepKey = "customer" | "organization" | "account" | "connection" | "people";
export const STEPS: { key: StepKey; label: string }[] = [
  { key: "customer", label: "Customer" },
  { key: "organization", label: "Organization" },
  { key: "account", label: "AWS account" },
  { key: "connection", label: "Connection" },
  { key: "people", label: "People" },
];

/**
 * The steps of the wizard as an ordered list; the current one is aria-current="step". A step is a button (44px) that
 * moves between the saved steps; "Customer" is done as soon as the customer exists and is not edited here.
 */
export function Stepper({ current, onSelect, enabled }: { current: StepKey; onSelect?: (k: StepKey) => void; enabled: (k: StepKey) => boolean }) {
  return (
    <nav aria-label="Onboarding steps">
      <ol className="ob-steps" data-testid="ob-steps">
        {STEPS.map((s, i) => {
          const on = enabled(s.key) && s.key !== "customer" || s.key === current;
          return (
            <li key={s.key}>
              <button type="button" className="ob-step" data-testid={`ob-step-${s.key}`} aria-current={s.key === current ? "step" : undefined} disabled={!on || !onSelect}
                onClick={() => onSelect?.(s.key)}>
                <span className="n" aria-hidden="true">{i + 1}</span>{s.label}{s.key === "customer" && current !== "customer" ? <span className="sr-only"> (done)</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
