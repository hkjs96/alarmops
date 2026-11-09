import { readFileSync } from 'node:fs';
export const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
export const t = (iso: string) => new Date(iso);
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
