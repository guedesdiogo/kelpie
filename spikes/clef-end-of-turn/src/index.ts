import { endOfTurn, maskPersonalData, type QualifyResult } from "@kelpie/qualifier";

// Throwaway Worker for the Clef end-of-turn spike (issue #117). It sends the request production
// sends to Jev (`endOfTurn`'s masked state and questions, with `runDecision`'s prefix) to a Clef
// model through the Workers AI binding, and times the call.

export const MODELS = ["clef", "clef-flash"] as const;
export type Model = (typeof MODELS)[number];

interface QualifyRequest {
  fragments: string[];
  model: Model;
}

/** The part of the AI binding this Worker uses; the generated types may not list Clef yet. */
type RunModel = (model: string, input: Record<string, unknown>) => Promise<unknown>;

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
    if (
      !Array.isArray(body.fragments) ||
      !body.fragments.every((f) => typeof f === "string") ||
      !MODELS.includes(body.model)
    ) {
      return new Response("bad request", { status: 400 });
    }

    const context = { fragments: body.fragments };
    const prefix = `${endOfTurn.id}::`;
    const questions = Object.fromEntries(
      Object.entries(endOfTurn.questions(context)).map(([key, question]) => [
        prefix + key,
        question,
      ]),
    );
    const colo = (request.cf as { colo?: string } | undefined)?.colo ?? null;
    const run = env.AI.run.bind(env.AI) as unknown as RunModel;

    // Workers advance the clock on I/O, so this measures the model call.
    const started = Date.now();
    try {
      const raw = await run(`@cf/cloudflare/${body.model}`, {
        model: body.model,
        state: maskPersonalData(endOfTurn.state(context)),
        questions,
      });
      const ms = Date.now() - started;
      return Response.json({ ok: true, ms, colo, raw, policy: policyOnRaw(raw, prefix, context) });
    } catch (error) {
      const ms = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, ms, colo, error: message.slice(0, 500) });
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * What the production policy concludes when handed Clef's answers as they arrive: `{ finished }`,
 * or null, which means production would always fall back to the heuristic.
 */
function policyOnRaw(raw: unknown, prefix: string, context: { fragments: string[] }) {
  const answers = (raw as { answers?: Record<string, unknown> } | null)?.answers ?? {};
  const stripped = Object.fromEntries(
    Object.entries(answers)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, answer]) => [key.slice(prefix.length), answer]),
  ) as QualifyResult["answers"];
  return endOfTurn.policy({ answers: stripped, provider: "fake", calibrated: true }, context);
}

async function tokenMatches(presented: string | null, expected: string): Promise<boolean> {
  if (!presented || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [presented, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
  return crypto.subtle.timingSafeEqual(a as ArrayBuffer, b as ArrayBuffer);
}
