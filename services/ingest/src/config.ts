/** Required settings fail closed (known-bugs 6-5, 10-8; API-CONTRACT 503 NOT_CONFIGURED). */
export function requireEnv(name: string, env: Record<string, string | undefined> = process.env): string {
  const v = env[name];
  if (!v || !v.trim()) throw new NotConfiguredError(name);
  return v;
}
export class NotConfiguredError extends Error {
  constructor(public readonly setting: string) {
    super(`Missing required setting ${setting}`);
  }
}
/** Consumer budget must stay below the SQS visibility timeout (known-bugs 6-9). */
export function assertBudget(visibilityTimeoutSec: number, budgetMs: number): void {
  if (budgetMs >= visibilityTimeoutSec * 1000) throw new Error('Consumer time budget must be shorter than the SQS visibility timeout');
}
