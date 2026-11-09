/** RawEvent.raw cap (known-bugs 1-4): 64KB, truncated payloads stay valid JSON. */
export const RAW_MAX_BYTES = 64 * 1024;

export function capRaw(raw: unknown, maxBytes = RAW_MAX_BYTES): unknown {
  const text = JSON.stringify(raw ?? null);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return raw ?? null;
  // Keep a byte-safe head as a string field so the stored document is still parseable JSON.
  // Re-escaping the head as a JSON string inflates it (quotes, backslashes), so shrink until it fits.
  const buf = Buffer.from(text, 'utf8');
  let budget = maxBytes - 256;
  for (;;) {
    let head = buf.subarray(0, Math.max(0, budget)).toString('utf8');
    if (head.endsWith('�')) head = head.slice(0, -1);
    const out = { _truncated: true, originalBytes: bytes, head };
    const size = Buffer.byteLength(JSON.stringify(out), 'utf8');
    if (size <= maxBytes || budget <= 0) return out;
    budget -= size - maxBytes + 64;
  }
}
