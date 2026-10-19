import type { RunnerVpsWait, RunnerWaitsOutcome } from "@kelpie/channels";

// Kelpie's check of the waits on the owner (ADR-0057 §5, #434). While the runner is connected,
// Master's AgentHost asks channel-egress's RunnerSessions once a minute for the waits opened since
// a little before its last answer, and tells the owner of each one not told yet. It keeps only
// which waits it told: each one's session and opening time, for a day.

/** How often the check runs: one runner call a minute (ADR-0057 §6). */
export const WATCH_INTERVAL_S = 60;
/**
 * How far before the runner's last answer the next check asks from, so a wait the runner learns
 * of a little late, or a check that runs late, is still asked for.
 */
export const WAIT_OVERLAP_MS = 2 * 60_000;
/**
 * One session's waits this close together are one wait. The runner may move a wait's opening
 * earlier once, when a hook's line lands after a check saw only the session file (ADR-0059 §2).
 */
export const WAIT_JOIN_MS = 60_000;
/** How long a told wait is remembered. The check never asks further back than this. */
export const TOLD_KEEP_MS = 24 * 60 * 60_000;
/** The most told waits remembered: far more than one owner's day of prompts. */
export const MAX_TOLD = 1_000;
/**
 * The most notices one check tries: each is a call to a conversation, and the check must end well
 * within the 30 s the SDK gives an interval's run. The rest wait for the next check.
 */
export const MAX_NOTICES_PER_CHECK = 3;
/** `outdated` answers in a row that stop the check. */
export const MAX_OUTDATED = 3;
/** How long an outdated runner keeps Master's turns from starting the check again. */
export const OUTDATED_PAUSE_MS = 60 * 60_000;

/** Why the check stopped: the runner isn't connected, it is outdated, or the agent isn't Master. */
export type WatchStop = "not_configured" | "not_connected" | "refused" | "outdated" | "not_master";

export interface SessionWatch {
  /** Where the next check asks from, in epoch ms on the runner's clock; null before an answer. */
  since: number | null;
  /** `outdated` answers in a row. */
  outdated: number;
  /** The waits told, by their session's id and opening time, oldest first. */
  told: [string, number][];
  /** Why the check stopped, and when, on the Worker's clock; null while it runs. */
  stopped: { reason: WatchStop; at: number } | null;
}

export const NEW_WATCH: SessionWatch = { since: null, outdated: 0, told: [], stopped: null };

/** What a check reaches outside its object. */
export interface WatchIO {
  /** Whether the agent is Master now. It throws when that can't be read. */
  isMaster(): Promise<boolean>;
  /** RunnerSessions' `waits(since)`. It throws when channel-egress can't be reached. */
  waits(since: number): Promise<RunnerWaitsOutcome>;
  /** Tells the owner of one wait: whether it reached them. It never throws. */
  tell(wait: RunnerVpsWait): Promise<boolean>;
}

/**
 * One check, at `now` on the Worker's clock: the watch to keep after it. A stopped one ends the
 * check's schedule. A check that can't tell whether its agent is Master, or can't reach
 * channel-egress, changes nothing, and the next one tries again.
 */
export async function checkWaits(
  watch: SessionWatch,
  io: WatchIO,
  now: number,
): Promise<SessionWatch> {
  let master: boolean;
  try {
    master = await io.isMaster();
  } catch {
    return watch;
  }
  if (!master) return stop(watch, "not_master", now);
  let outcome: RunnerWaitsOutcome;
  try {
    outcome = await io.waits(Math.max(0, watch.since ?? now - WAIT_OVERLAP_MS));
  } catch (error) {
    console.warn("AgentHost: the VPS's waits weren't read", errorName(error));
    return watch;
  }
  if (!outcome.ok) {
    const { reason } = outcome;
    switch (reason) {
      case "not_configured":
      case "not_connected":
      case "refused":
        return stop(watch, reason, now);
      case "outdated": {
        const outdated = watch.outdated + 1;
        return outdated >= MAX_OUTDATED
          ? stop({ ...watch, outdated }, "outdated", now)
          : { ...watch, outdated };
      }
      default:
        // A runner that can't be reached for now, or a store that failed: the next minute.
        return { ...watch, outdated: 0 };
    }
  }
  let told = watch.told;
  /** The oldest wait not told, which the next check asks for again. */
  let held: number | null = null;
  let tries = 0;
  for (const wait of outcome.waits) {
    if (isTold(told, wait)) continue;
    if (tries < MAX_NOTICES_PER_CHECK) {
      tries += 1;
      if (await io.tell(wait)) {
        told = [...told, [wait.sessionId, wait.openedAt]];
        continue;
      }
    }
    held = Math.min(held ?? wait.openedAt, wait.openedAt);
  }
  // Never further back than it remembers, so a wait it told and forgot is never asked for again.
  const floor = outcome.now - TOLD_KEEP_MS;
  const since = Math.max(
    Math.min(outcome.now - WAIT_OVERLAP_MS, held ?? Number.POSITIVE_INFINITY),
    floor,
  );
  const kept = told
    .filter(([, openedAt]) => openedAt >= floor - WAIT_JOIN_MS)
    .sort((a, b) => a[1] - b[1])
    .slice(-MAX_TOLD);
  return { since, outdated: 0, told: kept, stopped: null };
}

/** Whether Master's turn starts the check: unless an outdated runner stopped it within the hour. */
export function shouldArm(watch: SessionWatch, now: number): boolean {
  return !(watch.stopped?.reason === "outdated" && now - watch.stopped.at < OUTDATED_PAUSE_MS);
}

/** Whether `wait` was told: one of its session's within WAIT_JOIN_MS of it was. */
function isTold(told: readonly [string, number][], wait: RunnerVpsWait): boolean {
  return told.some(
    ([sessionId, openedAt]) =>
      sessionId === wait.sessionId && Math.abs(openedAt - wait.openedAt) < WAIT_JOIN_MS,
  );
}

function stop(watch: SessionWatch, reason: WatchStop, now: number): SessionWatch {
  return { ...watch, stopped: { reason, at: now } };
}

/** Rejects once `ms` pass without an answer. */
export async function bounded<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
