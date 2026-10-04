import { DIRECTORY_NAME } from "@kelpie/access";
import {
  type Actor,
  type AgentConfig,
  type AgentSettings,
  type ConfigPorts,
  type ConfigureResult,
  createConfigCommands,
  REGISTRY_NAME,
} from "@kelpie/config";
import { remoteKeySet, verifyAccessJwt } from "./access-jwt.ts";
import { type AdminDeps, handle } from "./api.ts";

// The bindings point at objects in other Workers, so their types come from the contracts here.
type DirectoryStub = AdminDeps["directory"] & ConfigPorts["directory"];
interface AgentHostStub {
  configure(changes: Partial<AgentSettings>, actor: Actor): Promise<ConfigureResult>;
  config(): Promise<AgentConfig>;
}

function depsFor(env: Env): AdminDeps {
  const directory = env.DIRECTORY.getByName(DIRECTORY_NAME) as unknown as DirectoryStub;
  const registry = env.REGISTRY.getByName(REGISTRY_NAME) as unknown as ConfigPorts["registry"];
  const agentHost = (id: string) => env.AGENT_HOST.getByName(id) as unknown as AgentHostStub;
  const config = { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD };
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
    }),
    bootstrapToken: env.BOOTSTRAP_TOKEN,
    now: () => Date.now(),
    newUserId: () => crypto.randomUUID(),
  };
}

export default {
  fetch: (request, env) => handle(request, depsFor(env)),
} satisfies ExportedHandler<Env>;
