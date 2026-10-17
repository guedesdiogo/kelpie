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

type Reason =
  | "credits"
  | "usage"
  | "rate"
  | "auth"
  | "login"
  | "down"
  | "unreadable"
  | "refused"
  | "failed";

const REASONS: Localized<Record<Reason, string>> = {
  en: {
    credits: "ran out of credits, or reached its spend limit",
    usage: "may have run out of usage, which Kelpie can't confirm",
    rate: "is rate limiting requests",
    auth: "refused Kelpie's key",
    login: "needs its login on the server renewed",
    down: "is unavailable",
    unreadable: "answered in a way Kelpie can't read",
    refused: "refused the request",
    failed: "failed",
  },
  "pt-BR": {
    credits: "ficou sem créditos ou atingiu o limite de gastos",
    usage: "pode ter esgotado o uso, o que o Kelpie não consegue confirmar",
    rate: "está limitando as requisições",
    auth: "recusou a chave do Kelpie",
    login: "precisa que o login no servidor seja renovado",
    down: "está fora do ar",
    unreadable: "respondeu de um jeito que o Kelpie não consegue ler",
    refused: "recusou o pedido",
    failed: "falhou",
  },
  es: {
    credits: "se quedó sin créditos o alcanzó su límite de gasto",
    usage: "puede haber agotado su uso, algo que Kelpie no puede confirmar",
    rate: "está limitando las solicitudes",
    auth: "rechazó la clave de Kelpie",
    login: "necesita que se renueve su sesión en el servidor",
    down: "no está disponible",
    unreadable: "respondió de una forma que Kelpie no puede leer",
    refused: "rechazó la solicitud",
    failed: "falló",
  },
};

/** A usage limit that names its reset, as Claude Code's do (#295): `until` is that time. */
const LIMIT: Localized<(until: string) => string> = {
  en: (until) => `reached its usage limit until ${until}`,
  "pt-BR": (until) => `atingiu o limite de uso até ${until}`,
  es: (until) => `alcanzó su límite de uso hasta ${until}`,
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

/** What failed on a route, as a fallback or an error reports it. */
interface Failure {
  provider?: ProviderId | undefined;
  code: LlmErrorCode;
  resetsAt?: number | undefined;
  unverified?: boolean | undefined;
}

function reasonOf({ provider, code, unverified }: Failure): Reason {
  switch (code) {
    // Read from a text that other failures share, so no one can say the usage really ran out (#295).
    case "out_of_credits":
      return unverified ? "usage" : "credits";
    case "rate_limited":
      return "rate";
    // Claude Code holds no key of Kelpie's: it runs on the server's own login (ADR-0037 §2).
    case "auth":
      return provider === "claude-code" ? "login" : "auth";
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

/** The language tags a limit's reset time is written in. */
const DATE_LOCALES: Record<Locale, string> = { en: "en-US", "pt-BR": "pt-BR", es: "es" };

/**
 * A limit's reset, as the person reads it: day, month and time in their language, in the
 * conversation's time zone. Without one it is UTC, and says so.
 */
function resetTime(epochMs: number, locale: Locale, timeZone: string | null): string {
  const text = new Intl.DateTimeFormat(DATE_LOCALES[locale], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timeZone ?? "UTC",
  }).format(epochMs);
  return timeZone ? text : `${text} UTC`;
}

/** The furthest instant a date holds, either side of 1970. */
const MAX_DATE_MS = 8.64e15;

/**
 * When a usage limit resets, if the route said so (#295) as a time a date can hold. It comes off
 * the wire, and a notice that couldn't be written would cost the reply it follows: anything else
 * is plain rate limiting.
 */
const resetOf = ({ code, resetsAt }: Failure): number | undefined =>
  code === "rate_limited" &&
  typeof resetsAt === "number" &&
  Number.isFinite(resetsAt) &&
  Math.abs(resetsAt) <= MAX_DATE_MS
    ? resetsAt
    : undefined;

/** The reason as the person reads it: a limit says when it resets, in the conversation's zone. */
function wording(failure: Failure, locale: Locale, timeZone: string | null): string {
  const resetsAt = resetOf(failure);
  return resetsAt === undefined
    ? REASONS[locale][reasonOf(failure)]
    : LIMIT[locale](resetTime(resetsAt, locale, timeZone));
}

const route = ({ provider, model }: { provider: ProviderId; model: string }) =>
  `${PROVIDERS[provider] ?? provider} (${model})`;

/**
 * A route and the reason the person reads: two codes worded alike are one notice, and so are two
 * limits, whatever their resets.
 */
const keyOf = ({ failed }: FallbackEvent) =>
  `${failed.provider}:${failed.model}:${resetOf(failed) === undefined ? reasonOf(failed) : "limit"}`;

/**
 * The notice for a turn's fallbacks: one line for each route and reason not announced in the
 * conversation within ROUTE_NOTICE_REPEAT_MS, or null. `announced` maps each announced route and
 * reason to when; the answer's map, without entries older than that, is the one to keep. A limit's
 * reset is told in `timeZone`, the conversation's, or in UTC without one.
 */
export function routeNotice(
  fallbacks: readonly FallbackEvent[],
  announced: Readonly<Record<string, number>>,
  now: number,
  locale: Locale,
  timeZone: string | null = null,
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
        wording(fallback.failed, locale, timeZone),
        route(fallback.next),
      ),
    );
  }
  return { text: lines.length > 0 ? lines.join("\n") : null, announced: kept };
}

/**
 * The notice for a model call no route answered: each route the call fell back from, once, then the
 * route that failed last, as the error names it. Only a tier with no route at all is "the model".
 * Always sent: it stands in for the reply. A limit's reset is told as `routeNotice` tells it.
 */
export function failureNotice(
  fallbacks: readonly FallbackEvent[],
  error: Omit<Failure, "provider"> & {
    route?: { provider: ProviderId; model: string } | undefined;
  },
  locale: Locale,
  timeZone: string | null = null,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const fallback of fallbacks) {
    const key = keyOf(fallback);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`${route(fallback.failed)} ${wording(fallback.failed, locale, timeZone)}`);
  }
  const last = error.route ?? fallbacks.at(-1)?.next;
  const { code, resetsAt, unverified } = error;
  const reason = wording(
    { provider: last?.provider, code, resetsAt, unverified },
    locale,
    timeZone,
  );
  parts.push(`${last ? route(last) : TEXTS[locale].theModel} ${reason}`);
  return TEXTS[locale].failed(parts.join("; "));
}
