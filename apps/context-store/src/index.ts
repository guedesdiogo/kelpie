import { WorkerEntrypoint } from "cloudflare:workers";
import { parsePushEvent, verifyWebhookSignature } from "@kelpie/vault";
import type {
  CompiledContext,
  ContextStoreAdminContract,
  ContextStoreContract,
  ForgetResult,
  HeldFile,
  MemorySearchOptions,
  MemorySearchResult,
  ProposalTarget,
  ProposeResult,
  RecallOptions,
  RecallResult,
  WriteResult,
} from "./contract.ts";
import { VAULT_NAME, type VaultEnv } from "./vault.ts";

export {
  type MemoryGateway,
  replaceBackendForTesting,
  replaceGatewayForTesting,
  Vault,
} from "./vault.ts";

/** The vault for Kelpie's other Workers, through a service binding (ADR-0005). */
export class ContextStore extends WorkerEntrypoint<VaultEnv> implements ContextStoreContract {
  #vault() {
    return this.env.VAULT.getByName(VAULT_NAME);
  }

  compile(agentId: string): Promise<CompiledContext> {
    return this.#vault().compile(agentId);
  }

  read(path: string): Promise<string | null> {
    return this.#vault().read(path);
  }

  write(
    agentId: string,
    changes: { path: string; content: string | null }[],
    summary: string,
  ): Promise<WriteResult> {
    return this.#vault().write(agentId, changes, summary);
  }

  propose(
    agentId: string,
    target: ProposalTarget,
    content: string,
    reason: string,
  ): Promise<ProposeResult> {
    return this.#vault().propose(agentId, target, content, reason);
  }

  recall(agentId: string, question: string, options: RecallOptions): Promise<RecallResult> {
    return this.#vault().recall(agentId, question, options);
  }

  search(
    agentId: string,
    query: string,
    options: MemorySearchOptions,
  ): Promise<MemorySearchResult> {
    return this.#vault().search(agentId, query, options);
  }
}

/** The owner's actions on the vault, for admin-api alone (#114). */
export class ContextStoreAdmin
  extends WorkerEntrypoint<VaultEnv>
  implements ContextStoreAdminContract
{
  #vault() {
    return this.env.VAULT.getByName(VAULT_NAME);
  }

  held(): Promise<HeldFile[]> {
    return this.#vault().held();
  }

  forget(paths: string[]): Promise<ForgetResult> {
    return this.#vault().forget(paths);
  }
}

/** A delivery of GitHub's webhook, as ingress received it. */
export interface WebhookDelivery {
  /** `X-GitHub-Event`. */
  event: string | null;
  /** `X-Hub-Signature-256`. */
  signature: string | null;
  body: string;
}

/**
 * GitHub's webhook, handed over by ingress, which is public and holds no secret: this entrypoint
 * holds the webhook secret and checks the signature, as channel-egress does for Telegram's.
 */
export class GitHubWebhooks extends WorkerEntrypoint<VaultEnv> {
  async receive(delivery: WebhookDelivery): Promise<{ status: number }> {
    const verified = await verifyWebhookSignature(
      this.env.GITHUB_WEBHOOK_SECRET ?? "",
      delivery.body,
      delivery.signature,
    );
    if (!verified) return { status: 401 };
    if (delivery.event === "ping") return { status: 200 };
    if (delivery.event !== "push") return { status: 202 };
    let payload: unknown;
    try {
      payload = JSON.parse(delivery.body);
    } catch {
      return { status: 400 };
    }
    const push = parsePushEvent(payload);
    if (push) await this.env.VAULT.getByName(VAULT_NAME).requestSync(push.ref);
    return { status: 202 };
  }
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<VaultEnv>;
