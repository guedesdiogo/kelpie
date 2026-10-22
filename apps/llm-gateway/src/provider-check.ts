import { isModelKey, isModelKeyValue, type ModelKey, type ModelKeyCheck } from "@kelpie/channels";

// How a model key's form checks a candidate key before it is stored (ADR-0068 §2): one cheap
// authenticated read on its service, such as listing the provider's models, which spends no
// tokens. Nothing is kept: the key isn't cached, logged or used for anything else.

/** How long one call of a check waits for its answer. */
const CHECK_TIMEOUT_MS = 5_000;

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
/** A Cloudflare account id, as AI Gateway's URLs carry it. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** The base URLs that may name an AI Gateway, and so the account its token belongs to. */
interface CheckEnv {
  ANTHROPIC_BASE_URL: string;
  OPENAI_BASE_URL: string;
}

type Answer = "accepted" | "refused" | "unreachable";

const refusedIfForbidden = (answer: Answer | "forbidden"): Answer =>
  answer === "forbidden" ? "refused" : answer;

/**
 * Checks `value` as the key of `name`'s slot. The providers' keys list their models; AI Gateway's
 * token goes to Cloudflare's token verification, as a user's token, then as the token of the
 * account a configured gateway names. An account's token (`cfat_`) with no gateway to name its
 * account can't be checked, so it is stored `unchecked`.
 */
export async function checkModelKey(
  env: CheckEnv,
  name: ModelKey,
  value: string,
): Promise<ModelKeyCheck | "invalid_input"> {
  if (!isModelKey(name) || !isModelKeyValue(value)) return "invalid_input";
  switch (name) {
    case "anthropic":
      return refusedIfForbidden(
        await listed("https://api.anthropic.com/v1/models?limit=1", {
          "x-api-key": value,
          "anthropic-version": "2023-06-01",
        }),
      );
    case "openai": {
      // A restricted key without the models' read scope gets a 403, yet may serve: it is stored
      // unchecked. A wrong key gets a 401.
      const answer = await listed("https://api.openai.com/v1/models", {
        authorization: `Bearer ${value}`,
      });
      return answer === "forbidden" ? "unchecked" : answer;
    }
    case "typesafe":
      return refusedIfForbidden(
        await listed("https://api.typesafe.ai/v1/models", { authorization: `Bearer ${value}` }),
      );
    case "ai-gateway":
      return gatewayToken(env, value);
  }
}

/**
 * A provider's models list: listed is accepted, a 401 refused, and a 403 `forbidden`, which each
 * provider reads its own way. Anything else is a failure for now.
 */
async function listed(url: string, headers: Record<string, string>): Promise<Answer | "forbidden"> {
  const response = await call(url, headers);
  if (!response) return "unreachable";
  await response.body?.cancel();
  if (response.ok) return "accepted";
  if (response.status === 401) return "refused";
  if (response.status === 403) return "forbidden";
  console.warn("llm-gateway: a key's check couldn't tell", response.status);
  return "unreachable";
}

async function gatewayToken(env: CheckEnv, token: string): Promise<ModelKeyCheck> {
  const headers = { authorization: `Bearer ${token}` };
  const asUser = await verified(`${CLOUDFLARE_API}/user/tokens/verify`, headers);
  if (asUser === "accepted") return asUser;
  const account = gatewayAccount(env);
  const asAccount = account
    ? await verified(`${CLOUDFLARE_API}/accounts/${account}/tokens/verify`, headers)
    : null;
  if (asAccount === "accepted") return asAccount;
  if (asUser === "unreachable" || asAccount === "unreachable") return "unreachable";
  return asAccount === null && token.startsWith("cfat_") ? "unchecked" : "refused";
}

/**
 * Cloudflare's verification of a token: active is accepted; an answer that it isn't, or a 400, 401
 * or 403, as a token in another format or of another kind gets, is refused.
 */
async function verified(url: string, headers: Record<string, string>): Promise<Answer> {
  const response = await call(url, headers);
  if (!response) return "unreachable";
  if ([400, 401, 403].includes(response.status)) {
    await response.body?.cancel();
    return "refused";
  }
  if (!response.ok) {
    await response.body?.cancel();
    console.warn("llm-gateway: a key's check couldn't tell", response.status);
    return "unreachable";
  }
  try {
    const body = (await response.json()) as { success?: unknown; result?: { status?: unknown } };
    return body?.success === true && body.result?.status === "active" ? "accepted" : "refused";
  } catch {
    return "unreachable";
  }
}

/** The account in the first AI Gateway URL the Worker sends calls through, if any. */
function gatewayAccount(env: CheckEnv): string | null {
  for (const base of [env.ANTHROPIC_BASE_URL, env.OPENAI_BASE_URL]) {
    try {
      const url = new URL(base);
      const account = url.pathname.split("/")[2] ?? "";
      if (url.hostname === AI_GATEWAY_HOST && ACCOUNT_ID.test(account)) return account;
    } catch {
      // A base URL that doesn't parse names no account; ping reports it.
    }
  }
  return null;
}

/** One GET, without following a redirect; null when it fails or times out. Never logs the key. */
async function call(url: string, headers: Record<string, string>): Promise<Response | null> {
  try {
    const response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    return response;
  } catch (error) {
    console.warn(
      "llm-gateway: a key's check failed",
      error instanceof Error ? error.name : "unknown",
    );
    return null;
  }
}
