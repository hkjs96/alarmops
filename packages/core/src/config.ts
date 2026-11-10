/**
 * Typed loader for the policy switches (security review 2, R-15). Environment variables are strings: the string
 * 'false' is truthy, so a flag must never be passed through as-is. Every flag is parsed here, and a value that is
 * not clearly true or false becomes the SAFE value with a warning — it never switches a protection off.
 */
import { PORTAL_SHOWS_STAFF_NAMES, SMS_VOICE_REQUIRE_VERIFIED } from './limits.js';

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off', '']);

/** boolean → itself; a clear true/false string → that; anything else (number, object, typo) → undefined. */
export function parseFlag(v: unknown): boolean | undefined {
  if (v === true || v === false) return v;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return TRUE.has(s) ? true : FALSE.has(s) ? false : undefined;
}

export interface PolicyFlags {
  /** D-36. true only when explicitly switched on. */
  portalShowsStaffNames: boolean;
  /** D-37. false only when explicitly switched off. */
  smsVoiceRequireVerified: boolean;
}
export const DEFAULT_FLAGS: Readonly<PolicyFlags> = Object.freeze({ portalShowsStaffNames: PORTAL_SHOWS_STAFF_NAMES, smsVoiceRequireVerified: SMS_VOICE_REQUIRE_VERIFIED });

export const FLAG_ENV = { portalShowsStaffNames: 'PORTAL_SHOWS_STAFF_NAMES', smsVoiceRequireVerified: 'SMS_VOICE_REQUIRE_VERIFIED' } as const;

/**
 * Read the flags from an env-like record (the caller passes `process.env`; this package never reads it itself).
 * Unset → default. Unparseable → default + a warning naming the variable (never its value).
 */
export function loadPolicyFlags(env: Record<string, unknown> = {}): { flags: PolicyFlags; warnings: string[] } {
  const warnings: string[] = [];
  const flags: PolicyFlags = { ...DEFAULT_FLAGS };
  for (const key of Object.keys(FLAG_ENV) as Array<keyof PolicyFlags>) {
    const name = FLAG_ENV[key];
    if (!Object.hasOwn(env, name) || env[name] === undefined) continue;
    const v = parseFlag(env[name]);
    if (v === undefined) warnings.push(`${name} is not a boolean ("true" / "false"); using the safe default ${String(DEFAULT_FLAGS[key])}.`);
    else flags[key] = v;
  }
  return { flags, warnings };
}

/** A flag that protects when true: only an explicit boolean false switches it off. */
export const protectUnlessFalse = (v: unknown): boolean => v !== false;
/** A flag that exposes when true: only an explicit boolean true switches it on. */
export const allowOnlyIfTrue = (v: unknown): boolean => v === true;
