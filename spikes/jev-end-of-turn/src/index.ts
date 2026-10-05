import { endOfTurn, type QualifyResult } from "@kelpie/qualifier";

/** The production request, or a variant that changes one thing, to find what the schema refuses. */
interface QualifyRequest {
  fragments: string[];
  /** `runDecision`'s `turn.end::` key prefix. Production sends it. */
  prefix?: boolean;
  /** Adds `criteria: {true, false}` to the noul question, as Cloudflare's examples do. Production doesn't. */
  criteria?: boolean;
}

type JevRun = (
  model: string,
  input: unknown,
  options: { gateway: { id: string } },
) => Promise<unknown>;

const NOUL_CRITERIA = {
  true: "The user has finished and is waiting for a reply",
  false: "The user is still typing and more fragments are coming",
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/qualify") {
      return new Response("not found", { status: 404 });
    }
    if (!(await tokenMatches(request.headers.get("x-spike-token"), env.SPIKE_TOKEN))) {
      return new Response("forbidden", { status: 403 });
    }
    const body = (await request.json()) as QualifyRequest;
    if (!Array.isArray(body.fragments) || !body.fragments.every((f) => typeof f === "string")) {
      return new Response("bad request", { status: 400 });
    }

    const context = { fragments: body.fragments };
    const prefix = body.prefix === false ? "" : `${endOfTurn.id}::`;
    const questions = Object.fromEntries(
      Object.entries(endOfTurn.questions(context)).map(([key, question]) => [
        prefix + key,
        body.criteria && question.type === "noul"
          ? { ...question, criteria: NOUL_CRITERIA }
          : question,
      ]),
    );
    const run = env.AI.run.bind(env.AI) as unknown as JevRun;
    const colo = (request.cf as { colo?: string } | undefined)?.colo ?? null;

    // Workers advance the clock on I/O, so this measures the binding call and nothing else.
    const started = Date.now();
    try {
      const raw = await run(
        "typesafe/jev",
        { state: endOfTurn.state(context), questions },
        { gateway: { id: env.GATEWAY_ID } },
      );
      const ms = Date.now() - started;
      return Response.json({ ok: true, ms, colo, raw, policy: policyOnRaw(raw, prefix, context) });
    } catch (error) {
      const ms = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, ms, colo, error: message });
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * What the production policy concludes when handed Jev's answers as they arrive: `{ finished }`,
 * or null, which means production would always fall back to the heuristic.
 */
function policyOnRaw(raw: unknown, prefix: string, context: { fragments: string[] }) {
  const answers = (raw as { answers?: Record<string, unknown> } | null)?.answers ?? {};
  const stripped = Object.fromEntries(
    Object.entries(answers)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, answer]) => [key.slice(prefix.length), answer]),
  ) as QualifyResult["answers"];
  return endOfTurn.policy(
    { answers: stripped, provider: "jev-workers-ai", calibrated: true },
    context,
  );
}

async function tokenMatches(presented: string | null, expected: string): Promise<boolean> {
  if (!presented || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [presented, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
  return crypto.subtle.timingSafeEqual(a as ArrayBuffer, b as ArrayBuffer);
}
