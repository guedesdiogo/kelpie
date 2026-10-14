import { parseJsonc } from "./jsonc.ts";

/** Bindings a deploy adds to a Worker's committed config, because they belong to one instance. */
export interface ConfigAdditions {
  /** Workers VPC Services (#294): the runner's, on `channel-egress`. */
  vpc_services: { binding: string; service_id: string }[];
}

/**
 * The Worker's `wrangler.jsonc` with `additions` merged in, as JSON. `wrangler deploy` takes no
 * binding as a flag, so the release tool writes this next to the committed config and deploys it.
 */
export function withAdditions(configText: string, additions: ConfigAdditions): string {
  const config = parseJsonc(configText) as { vpc_services?: ConfigAdditions["vpc_services"] };
  const merged = {
    ...config,
    vpc_services: [...(config.vpc_services ?? []), ...additions.vpc_services],
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}
