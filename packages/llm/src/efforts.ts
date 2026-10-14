import type { Effort } from "./types.ts";

/** From the least effort to the most. */
export const EFFORTS: readonly string[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies Effort[];

// Models that take fewer efforts than all five, by id or dated id. Every model in today's routes
// takes all five; these are older ids an owner may pin (platform.claude.com, models overview).
const LIMITED_EFFORTS: ReadonlyArray<[model: string, efforts: readonly Effort[]]> = [
  ["claude-opus-4-6", ["low", "medium", "high", "max"]],
  ["claude-sonnet-4-6", ["low", "medium", "high", "max"]],
  ["claude-opus-4-5", ["low", "medium", "high"]],
  ["claude-haiku-4-5", []],
  ["claude-sonnet-4-5", []],
];

/** The effort a model gets: the one asked, or the nearest weaker one it supports, or none. */
export function lowerEffort(model: string, effort: Effort | undefined): Effort | undefined {
  if (effort === undefined) return undefined;
  const limited = LIMITED_EFFORTS.find(([id]) => model === id || model.startsWith(`${id}-`));
  if (!limited) return effort;
  const supported = limited[1];
  return EFFORTS.slice(0, EFFORTS.indexOf(effort) + 1)
    .reverse()
    .find((level): level is Effort => supported.includes(level as Effort));
}
