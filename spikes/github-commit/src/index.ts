import { runExperiment } from "./experiment.ts";

/**
 * Throwaway Worker for issue #28. `POST /run` with `x-spike-token: <SPIKE_TOKEN>` runs the whole
 * experiment against the test repository and returns the JSON report. Nothing else is served.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/run") {
      return new Response("Not found", { status: 404 });
    }
    if (!(await authorized(request, env.SPIKE_TOKEN))) {
      return new Response("Unauthorized", { status: 401 });
    }
    const report = await runExperiment({
      appId: env.GITHUB_APP_ID,
      installationId: env.GITHUB_INSTALLATION_ID,
      repository: env.GITHUB_REPOSITORY,
      privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    });
    return Response.json(report, { status: report.completed ? 200 : 502 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Compares `x-spike-token` with the expected value in constant time. Hashing first gives both sides
 * the same length. A missing or empty value on either side never matches.
 */
export async function authorized(request: Request, expected: string | undefined): Promise<boolean> {
  const presented = request.headers.get("x-spike-token");
  if (!expected || !presented) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}
