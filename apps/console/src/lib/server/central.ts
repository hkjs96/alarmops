import type { CentralValues } from "../onboarding";

type Env = Record<string, string | undefined>;
const ROLE_RE = /^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const BUS_RE = /^arn:aws:events:ap-northeast-2:[0-9]{12}:event-bus\/[A-Za-z0-9._-]{1,256}$/;
const warned = new Set<string>();

function pick(env: Env, name: string, re: RegExp): string | null {
  const v = env[name]?.trim();
  if (!v) return null;
  if (re.test(v)) return v;
  // once per variable, and never the value
  if (!warned.has(name)) { warned.add(name); console.warn(`[console config] ${name} is not a valid ARN for this use and is ignored: the connection kit shows it as missing`); }
  return null;
}

/**
 * The central values the customer's stack needs (outputs of the central deployment, deploy-central). Plain runtime
 * variables, not secrets: CENTRAL_ROLE_ARN (an IAM role), CENTRAL_EVENT_BUS_ARN (an event bus in ap-northeast-2),
 * REMEDIATOR_CALLER_ROLE_ARN (an IAM role, only needed when a customer turns Remediator on). A value that is unset or
 * not valid is null, and the kit says it is missing.
 */
export function centralValues(env: Env = process.env): CentralValues {
  return {
    centralRoleArn: pick(env, "CENTRAL_ROLE_ARN", ROLE_RE),
    centralBusArn: pick(env, "CENTRAL_EVENT_BUS_ARN", BUS_RE),
    remediatorCallerRoleArn: pick(env, "REMEDIATOR_CALLER_ROLE_ARN", ROLE_RE),
  };
}

/** Fake values of the mock, so the kit can be completed without AWS. A customer whose slug starts with "no-central" has none. */
export const MOCK_CENTRAL: CentralValues = {
  centralRoleArn: "arn:aws:iam::111122223333:role/AlarmOpsCentral-Engine",
  centralBusArn: "arn:aws:events:ap-northeast-2:111122223333:event-bus/alarmops-central",
  remediatorCallerRoleArn: "arn:aws:iam::111122223333:role/AlarmOpsCentral-Remediator",
};
