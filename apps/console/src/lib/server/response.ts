import type { ApiResponse } from "@alarmops/api";

/**
 * ApiResponse -> fetch Response. A JSON body is serialised; a `stream` (the CSV export, API-CONTRACT §8.4) is written
 * chunk by chunk as it is produced: headers go out first. If the generator fails in the middle, the stream is aborted
 * (the client sees a network error and the download fails): nothing is appended to a half-written file, and no JSON
 * error is mixed into a CSV body. Nothing of the error reaches the client.
 */
export function toResponse(res: ApiResponse, log: (msg: string) => void = (m) => console.error(m)): Response {
  if (res.stream) {
    const it = res.stream[Symbol.asyncIterator]();
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const n = await it.next();
          if (n.done) controller.close();
          else controller.enqueue(enc.encode(n.value));
        } catch (e) {
          log(`[api] stream aborted: ${e instanceof Error ? e.name : "error"}`);
          controller.error(new Error("stream aborted"));
        }
      },
      async cancel() { try { await it.return?.(); } catch { /* the source failed while closing: nothing more to do */ } },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  }
  const noBody = res.status === 204 || res.status === 304 || res.body === undefined;
  return new Response(noBody ? null : JSON.stringify(res.body), { status: res.status, headers: res.headers });
}
