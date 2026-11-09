import { createHash } from 'node:crypto';
export const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** yyyymmddHHMMSS in UTC (G-4, I-2). */
export const stamp14 = (d: Date): string => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
