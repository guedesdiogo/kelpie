import {
  DIRECTORY_NAME,
  type DirectoryContract,
  type Remote,
  remoteKeySet,
  verifyAccessJwt,
} from "@kelpie/access";
import type { ChannelFormsContract } from "@kelpie/channels";
import {
  type AgentHostContract,
  createConfigCommands,
  REGISTRY_NAME,
  type RegistryContract,
} from "@kelpie/config";
import type { ContextStoreAdminContract } from "@kelpie/context-store/contract";
import { type AdminDeps, handle } from "./api.ts";

function depsFor(env: Env): AdminDeps {
  // The bindings point at objects in other Workers, which `wrangler types` can't type; the
  // objects implement these contracts, so the casts can't drift from them.
  const directory = env.DIRECTORY.getByName(DIRECTORY_NAME) as unknown as Remote<DirectoryContract>;
  const registry = env.REGISTRY.getByName(REGISTRY_NAME) as unknown as Remote<RegistryContract>;
  const agentHost = (id: string) =>
    env.AGENT_HOST.getByName(id) as unknown as Remote<AgentHostContract>;
  // A service binding to channel-egress's ChannelForms entrypoint, which returns values only.
  const forms = env.CHANNEL_FORMS as unknown as ChannelFormsContract;
  // A service binding to context-store's ContextStoreAdmin entrypoint, which only admin-api binds.
  const vault = env.CONTEXT_STORE_ADMIN as unknown as ContextStoreAdminContract;
  // A trailing slash would never match the token's issuer.
  const config = {
    teamDomain: env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, ""),
    audience: env.ACCESS_AUD,
  };
  const keys = remoteKeySet(`${config.teamDomain}/cdn-cgi/access/certs`);
  return {
    authenticate: (request) =>
      verifyAccessJwt(
        request.headers.get("cf-access-jwt-assertion"),
        config,
        keys,
        Math.floor(Date.now() / 1_000),
      ),
    directory,
    commands: createConfigCommands({
      registry,
      agents: {
        configure: (id, changes, actor) => agentHost(id).configure(changes, actor),
        config: (id) => agentHost(id).config(),
      },
      directory,
      channels: {
        createTelegramForm: (agentId) => forms.createTelegramForm(agentId),
        registerTelegramWebhook: (agentId) => forms.registerTelegramWebhook(agentId),
        describeTelegramBot: (agentId) => forms.describeTelegramBot(agentId),
      },
      vault: {
        held: () => vault.held(),
        forget: (paths) => vault.forget(paths),
        setDream: (mode) => vault.setDream(mode),
      },
    }),
    forms,
    bootstrapToken: env.BOOTSTRAP_TOKEN,
    // Optional: set only during a recovery and deleted after it, so `secrets.required` can't list
    // it, and `wrangler types` leaves it out of `Env`.
    recoveryToken: (env as Env & { RECOVERY_TOKEN?: string }).RECOVERY_TOKEN,
    now: () => Date.now(),
    newUserId: () => crypto.randomUUID(),
  };
}

export default {
  fetch: (request, env) => handle(request, depsFor(env)),
} satisfies ExportedHandler<Env>;
