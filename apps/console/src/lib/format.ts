/** Display helpers. All times are shown in KST (DATA-MODEL §0), relative + absolute tooltip. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstParts(iso: string) {
  const d = new Date(new Date(iso).getTime() + KST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(),
    h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(),
  };
}
const p2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function kstTime(iso: string, seconds = false): string {
  const t = kstParts(iso);
  return seconds ? `${p2(t.h)}:${p2(t.m)}:${p2(t.s)}` : `${p2(t.h)}:${p2(t.m)}`;
}

export function kstDateTime(iso: string): string {
  const t = kstParts(iso);
  return `${t.y}-${p2(t.mo + 1)}-${p2(t.d)} ${p2(t.h)}:${p2(t.m)}:${p2(t.s)} KST`;
}

export function kstHeading(iso: string): string {
  const t = kstParts(iso);
  return `${DAYS[t.wd]}, ${MONTHS[t.mo]} ${t.d} · ${p2(t.h)}:${p2(t.m)} KST`;
}

/** Compact age: 45s, 4m, 2h, 3d. */
export function age(fromIso: string, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - new Date(fromIso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

/** Long duration: 4m 12s, 1h 3m. */
export function duration(fromIso: string, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - new Date(fromIso).getTime()) / 1000));
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/** Countdown m:ss until `toIso`, "now" if past. */
export function countdown(toIso: string, nowMs: number): string {
  const sec = Math.floor((new Date(toIso).getTime() - nowMs) / 1000);
  if (sec <= 0) return "now";
  return `${Math.floor(sec / 60)}:${p2(sec % 60)}`;
}

/** 481220935017 → "481 220 935 017" style used in the mockup for AWS account ids. */
export function groupDigits(id: string, size = 3): string {
  return id.replace(new RegExp(`(\\d{${size}})(?=\\d)`, "g"), "$1 ");
}
