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
  type ConfigPorts,
  createConfigCommands,
  REGISTRY_NAME,
  type RegistryContract,
} from "@kelpie/config";
import type { ContextStoreAdminContract } from "@kelpie/context-store/contract";
import { type AdminDeps, handle } from "./api.ts";

/** The part of llm-gateway's RPC surface the model commands use (#289). */
type ModelsGateway = {
  providers: ConfigPorts["models"]["providers"];
  instanceModels: ConfigPorts["models"]["view"];
  configureDefaults: ConfigPorts["models"]["configure"];
};

/** The admin API's dependencies on this Worker's bindings; exported for the Worker's own test. */
export function depsFor(env: Env): AdminDeps {
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
  const gateway = env.LLM_GATEWAY_ADMIN as unknown as ModelsGateway;
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
        erase: (id, conversations) => agentHost(id).erase(conversations),
      },
      directory,
      tasks: {
        create: (agentId, task, actor) => agentHost(agentId).createTask(task, actor),
        edit: (agentId, taskId, edit, actor) => agentHost(agentId).editTask(taskId, edit, actor),
        move: (agentId, taskId, status, actor) =>
          agentHost(agentId).moveTask(taskId, status, actor),
        comment: (agentId, taskId, text, actor) =>
          agentHost(agentId).commentTask(taskId, text, actor),
        requestStop: (agentId, taskId, actor) => agentHost(agentId).requestStop(taskId, actor),
        list: (agentId, status) => agentHost(agentId).listTasks(status),
        get: (agentId, taskId) => agentHost(agentId).getTask(taskId),
      },
      channels: {
        createTelegramForm: (agentId) => forms.createTelegramForm(agentId),
        registerTelegramWebhook: (agentId) => forms.registerTelegramWebhook(agentId),
        describeTelegramBot: (agentId) => forms.describeTelegramBot(agentId),
        createRunnerForm: () => forms.createRunnerForm(),
        describeRunner: () => forms.describeRunner(),
        disconnectTelegram: (agentId) => forms.disconnectTelegram(agentId),
      },
      models: {
        providers: () => gateway.providers(),
        view: () => gateway.instanceModels(),
        configure: (settings, actor) => gateway.configureDefaults(settings, actor),
      },
      vault: {
        held: () => vault.held(),
        forget: (paths) => vault.forget(paths),
        setDream: (mode, writes) => vault.setDream(mode, writes),
      },
    }),
    forms,
    setupDone: async (agentId, event) => agentHost(agentId).setupDone(event),
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
