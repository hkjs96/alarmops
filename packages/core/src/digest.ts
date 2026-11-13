/**
 * D-46: the business-hours digest. Weekdays 09:00-18:00 KST except Korean public holidays; one digest per business
 * day at 10:00 KST covers everything since the previous business day's 10:00 (so a weekend or holiday is folded into
 * the next business day's digest). Pure functions; the store supplies the data (`DigestData`). Sending to Slack is not
 * built yet: the API serves the latest digest (`GET /digests/latest`).
 */
import { KOREAN_HOLIDAYS } from './koreanHolidays.js';
import { kstDay } from './retention.js';

const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
export const DIGEST_HOUR_KST = 10;

/** 'YYYY-MM-DD' (a KST calendar date) -> 0 = Sunday ... 6 = Saturday. */
const weekday = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
const addDays = (day: string, n: number): string => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);

export function isBusinessDay(day: string, holidays: ReadonlySet<string> = KOREAN_HOLIDAYS): boolean {
  const w = weekday(day);
  return w !== 0 && w !== 6 && !holidays.has(day);
}
/** The business day before `day` (strictly earlier). */
export function previousBusinessDay(day: string, holidays: ReadonlySet<string> = KOREAN_HOLIDAYS): string {
  let d = addDays(day, -1);
  for (let i = 0; i < 40 && !isBusinessDay(d, holidays); i++) d = addDays(d, -1);
  return d;
}
/** 10:00 KST of a KST calendar date, as a UTC instant. */
export const digestInstant = (day: string): Date => new Date(new Date(`${day}T00:00:00Z`).getTime() + DIGEST_HOUR_KST * 3_600_000 - KST_MS);

export interface DigestWindow { businessDay: string; digestAt: Date; from: Date; to: Date }

/** The window of the digest of one business day: [previous business day 10:00, this day 10:00). */
export function digestWindowFor(businessDay: string, holidays: ReadonlySet<string> = KOREAN_HOLIDAYS): DigestWindow | null {
  if (!isBusinessDay(businessDay, holidays)) return null;
  const to = digestInstant(businessDay);
  return { businessDay, digestAt: to, from: digestInstant(previousBusinessDay(businessDay, holidays)), to };
}

/** The most recent digest that is due at `now` (today's if it is a business day past 10:00, else the previous business day's). */
export function latestDigestWindow(now: Date, holidays: ReadonlySet<string> = KOREAN_HOLIDAYS): DigestWindow {
  let day = kstDay(now);
  if (!isBusinessDay(day, holidays) || now.getTime() < digestInstant(day).getTime()) day = previousBusinessDay(day, holidays);
  return digestWindowFor(day, holidays)!;
}

export interface DigestSuspendedRow { customerId: string; customerName: string; incidents: number; firstAt: Date; lastAt: Date }
export interface DigestResidualRow { customerId: string; customerName: string; sources: number; lastEventAt: Date; totalEvents: number }
/** What a store returns for a window. Counts only: no titles, no resource names. */
export interface DigestData { suspended: DigestSuspendedRow[]; terminatedResiduals: DigestResidualRow[] }

export interface Digest {
  businessDay: string;
  digestAt: string;
  from: string;
  to: string;
  suspended: Array<{ customerId: string; customerName: string; incidents: number; firstAt: string; lastAt: string }>;
  /** `totalEvents` is the cumulative count of OffboardResidual (the table keeps no per-day counts); `lastEventAt` is inside the window. */
  terminatedResiduals: Array<{ customerId: string; customerName: string; sources: number; lastEventAt: string; totalEvents: number }>;
  totals: { suspendedIncidents: number; suspendedCustomers: number; residualCustomers: number };
  /** true when nothing happened: the screen shows "no items" and Slack stays quiet. */
  empty: boolean;
}

export function buildDigest(w: DigestWindow, data: DigestData): Digest {
  const suspended = [...data.suspended].sort((a, b) => b.incidents - a.incidents || a.customerName.localeCompare(b.customerName));
  const residuals = [...data.terminatedResiduals].sort((a, b) => b.lastEventAt.getTime() - a.lastEventAt.getTime() || a.customerName.localeCompare(b.customerName));
  return {
    businessDay: w.businessDay, digestAt: w.digestAt.toISOString(), from: w.from.toISOString(), to: w.to.toISOString(),
    suspended: suspended.map((s) => ({ ...s, firstAt: s.firstAt.toISOString(), lastAt: s.lastAt.toISOString() })),
    terminatedResiduals: residuals.map((r) => ({ ...r, lastEventAt: r.lastEventAt.toISOString() })),
    totals: { suspendedIncidents: suspended.reduce((n, s) => n + s.incidents, 0), suspendedCustomers: suspended.length, residualCustomers: residuals.length },
    empty: suspended.length === 0 && residuals.length === 0,
  };
}
