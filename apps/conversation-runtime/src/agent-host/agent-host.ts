import type { Remote } from "@kelpie/access";
import type {
  Actor,
  AgentConfig,
  AgentHostContract,
  AgentSettings,
  ConfigureResult,
  EraseResult,
  NewTask,
  RegistryContract,
  RunOutcome,
  SetupEvent,
  SetupStep,
  TaskDetail,
  TaskEdit,
  TaskResult,
  TaskStatus,
  TaskSummary,
  TaskView,
} from "@kelpie/config";
import {
  type AgentRole,
  agentModel,
  DEFAULT_SETTINGS,
  isAgentId,
  isTaskId,
  isTaskStatus,
  parseCommentText,
  parseNewTask,
  parseRunOutcome,
  parseSettings,
  parseTaskEdit,
  REGISTRY_NAME,
  SETUP_AGENT_ID,
} from "@kelpie/config";
import type { CompiledContext, ContextStoreContract } from "@kelpie/context-store/contract";
import type { ModelDescription, ModelSettings } from "@kelpie/llm/models";
import { Agent } from "agents";
import { and, eq, lte } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { SETUP_PROMPT } from "../setup-agent.ts";
import { identitySection } from "./identity.ts";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";
import { composeSystemPrompt, hasVaultContext } from "./system-prompt.ts";
import { TaskBoard } from "./tasks.ts";

let contextStoreForTesting: ContextStoreContract | undefined;

/** Tests run in the Worker's isolate and swap the Context Store with this. Production never calls it. */
export function replaceContextStoreForTesting(store: ContextStoreContract | undefined): void {
  contextStoreForTesting = store;
}

/**
 * Starts a run of a task the agent claimed (#54). The run reports back through `heartbeatTask` and
 * `finishTask`; `start` returns once it began. #335 brings the task conversation that runs tasks.
 */
export interface TaskRunner {
  /** `run` is the run's random token, which its reports must carry. */
  start(agentId: string, task: TaskView, run: string): Promise<void>;
}

let taskRunnerForTesting: TaskRunner | null = null;

/**
 * Tests run in the Worker's isolate and give the board a runner with this. Production has none
 * until #335, so pickup claims nothing: no task waits on a run that can't start.
 */
export function replaceTaskRunnerForTesting(runner: TaskRunner | null): void {
  taskRunnerForTesting = runner;
}

/** A task whose run didn't start is tried again at a wake this much later. */
const START_RETRY_MS = 60_000;
/** Runs that fail to start before a pass of pickup stops trying, until the next wake. */
const MAX_START_FAILURES_PER_PASS = 3;

/** A vault the Context Store can't read in time is replaced by the last one it compiled. */
const COMPILE_TIMEOUT_MS = 3_000;

/**
 * Where a turn's identity comes from (#283): the agent's name and role in the Registry (#314), and
 * its conversation's trio as llm-gateway resolves it (#286).
 */
export interface IdentitySources {
  /** The agent's name and role, or null while the Registry doesn't list it. */
  agent(id: string): Promise<{ name: string; role: AgentRole } | null>;
  describe(agent: ModelSettings): Promise<ModelDescription>;
}

let identitySourcesForTesting: IdentitySources | undefined;

/** Tests run in the Worker's isolate and swap the identity's sources with this. Production never calls it. */
export function replaceIdentitySourcesForTesting(sources: IdentitySources | undefined): void {
  identitySourcesForTesting = sources;
}

/** At most this many conversation names come with an `erase`: the owner's, one per channel. */
const MAX_NAMED_CONVERSATIONS = 32;

/** A conversation object's name of this agent's: its id, a colon, then the channel and thread. */
function isConversationOf(id: string, name: unknown): name is string {
  return (
    isAgentId(id) &&
    typeof name === "string" &&
    name.length <= MAX_CONVERSATION_NAME &&
    name.startsWith(`${id}:`) &&
    name.length > id.length + 1
  );
}

/** A name or trio not read in time is replaced by the last one seen. */
const IDENTITY_TIMEOUT_MS = 1_000;

/**
 * One agent (ADR-0002): its configuration now; its MCP connections, schedules, budget and task
 * board (ADR-0011) as they arrive. It extends the Agents SDK's `Agent` for those. One instance per
 * agent, named by the agent's id.
 */
export class AgentHost extends Agent<Env> implements AgentHostContract {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;
  readonly #tasks: TaskBoard;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
    this.#tasks = new TaskBoard(this.#db, ctx.id.name ?? "");
    // If a migration fails the object resets, and the next request retries it.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#db, migrations);
        this.#dropUnnamedSettings();
      } catch (error) {
        console.error("AgentHost migration failed", error instanceof Error ? error.name : error);
        throw error;
      }
    });
  }

  /**
   * Answers once the migrations ran: the constructor holds every call until then, and a failed
   * migration fails this call. The deploy's probe calls it for every agent the Registry lists
   * (#234).
   */
  ping(): { ok: true } {
    return { ok: true };
  }

  /**
   * The agent's settings, defaults filled in, and its prompt version. The setup agent's default
   * prompt is its built-in persona. A deploy that edits a built-in prompt doesn't bump the version:
   * each turn's prompt key catches a change in the text the model gets (#220).
   */
  config(): AgentConfig {
    return {
      settings: { ...this.#defaults(), ...this.#stored() },
      promptVersion: this.#get("promptVersion", 0),
    };
  }

  #defaults(): AgentSettings {
    return this.ctx.id.name === SETUP_AGENT_ID
      ? { ...DEFAULT_SETTINGS, systemPrompt: SETUP_PROMPT }
      : DEFAULT_SETTINGS;
  }

  /** Only the settings a change set: the others follow the defaults. */
  #stored(): Partial<AgentSettings> {
    return current(this.#get<StoredSettings>("settings", {}));
  }

  /**
   * The settings that differ from the built-in defaults, the only ones stored: a setting set back to
   * its default follows the default again, later edits included (#218).
   */
  #overrides(settings: Partial<AgentSettings>): Partial<AgentSettings> {
    const defaults = this.#defaults();
    return Object.fromEntries(
      Object.entries(settings).filter(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(defaults[key as keyof AgentSettings]),
      ),
    );
  }

  /**
   * Until #212 a change stored the whole settings, so an agent changed before it holds that day's
   * defaults beside its owner's choices, and a later edit to a default never reached it. This keeps
   * only the settings some change named, as the audit log records them, and that differ from the
   * defaults; the others follow the defaults again. A system prompt or memory core that changes by
   * it starts a new prompt version. It runs once per agent, so the audit log decides nothing after
   * it.
   */
  #dropUnnamedSettings(): void {
    if (this.#get("settingsOverridesOnly", false)) return;
    const raw = this.#get<StoredSettings>("settings", {});
    const named = new Set(
      this.#db
        .select({ fields: schema.auditLog.fields })
        .from(schema.auditLog)
        .all()
        .flatMap((row) => row.fields),
    );
    const before = current(raw);
    const kept = this.#overrides(
      Object.fromEntries(Object.entries(before).filter(([key]) => named.has(key))),
    );
    const was = { ...this.#defaults(), ...before };
    const now = { ...this.#defaults(), ...kept };
    const version = this.#get("promptVersion", 0);
    const promptVersion =
      now.systemPrompt === was.systemPrompt && now.memoryCore === was.memoryCore
        ? version
        : version + 1;
    this.#db.transaction((tx) => {
      for (const [key, value] of [
        ["settings", kept],
        ["promptVersion", promptVersion],
        ["settingsOverridesOnly", true],
      ] as const) {
        tx.insert(schema.state)
          .values({ key, value })
          .onConflictDoUpdate({ target: schema.state.key, set: { value } })
          .run();
      }
    });
  }

  /**
   * What a turn runs with: the settings, with the system prompt composed from the agent's identity
   * (#283), then the vault's persona, rules and skills (ADR-0016). A change in the vault bumps the
   * prompt version, as a configured prompt change does. So does a deploy that flips the built-in
   * memory core while the agent follows it (#224): the core isn't in the prompt key, and only turns
   * use it. The first default a turn sees is recorded without a bump. When the Context Store can't
   * answer, the last vault it compiled is used; when the Registry or llm-gateway can't, the last
   * name and trio seen are. The settings' `model` is the agent's own, a tier set before #286
   * included (`agentModel`). A new name or route needs no bump: each turn's prompt key catches the
   * change in the text, as it does a deploy's (#220).
   */
  async turnConfig(conversation?: string): Promise<AgentConfig> {
    const id = this.ctx.id.name ?? "";
    this.#record(id, conversation);
    const sources = this.#identitySources();
    // The stored settings, read before the await: the trio is described for them.
    const model = agentModel(this.#stored());
    const [vault, listed, described] = await Promise.all([
      this.#vaultContext(),
      this.#lookup(
        "identityAgent",
        async () => (await sources.agent(id)) ?? { name: id, role: null },
      ),
      this.#lookup("identityModel", () => sources.describe(model)),
    ]);
    // Read after the await: another call or a configure may have run meanwhile, and the compare,
    // the bump and the write below are one synchronous step.
    const config = this.config();
    const key = hasVaultContext(vault) ? JSON.stringify(vault) : "";
    const vaultChanged = key !== this.#get("vaultContext", "");
    const builtInCore = this.#defaults().memoryCore;
    const seenCore = this.#get<boolean | null>("defaultMemoryCore", null);
    const coreFlipped =
      seenCore !== null && seenCore !== builtInCore && this.#stored().memoryCore === undefined;
    const rows: [string, unknown][] = [];
    if (vaultChanged) rows.push(["vaultContext", key]);
    for (const [stateKey, looked] of [
      ["identityAgent", listed],
      ["identityModel", described],
    ] as const) {
      const changed = JSON.stringify(looked.value) !== JSON.stringify(this.#get(stateKey, null));
      if (looked.fresh && changed) rows.push([stateKey, looked.value]);
    }
    if (seenCore !== builtInCore) rows.push(["defaultMemoryCore", builtInCore]);
    const bump = vaultChanged || coreFlipped;
    const promptVersion = bump ? config.promptVersion + 1 : config.promptVersion;
    if (bump) rows.push(["promptVersion", promptVersion]);
    if (rows.length > 0) {
      this.#db.transaction((tx) => {
        for (const [stateKey, value] of rows) {
          tx.insert(schema.state)
            .values({ key: stateKey, value })
            .onConflictDoUpdate({ target: schema.state.key, set: { value } })
            .run();
        }
      });
    }
    const identity = identitySection({
      id,
      name: listed.value?.name ?? id,
      role: listed.value?.role ?? null,
      model: described.value,
    });
    return {
      settings: {
        ...config.settings,
        model,
        systemPrompt: `${identity}\n\n${composeSystemPrompt(config.settings.systemPrompt, vault)}`,
      },
      promptVersion,
    };
  }

  /**
   * Notes a conversation of this agent's that starts a turn, so deleting the agent erases it
   * (#303). A caller from before this release names none.
   */
  #record(id: string, conversation: string | undefined): void {
    if (!isConversationOf(id, conversation)) return;
    this.#db
      .insert(schema.conversations)
      .values({ name: conversation })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Deletes everything this agent holds, before its Registry row goes (#303): each conversation it
   * recorded or the caller names, which only this agent's may be, then its own storage. The SDK's
   * `destroy` clears the alarm and the storage, then ends the object; a later call finds it empty.
   * A failure leaves this object as it was, with its list, so erasing again finishes the job.
   */
  async erase(names: string[]): Promise<EraseResult> {
    const id = this.ctx.id.name ?? "";
    if (
      !Array.isArray(names) ||
      names.length > MAX_NAMED_CONVERSATIONS ||
      !names.every((name) => isConversationOf(id, name))
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    const recorded = this.#db
      .select({ name: schema.conversations.name })
      .from(schema.conversations)
      .all()
      .map((row) => row.name);
    const all = new Set([...recorded, ...names]);
    for (const name of all) await this.env.CONVERSATION_AGENT.getByName(name).destroy();
    await this.destroy();
    return { ok: true, conversations: all.size };
  }

  /**
   * The task board (ADR-0011, #54). The commands authorize the actor (ADR-0013); these methods
   * parse their input again, because they are an RPC boundary. Every change that may free a slot
   * or queue a task picks up eligible ones and sets the next wake.
   */
  async createTask(input: NewTask, actor: Actor): Promise<TaskResult<TaskView>> {
    const now = Date.now();
    const task = parseNewTask(input, now);
    if (!task || !isOwnerActor(actor)) return invalidTask;
    return this.#afterPickup(this.#tasks.create(task, actor, crypto.randomUUID(), now));
  }

  async editTask(id: string, changes: TaskEdit, actor: Actor): Promise<TaskResult<TaskView>> {
    const edit = parseTaskEdit(changes, Date.now());
    if (!isTaskId(id) || !edit || !isOwnerActor(actor)) return invalidTask;
    return this.#afterPickup(this.#tasks.edit(id, edit, actor, Date.now()));
  }

  async moveTask(
    id: string,
    status: "backlog" | "todo",
    actor: Actor,
  ): Promise<TaskResult<TaskView>> {
    if (!isTaskId(id) || (status !== "backlog" && status !== "todo") || !isOwnerActor(actor)) {
      return invalidTask;
    }
    return this.#afterPickup(this.#tasks.move(id, status, actor, Date.now()));
  }

  commentTask(id: string, text: string, actor: Actor): TaskResult<TaskView> {
    const comment = parseCommentText(text);
    if (!isTaskId(id) || comment === null || !isOwnerActor(actor)) return invalidTask;
    return this.#tasks.comment(id, comment, actor, Date.now());
  }

  async requestStop(id: string, actor: Actor): Promise<TaskResult<TaskView>> {
    if (!isTaskId(id) || !isOwnerActor(actor)) return invalidTask;
    return this.#afterPickup(this.#tasks.requestStop(id, actor, Date.now()));
  }

  listTasks(status?: TaskStatus): TaskSummary[] {
    return this.#tasks.list(isTaskStatus(status) ? status : undefined);
  }

  getTask(id: string): TaskResult<TaskDetail> {
    return isTaskId(id) ? this.#tasks.get(id) : invalidTask;
  }

  /**
   * A run's heartbeat (#335 calls it): extends its lease, and says whether to stop. `run` is the
   * token its claim gave it.
   */
  heartbeatTask(id: string, run: string) {
    if (!isTaskId(id) || !isTaskId(run)) {
      return { ok: false as const, reason: "not_running" as const };
    }
    return this.#tasks.heartbeat(id, run, Date.now());
  }

  /** A run's end (#335 calls it), by the token its claim gave it. Done needs a result. */
  async finishTask(id: string, run: string, outcome: RunOutcome): Promise<TaskResult<TaskView>> {
    const parsed = parseRunOutcome(outcome);
    if (!isTaskId(id) || !isTaskId(run) || !parsed) return invalidTask;
    return this.#afterPickup(this.#tasks.finish(id, run, parsed, Date.now()));
  }

  /** The board's wake, as the SDK schedules it: sweeps leases, picks up tasks, sets the next one. */
  async wakeTasks(): Promise<void> {
    await this.#tasksChanged();
  }

  /** Runs pickup after a change, then answers with the task as it is now: perhaps claimed. */
  async #afterPickup(result: TaskResult<TaskView>): Promise<TaskResult<TaskView>> {
    if (!result.ok) return result;
    await this.#tasksChanged();
    return this.#tasks.view(result.value.id);
  }

  /**
   * Sweeps the leases that ran out, claims eligible tasks while slots are free, and sets the next
   * wake. Each claim checks the slots again, so concurrent calls never run more than the limit.
   * A task whose run didn't start waits for the next wake, a minute later, and a pass gives up
   * after a few such failures. Without a runner nothing is claimed, and no model is ever called
   * for an empty board. It is best effort: the change that called it is already saved.
   */
  async #tasksChanged(): Promise<void> {
    try {
      const agentId = this.ctx.id.name ?? "";
      const runner = taskRunnerForTesting;
      this.#tasks.sweep(Date.now());
      const failed = new Set<string>();
      while (runner && failed.size < MAX_START_FAILURES_PER_PASS) {
        const max = this.config().settings.maxConcurrentTasks;
        const claimed = this.#tasks.claimNext(max, Date.now(), failed);
        if (!claimed) break;
        try {
          await runner.start(agentId, claimed.task, claimed.run);
        } catch (error) {
          console.error("AgentHost: a task's run didn't start", errorName(error));
          failed.add(claimed.task.id);
          this.#tasks.finish(
            claimed.task.id,
            claimed.run,
            { status: "failed" },
            Date.now(),
            "start_failed",
          );
        }
      }
      await this.#scheduleTaskWake(runner !== null, failed.size > 0);
    } catch (error) {
      console.error("AgentHost: the task board's pickup failed", errorName(error));
    }
  }

  /** One SDK schedule for the board's next wake, moved when that time changes. */
  async #scheduleTaskWake(canRun: boolean, retry: boolean): Promise<void> {
    const now = Date.now();
    let due = this.#tasks.nextWake(now, canRun);
    if (retry) due = Math.min(due ?? Number.POSITIVE_INFINITY, now + START_RETRY_MS);
    // The SDK keeps schedule times in whole seconds: the next one, so a wake is never early.
    const next = due === null ? null : Math.ceil(due / 1_000) * 1_000;
    const wake = this.#get<{ id: string; at: number } | null>("taskWake", null);
    if (wake && next !== null && wake.at === next && (await this.getScheduleById(wake.id))) return;
    if (wake) await this.cancelSchedule(wake.id);
    if (next === null) {
      this.#db.delete(schema.state).where(eq(schema.state.key, "taskWake")).run();
      return;
    }
    const schedule = await this.schedule(new Date(next), "wakeTasks");
    const value = { id: schedule.id, at: next };
    this.#db
      .insert(schema.state)
      .values({ key: "taskWake", value })
      .onConflictDoUpdate({ target: schema.state.key, set: { value } })
      .run();
  }

  #identitySources(): IdentitySources {
    if (identitySourcesForTesting) return identitySourcesForTesting;
    const registry = this.env.REGISTRY.getByName(
      REGISTRY_NAME,
    ) as unknown as Remote<RegistryContract>;
    const gateway = this.env.LLM_GATEWAY as unknown as {
      describe(area: "conversation", agent: ModelSettings): Promise<ModelDescription>;
    };
    return {
      agent: async (id) => {
        const entry = await registry.get(id);
        return entry ? { name: entry.name, role: entry.role } : null;
      },
      describe: (agent) => gateway.describe("conversation", agent),
    };
  }

  /**
   * One fact of the identity (#283), and whether it was just read. A source that fails, or takes
   * longer than IDENTITY_TIMEOUT_MS, gives the last value seen, or null if it never answered: a
   * turn neither fails nor waits for it, as when a partial rollback leaves an older llm-gateway.
   */
  async #lookup<T>(
    key: string,
    read: () => Promise<T>,
  ): Promise<{ value: T | null; fresh: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), IDENTITY_TIMEOUT_MS);
        }),
      ]);
      return { value, fresh: true };
    } catch (error) {
      console.error(`AgentHost: reading ${key} failed; using the last one`, errorName(error));
      return { value: this.#get<T | null>(key, null), fresh: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #vaultContext(): Promise<CompiledContext | null> {
    const agentId = this.ctx.id.name;
    const store =
      contextStoreForTesting ?? (this.env.CONTEXT_STORE as unknown as ContextStoreContract);
    if (!agentId) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        store.compile(agentId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), COMPILE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      console.error("AgentHost: the Context Store failed; using the last vault", errorName(error));
      const last = this.#get("vaultContext", "");
      return last === "" ? null : (JSON.parse(last) as CompiledContext);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Applies changes and audits them. The configuration commands are its only callers and authorize
   * the actor (ADR-0013); this validates the changes again, because it is an RPC boundary. A new
   * system prompt bumps the prompt version, and so does turning the memory core on or off (#112).
   * Setting the current values changes nothing, so it isn't audited.
   */
  configure(changes: Partial<AgentSettings>, actor: Actor): ConfigureResult {
    const parsed = parseSettings(changes);
    if (!parsed) return { ok: false, reason: "invalid_input" };
    const current = this.config();
    const fields = (Object.keys(parsed) as (keyof AgentSettings)[]).filter(
      (key) => JSON.stringify(parsed[key]) !== JSON.stringify(current.settings[key]),
    );
    if (fields.length === 0) return { ok: true, value: current };
    const settings = { ...current.settings, ...parsed };
    const promptVersion =
      settings.systemPrompt === current.settings.systemPrompt &&
      settings.memoryCore === current.settings.memoryCore
        ? current.promptVersion
        : current.promptVersion + 1;
    const stored = this.#overrides({
      ...this.#stored(),
      ...Object.fromEntries(fields.map((key) => [key, parsed[key]])),
    });
    this.#db.transaction((tx) => {
      for (const [key, value] of [
        ["settings", stored],
        ["promptVersion", promptVersion],
      ] as const) {
        tx.insert(schema.state)
          .values({ key, value })
          .onConflictDoUpdate({ target: schema.state.key, set: { value } })
          .run();
      }
      tx.insert(schema.auditLog)
        .values({
          at: Date.now(),
          action: "settings.changed",
          userId: actor.userId,
          via: actor.via,
          fields,
          promptVersion,
        })
        .run();
    });
    return { ok: true, value: { settings, promptVersion } };
  }

  /**
   * Notes that a conversation waits for a step of this agent (#206). Waiting again moves its end.
   * An RPC boundary, so the values are checked; a bad one is ignored.
   */
  awaitSetup(conversation: string, step: SetupStep, until: number): void {
    if (
      typeof conversation !== "string" ||
      conversation === "" ||
      conversation.length > MAX_CONVERSATION_NAME ||
      !isSetupStep(step) ||
      !Number.isFinite(until)
    ) {
      return;
    }
    const now = Date.now();
    this.#pruneWaits(now);
    // No wait outlasts the longest a link does.
    const capped = Math.min(until, now + MAX_SETUP_WAIT_MS);
    this.#db
      .insert(schema.setupWaits)
      .values({ conversation, step, until: capped })
      .onConflictDoUpdate({
        target: [schema.setupWaits.conversation, schema.setupWaits.step],
        set: { until: capped },
      })
      .run();
  }

  /**
   * Tells each conversation still waiting for the event's step that the owner finished it. A wait
   * ends once its conversation took the event; one it couldn't reach stays, for the next report.
   * Expired waits go first.
   */
  async setupDone(event: SetupEvent): Promise<void> {
    const agentId = this.ctx.id.name;
    if (!agentId || !isSetupStep(event?.step)) return;
    this.#pruneWaits(Date.now());
    const waiting = this.#db
      .select({ conversation: schema.setupWaits.conversation })
      .from(schema.setupWaits)
      .where(eq(schema.setupWaits.step, event.step))
      .all();
    for (const { conversation } of waiting) {
      try {
        await this.env.CONVERSATION_AGENT.getByName(conversation).setupDone(agentId, event);
      } catch (error) {
        console.error("AgentHost: a conversation wasn't told a setup step", errorName(error));
        continue;
      }
      this.#db
        .delete(schema.setupWaits)
        .where(
          and(
            eq(schema.setupWaits.conversation, conversation),
            eq(schema.setupWaits.step, event.step),
          ),
        )
        .run();
    }
  }

  /**
   * Drops the waits whose links ran out, a grace past their end: a form submitted in its last
   * seconds is reported a moment after.
   */
  #pruneWaits(now: number): void {
    this.#db
      .delete(schema.setupWaits)
      .where(lte(schema.setupWaits.until, now - SETUP_WAIT_GRACE_MS))
      .run();
  }

  #get<T>(key: string, fallback: T): T {
    const row = this.#db
      .select({ value: schema.state.value })
      .from(schema.state)
      .where(eq(schema.state.key, key))
      .get();
    return row ? (row.value as T) : fallback;
  }
}

/** Every setup step: a new one doesn't compile until it is here. */
const SETUP_STEPS: Record<SetupStep, true> = { telegram_connected: true, telegram_paired: true };
const isSetupStep = (step: unknown): step is SetupStep =>
  typeof step === "string" && Object.hasOwn(SETUP_STEPS, step);
/** The longest a link lasts: a day for the pairing page, whose Telegram code starts later. */
const MAX_SETUP_WAIT_MS = 24 * 60 * 60_000;
/** How long past its end a wait still takes a report. */
const SETUP_WAIT_GRACE_MS = 5 * 60_000;
/** A conversation object's name is an agent id, a channel and a thread id. */
const MAX_CONVERSATION_NAME = 256;

const invalidTask = { ok: false, reason: "invalid_input" } as const;

/**
 * The owner, as the commands build the actor: a user id and a channel, never empty. Only the owner
 * changes tasks while Kelpie is single-player (ADR-0015).
 */
function isOwnerActor(actor: unknown): actor is Actor {
  const { userId, role, via } = (actor ?? {}) as Partial<Actor>;
  return (
    typeof userId === "string" &&
    userId !== "" &&
    userId.length <= 128 &&
    role === "owner" &&
    typeof via === "string" &&
    via !== "" &&
    via.length <= 128
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

/** Settings as stored; those saved before ADR-0024 also carry the end-of-turn windows. */
type StoredSettings = Partial<AgentSettings> & { quietWindow?: unknown };

/**
 * A change stored the whole settings until #212, so settings saved before ADR-0024 hold the old
 * windows and the old 10 s cap, which would cut the new fixed wait short: both give way to the
 * defaults.
 */
function current(stored: StoredSettings): Partial<AgentSettings> {
  if (!("quietWindow" in stored)) return stored;
  const { quietWindow: _windows, maxWaitMs: _cap, ...rest } = stored;
  return rest;
}
