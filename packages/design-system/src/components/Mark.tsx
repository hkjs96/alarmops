import type { Shape } from "../severity";
export function Mark({ shape }: { shape: Shape }) {
  return <span className={`mk ${shape}`} aria-hidden="true" />;
}
