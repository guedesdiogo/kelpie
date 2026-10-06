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

/** Hands GitHub's webhook to context-store; ingress is public and holds no secret. */
export async function handleGitHubWebhook(
  request: Request,
  deps: GitHubWebhookDeps,
): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const { status } = await deps.receive({
    event: request.headers.get("x-github-event"),
    signature: request.headers.get("x-hub-signature-256"),
    body,
  });
  return new Response(null, { status });
}
