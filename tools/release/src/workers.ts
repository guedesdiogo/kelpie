/** One of Kelpie's Workers, as the release tooling deploys and rolls it back. */
export interface WorkerSpec {
  /** Its directory under `apps/`. */
  readonly app: string;
  /** Its script name on Cloudflare, the `name` in its `wrangler.jsonc`. */
  readonly script: string;
  /**
   * Vars that belong to one instance. The owner sets each once with `--var` (docs/deploy.md); every
   * later deploy carries it from the live version, so the values stay out of the repository and
   * out of GitHub.
   */
  readonly instanceVars: readonly string[];
}

/**
 * Kelpie's six Workers in deploy order: each one's bindings point only at Workers before it
 * (docs/admin-api.md, "Setting it up"). Rollbacks go in the reverse order.
 */
export const WORKERS: readonly WorkerSpec[] = [
  // AI Gateway's passthrough URLs carry the account id.
  {
    app: "llm-gateway",
    script: "kelpie-llm-gateway",
    instanceVars: ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"],
  },
  { app: "channel-egress", script: "kelpie-channel-egress", instanceVars: ["INGRESS_ORIGIN"] },
  {
    app: "context-store",
    script: "kelpie-context-store",
    instanceVars: ["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "VAULT_REPOSITORY"],
  },
  {
    app: "conversation-runtime",
    script: "kelpie-conversation-runtime",
    instanceVars: ["ADMIN_ORIGIN"],
  },
  { app: "ingress", script: "kelpie-ingress", instanceVars: ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"] },
  {
    app: "admin-api",
    script: "kelpie-admin-api",
    instanceVars: ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"],
  },
];

/** The Worker that answers the post-deploy probes. */
export const INGRESS = "kelpie-ingress";

/** The live var that holds ingress's public origin, on `channel-egress` (docs/secrets.md). */
export const INGRESS_ORIGIN = { script: "kelpie-channel-egress", name: "INGRESS_ORIGIN" } as const;
