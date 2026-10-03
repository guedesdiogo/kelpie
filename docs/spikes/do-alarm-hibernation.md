# Spike: does a scheduled alarm let a Durable Object hibernate?

- **Date:** 2026-10-03
- **Issue:** [#26](https://github.com/guedesdiogo/kelpie/issues/26)
- **Status:** assumption confirmed

## Question

The viability study's cost baseline assumes that a Durable Object waiting on a scheduled alarm can hibernate, so it stops accruing duration. On that assumption the small scenario costs about US$ 5 a month; if it is wrong, about US$ 18 ([study §10](../viability-study.md#10-cost), [research note 00, C2](../research/00-cross-check.md)). The docs list a pending `setTimeout` among the things that prevent hibernation. They don't list a scheduled alarm, but they don't say outright that it is fine either.

## Method

1. A throwaway Worker, `kelpie-spike-do-hibernation`, was deployed to the owner's personal Cloudflare account. It defines three SQLite-backed Durable Object classes, each in its own namespace so metrics can be told apart:
   - `AlarmPending` schedules an alarm 20 minutes ahead (`setAlarm`) and then goes idle. This is the hypothesis.
   - `TimerPending` starts a 20-minute `setTimeout` and then goes idle. This is the control, documented as preventing hibernation.
   - `NothingPending` returns, with nothing left pending. This is the baseline.
2. One instance of each was armed at **21:13:45 UTC** through a single request, then left untouched until the alarm was due (21:33:45 UTC).
3. Per-namespace `activeTime` and `cpuTime` were read from the GraphQL Analytics API (`durableObjectsPeriodicGroups`). The objects' stored timestamps then showed whether the alarm and the timer fired.

The Worker source is in the appendix. The Worker was deleted after the measurement.

## Result

| Object | Active time | Accrued duration (GB·s) | Requests | Did it fire? |
|---|---|---|---|---|
| `AlarmPending` | 0.55 s: 0.42 s while being armed, 0.12 s when the alarm ran | 0.07 | 3 at 21:13, 1 alarm at 21:33 | **Yes**, at 21:33:45.420 UTC, on schedule |
| `TimerPending` | 904 s, without a break from 21:13 to about 21:28:14 | 115.75 | 3 at 21:13 | **No.** The object was evicted after about 15 minutes, and the in-memory timer was lost with it |
| `NothingPending` | 0.36 s | 0.05 | 3 at 21:13 | — |

Each object received three requests at 21:13: the arm call and two status reads. Every full minute the timer object stayed awake accrued 60 s × 0.128 GB = 7.68 GB·s of duration, the metric Cloudflare bills on Workers Paid. The alarm object accrued nothing between being armed and the alarm firing 20 minutes later. The numbers are the `duration` and `activeTime` metrics; whether this account is on Workers Paid was not checked, and that doesn't change the metric.

## Consequences

- **A scheduled alarm does not keep a Durable Object active or accruing duration, and the alarm still fires on time after the object goes idle.** The US$ 5/month baseline in the study holds.
- **A pending `setTimeout` keeps the object active and accruing duration for about 15 minutes. Then the object is evicted and the timer is silently lost.** For waits, an in-memory timer is both expensive and unreliable.
- **Rule for Kelpie:** debounce and any wait longer than a few seconds use alarms. ADR-0002 already requires this for the debounce, and the `DebounceBuffer` in #32 follows it. In-memory timers are only for pacing bubbles within an active turn, where the persisted outbox recovers from an eviction.
- **Limits of this spike:** one object per case, so the result is directional. Hibernatable WebSockets and behavior under load were not measured.

## Appendix: Worker source

```ts
import { DurableObject } from "cloudflare:workers";

const WAIT_MS = 20 * 60 * 1000;

interface Env {
  ALARM_PENDING: DurableObjectNamespace<AlarmPending>;
  TIMER_PENDING: DurableObjectNamespace<TimerPending>;
  NOTHING_PENDING: DurableObjectNamespace<NothingPending>;
}

// A scheduled alarm, then idle: the hypothesis is that this object can hibernate.
export class AlarmPending extends DurableObject<Env> {
  async arm(): Promise<string> {
    await this.ctx.storage.setAlarm(Date.now() + WAIT_MS);
    return `alarm set for ${new Date(Date.now() + WAIT_MS).toISOString()}`;
  }
  async alarm(): Promise<void> {
    this.ctx.storage.kv.put("alarmFiredAt", new Date().toISOString());
  }
  async status(): Promise<unknown> {
    return { alarm: await this.ctx.storage.getAlarm(), firedAt: this.ctx.storage.kv.get("alarmFiredAt") ?? null };
  }
}

// A pending setTimeout: the control, documented as preventing hibernation.
export class TimerPending extends DurableObject<Env> {
  async arm(): Promise<string> {
    setTimeout(() => this.ctx.storage.kv.put("timerFiredAt", new Date().toISOString()), WAIT_MS);
    return "timer set";
  }
  async status(): Promise<unknown> {
    return { firedAt: this.ctx.storage.kv.get("timerFiredAt") ?? null };
  }
}

// Nothing pending after the request: the baseline.
export class NothingPending extends DurableObject<Env> {
  async arm(): Promise<string> {
    return "nothing pending";
  }
  async status(): Promise<unknown> {
    return {};
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);
    const stubs = {
      alarm: env.ALARM_PENDING.getByName("probe"),
      timer: env.TIMER_PENDING.getByName("probe"),
      nothing: env.NOTHING_PENDING.getByName("probe"),
    };
    if (action === "arm") {
      return Response.json({
        alarm: await stubs.alarm.arm(),
        timer: await stubs.timer.arm(),
        nothing: await stubs.nothing.arm(),
      });
    }
    if (action === "status") {
      return Response.json({
        alarm: await stubs.alarm.status(),
        timer: await stubs.timer.status(),
        nothing: await stubs.nothing.status(),
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```
