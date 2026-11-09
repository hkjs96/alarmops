export type ThresholdSource = "TAG" | "CONSOLE" | "CUSTOMER" | "MSP" | "CODE";

const TITLE: Record<ThresholdSource, string> = {
  TAG: "Resource tag (read-only, wins)",
  CONSOLE: "Per-resource value set in console",
  CUSTOMER: "Customer default",
  MSP: "MSP default",
  CODE: "Code default",
};

/** Threshold source badge (D-19). */
export function SourceChip({ source }: { source: ThresholdSource }) {
  return (
    <span className={`src ${source.toLowerCase()}`} title={TITLE[source]}>
      {source}
    </span>
  );
}
