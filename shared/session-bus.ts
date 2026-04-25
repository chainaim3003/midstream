// shared/session-bus.ts
//
// Session-scoped, typed, replayable event bus.
//
// Why we designed this (instead of reusing AgentSwarm's tracker.ts):
//
//   AgentSwarm's tracker is a global EventEmitter singleton that records
//   transactions in a flat array. That works for their model where one
//   persistent server handles one global stream of agent-to-agent txs.
//
//   Our model is different:
//     * Many concurrent demo sessions, each with its own lifecycle.
//     * A session has a rich event stream (chunks, quality scores, kill
//       decision, settlements) — not just payment rows.
//     * A browser tab may open AFTER a session starts; it should see the
//       full history, not miss what happened before.
//     * Headless demo runs need the same event stream without a browser.
//
//   So we built:
//     * SessionBus — one bus per session, holds that session's events.
//     * Replay on subscribe — late subscribers get the full history then
//       live updates.
//     * Typed SessionEvent schema (see events.ts) — the bus is aware of the
//       event shapes and enforces they carry sessionId + ts.
//     * Lifecycle tracking — `endedAt` marks a terminal session; the
//       registry can reap old ones.
//     * Unsubscribe returns a disposer — no hunting for the right `.off()`.
//
// This is one of the few files where it's worth being opinionated; it's the
// coordination point between the buyer library and any observer.

import { EventEmitter } from "node:events";
import type { SessionEvent } from "./events.js";
import { isTerminal } from "./events.js";

// Distributive Omit: standard `Omit<T, K>` over a discriminated union
// collapses the union into a single non-discriminating shape, which loses
// the per-variant property typing. `T extends unknown ? Omit<T, K> : never`
// distributes the Omit across each member of the union, preserving each
// variant's discriminator and its variant-specific fields.
//
// Without this, calling `bus.publish({ type: "session-started", useCase: ... })`
// fails to type-check because `useCase` is not present on the collapsed type.
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

// Shape accepted by SessionBus.publish(): one of the SessionEvent variants,
// minus sessionId and ts (which the bus stamps), with ts optionally provided.
export type PublishableEvent = DistributiveOmit<SessionEvent, "sessionId" | "ts"> & {
  ts?: number;
};

export class SessionBus {
  readonly sessionId: string;
  readonly startedAt: number;
  private _endedAt: number | null = null;
  private readonly events: SessionEvent[] = [];
  private readonly emitter = new EventEmitter();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.startedAt = Date.now();
    // Avoid Node's default 10-subscriber warning — a browser tab + dashboard
    // + demo CLI may legitimately subscribe simultaneously.
    this.emitter.setMaxListeners(50);
  }

  get endedAt(): number | null {
    return this._endedAt;
  }

  get isComplete(): boolean {
    return this._endedAt !== null;
  }

  /**
   * Publish an event to the session. Stamps sessionId and ts if missing.
   * Emits synchronously to all live subscribers.
   */
  publish(event: PublishableEvent): void {
    const full = {
      ...event,
      sessionId: this.sessionId,
      ts: event.ts ?? Date.now(),
    } as SessionEvent;

    this.events.push(full);
    this.emitter.emit("event", full);

    if (isTerminal(full)) {
      this._endedAt = full.ts;
      this.emitter.emit("end", full);
    }
  }

  /**
   * Subscribe with replay. The listener is invoked once per historical event
   * (in insertion order), then for every future event until unsubscribed.
   * Returns a function that, when called, removes the subscription.
   */
  subscribe(listener: (e: SessionEvent) => void): () => void {
    // Replay — snapshot first, then attach. A push during iteration would be
    // surfaced through the live emitter since we register BEFORE iterating.
    this.emitter.on("event", listener);
    for (const e of this.events) {
      try {
        listener(e);
      } catch (err) {
        // One broken subscriber must not poison the emitter.
        console.error(`[SessionBus ${this.sessionId}] subscriber threw during replay:`, err);
      }
    }
    return () => this.emitter.off("event", listener);
  }

  /**
   * Wait for the session to terminate. Resolves with the terminal event.
   * If already terminated, resolves on next microtask.
   */
  waitForEnd(): Promise<SessionEvent> {
    return new Promise((resolve) => {
      if (this._endedAt !== null) {
        // Return the last event that ended us.
        const last = this.events[this.events.length - 1]!;
        queueMicrotask(() => resolve(last));
        return;
      }
      this.emitter.once("end", resolve);
    });
  }

  /** Read-only snapshot of all events so far. */
  snapshot(): readonly SessionEvent[] {
    return this.events.slice();
  }
}

// ---------------------------------------------------------------------------
// Registry — owns SessionBus instances, cleans up completed ones.
// ---------------------------------------------------------------------------

export interface SessionRegistryOptions {
  /** Sessions older than this (since endedAt) are reaped. Default 10 min. */
  completedTtlMs?: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionBus>();
  private readonly completedTtlMs: number;
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(opts: SessionRegistryOptions = {}) {
    this.completedTtlMs = opts.completedTtlMs ?? 10 * 60 * 1000;
  }

  /** Create a new session and register it. */
  create(sessionId: string): SessionBus {
    if (this.sessions.has(sessionId)) {
      throw new Error(`SessionBus already exists for ${sessionId}`);
    }
    const bus = new SessionBus(sessionId);
    this.sessions.set(sessionId, bus);
    return bus;
  }

  get(sessionId: string): SessionBus | undefined {
    return this.sessions.get(sessionId);
  }

  count(): number {
    return this.sessions.size;
  }

  /**
   * Start a periodic reaper that drops completed sessions older than TTL.
   * Returns a disposer. Call at most once per registry.
   */
  startReaper(intervalMs = 30_000): () => void {
    if (this.reaperTimer) {
      throw new Error("reaper already started");
    }
    this.reaperTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, bus] of this.sessions) {
        if (bus.endedAt !== null && now - bus.endedAt > this.completedTtlMs) {
          this.sessions.delete(id);
        }
      }
    }, intervalMs).unref();
    return () => {
      if (this.reaperTimer) {
        clearInterval(this.reaperTimer);
        this.reaperTimer = null;
      }
    };
  }
}
