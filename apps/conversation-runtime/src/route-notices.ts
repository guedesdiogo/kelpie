import type { Locale, Localized } from "@kelpie/channels";
import type { FallbackEvent, LlmErrorCode, ProviderId } from "@kelpie/llm";

// What Kelpie tells the conversation when a route to a model fails (ADR-0037 §4, #293): no route
// fails silently. These are Kelpie's fixed texts (ADR-0027), never the provider's own message.

/** A route and reason announced in a conversation aren't announced again for this long. */
export const ROUTE_NOTICE_REPEAT_MS = 24 * 60 * 60_000;

const PROVIDERS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "claude-code": "Claude Code",
};

type Reason = "credits" | "rate" | "auth" | "down" | "unreadable" | "refused" | "failed";

const REASONS: Localized<Record<Reason, string>> = {
  en: {
    credits: "ran out of credits, or reached its spend limit",
    rate: "is rate limiting requests",
    auth: "refused Kelpie's key",
    down: "is unavailable",
    unreadable: "answered in a way Kelpie can't read",
    refused: "refused the request",
    failed: "failed",
  },
  "pt-BR": {
    credits: "ficou sem créditos ou atingiu o limite de gastos",
    rate: "está limitando as requisições",
    auth: "recusou a chave do Kelpie",
    down: "está fora do ar",
    unreadable: "respondeu de um jeito que o Kelpie não consegue ler",
    refused: "recusou o pedido",
    failed: "falhou",
  },
  es: {
    credits: "se quedó sin créditos o alcanzó su límite de gasto",
    rate: "está limitando las solicitudes",
    auth: "rechazó la clave de Kelpie",
    down: "no está disponible",
    unreadable: "respondió de una forma que Kelpie no puede leer",
    refused: "rechazó la solicitud",
    failed: "falló",
  },
};

const TEXTS: Localized<{
  fellBack: (failed: string, reason: string, next: string) => string;
  failed: (parts: string) => string;
  theModel: string;
}> = {
  en: {
    fellBack: (failed, reason, next) => `Note: ${failed} ${reason}, so ${next} answered.`,
    failed: (parts) => `I couldn't answer this message: ${parts}.`,
    theModel: "the model",
  },
  "pt-BR": {
    fellBack: (failed, reason, next) => `Aviso: ${failed} ${reason}, então ${next} respondeu.`,
    failed: (parts) => `Não consegui responder a esta mensagem: ${parts}.`,
    theModel: "o modelo",
  },
  es: {
    fellBack: (failed, reason, next) => `Aviso: ${failed} ${reason}, así que respondió ${next}.`,
    failed: (parts) => `No pude responder a este mensaje: ${parts}.`,
    theModel: "el modelo",
  },
};

function reasonOf(code: LlmErrorCode): Reason {
  switch (code) {
    case "out_of_credits":
      return "credits";
    case "rate_limited":
      return "rate";
    case "auth":
      return "auth";
    // `unavailable` also covers a model alias that couldn't be resolved, not only a missing key.
    case "server_error":
    case "connection":
    case "unavailable":
      return "down";
    case "protocol":
      return "unreadable";
    case "bad_request":
      return "refused";
    default:
      return "failed";
  }
}

const route = ({ provider, model }: { provider: ProviderId; model: string }) =>
  `${PROVIDERS[provider] ?? provider} (${model})`;

/** A route and the reason the person reads: two codes worded alike are one notice. */
const keyOf = ({ failed }: FallbackEvent) =>
  `${failed.provider}:${failed.model}:${reasonOf(failed.code)}`;

/**
 * The notice for a turn's fallbacks: one line for each route and reason not announced in the
 * conversation within ROUTE_NOTICE_REPEAT_MS, or null. `announced` maps each announced route and
 * reason to when; the answer's map, without entries older than that, is the one to keep.
 */
export function routeNotice(
  fallbacks: readonly FallbackEvent[],
  announced: Readonly<Record<string, number>>,
  now: number,
  locale: Locale,
): { text: string | null; announced: Record<string, number> } {
  const kept: Record<string, number> = {};
  for (const [key, at] of Object.entries(announced)) {
    if (now - at <= ROUTE_NOTICE_REPEAT_MS) kept[key] = at;
  }
  const lines: string[] = [];
  for (const fallback of fallbacks) {
    const key = keyOf(fallback);
    const at = kept[key];
    if (at !== undefined && now - at < ROUTE_NOTICE_REPEAT_MS) continue;
    kept[key] = now;
    lines.push(
      TEXTS[locale].fellBack(
        route(fallback.failed),
        REASONS[locale][reasonOf(fallback.failed.code)],
        route(fallback.next),
      ),
    );
  }
  return { text: lines.length > 0 ? lines.join("\n") : null, announced: kept };
}

/**
 * The notice for a model call no route answered: each route the call fell back from, once, then the
 * route that failed last, as the error names it. Only a tier with no route at all is "the model".
 * Always sent: it stands in for the reply.
 */
export function failureNotice(
  fallbacks: readonly FallbackEvent[],
  error: { code: LlmErrorCode; route?: { provider: ProviderId; model: string } | undefined },
  locale: Locale,
): string {
  const reasons = REASONS[locale];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const fallback of fallbacks) {
    const key = keyOf(fallback);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`${route(fallback.failed)} ${reasons[reasonOf(fallback.failed.code)]}`);
  }
  const last = error.route ?? fallbacks.at(-1)?.next;
  parts.push(`${last ? route(last) : TEXTS[locale].theModel} ${reasons[reasonOf(error.code)]}`);
  return TEXTS[locale].failed(parts.join("; "));
}
