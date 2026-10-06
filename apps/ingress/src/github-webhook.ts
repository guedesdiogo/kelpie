/** Where GitHub sends the vault's push webhook (docs/context-store.md). */
export const GITHUB_WEBHOOK_PATH = "/github/webhook";

/** GitHub caps a delivery at 25 MB; a vault push is far smaller, so anything past this is refused. */
const MAX_BODY_BYTES = 5_000_000;

export interface GitHubWebhookDeps {
  /** context-store's GitHubWebhooks entrypoint, which holds the secret and checks the signature. */
  receive(delivery: {
    event: string | null;
    signature: string | null;
    body: string;
  }): Promise<{ status: number }>;
}

/** The body as text, or null past the limit. It counts bytes as they arrive, chunked or not. */
async function readCapped(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Hands GitHub's webhook to context-store; ingress is public and holds no secret. A request without
 * a well-formed signature is refused before its body is read.
 */
export async function handleGitHubWebhook(
  request: Request,
  deps: GitHubWebhookDeps,
): Promise<Response> {
  const signature = request.headers.get("x-hub-signature-256");
  if (signature === null || !/^sha256=[0-9a-f]{64}$/i.test(signature)) {
    return new Response(null, { status: 401 });
  }
  const body = await readCapped(request);
  if (body === null) return new Response(null, { status: 413 });
  const { status } = await deps.receive({
    event: request.headers.get("x-github-event"),
    signature,
    body,
  });
  return new Response(null, { status });
}
