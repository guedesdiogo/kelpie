// Most fixtures are built from the providers' documented stream formats. OpenAI's recorded streams
// from the manual smoke test (#57) are in test/recorded; Anthropic's wait for a key.

export interface RecordedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Responder = (signal: AbortSignal | undefined) => Response;

/** A `fetch` that answers with the given responses in order and records each request. */
export function fakeFetch(...responders: Responder[]) {
  const calls: RecordedRequest[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: new Headers(init?.headers),
      // A GET, such as the Models API's, has no body.
      body: (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>,
    });
    const responder = responders[calls.length - 1];
    if (!responder) throw new Error(`Unexpected request #${calls.length}`);
    return responder(init?.signal ?? undefined);
  };
  return { fetch: fetchFn as typeof fetch, calls };
}

/** The recorded request at `index`; fails the test if there is none. */
export function requestAt(calls: RecordedRequest[], index: number): RecordedRequest {
  const call = calls[index];
  if (!call) throw new Error(`No request #${index + 1} was made`);
  return call;
}

type SseEvent = { type: string; [key: string]: unknown };

const encoder = new TextEncoder();

function frames(events: readonly SseEvent[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** A complete server-sent event stream. */
export function sse(events: readonly SseEvent[]): Responder {
  return () => new Response(frames(events), { headers: { "content-type": "text/event-stream" } });
}

/** A stream that sends the given events, then stays open until the request is aborted. */
export function hangingSse(events: readonly SseEvent[]): Responder {
  return (signal) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(frames(events)));
          signal?.addEventListener("abort", () =>
            controller.error(new DOMException("The operation was aborted.", "AbortError")),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
}

/** A JSON response, such as a page of the Models API. */
export function json(body: unknown): Responder {
  return () => Response.json(body);
}

/** An HTTP error the SDK must not retry. */
export function httpError(status: number, body: unknown): Responder {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-should-retry": "false" },
    });
}

export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}
