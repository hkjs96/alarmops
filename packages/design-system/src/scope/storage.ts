/** sessionStorage helpers that never throw (private mode, SSR). */
export function readSession<T>(key: string): T | null {
  try {
    const v = typeof window === "undefined" ? null : window.sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
export function writeSession(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}
