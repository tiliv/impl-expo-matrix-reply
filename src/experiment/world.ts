/**
 * The experiment's stand-in for a synced room.
 *
 * This implements the adapter interfaces with plain objects. It is a fake
 * *transport*, not a fake *policy*: room settings still arrive as state events
 * and still go through `resolveRoomSettings`. The control panel cannot set a
 * setting except by sending the state event that carries it.
 */

import { ManualClock } from '../core/clock';
import { RoomStateStore } from '../core/roomState';
import type { EventId, Envelope, RoomId, TimelineLookup } from '../core/types';
import type { RoomStateSource, TimelineSource } from '../adapters';

export interface WorldOptions {
  roomId?: RoomId;
  /** Fixed so scenarios are reproducible and snapshots do not drift. */
  startTs?: number;
  viewer?: string;
}

/** Anchored, not `Date.now()`: two runs of a scenario must look identical. */
export const EPOCH = Date.UTC(2026, 0, 15, 12, 0, 0);

export class ExperimentWorld {
  readonly roomId: RoomId;
  readonly clock: ManualClock;
  readonly stateStore = new RoomStateStore();
  viewer: string;

  private envelopeList: Envelope[] = [];
  /** Ids the server has dropped: present in a reply pointer, gone from history. */
  private pruned = new Set<EventId>();
  /** Ids withheld from us by history visibility. */
  private forbidden = new Set<EventId>();
  /** Ids that exist remotely but are not in our local slice yet. */
  private notYetBackfilled = new Set<EventId>();
  private listeners = new Set<() => void>();
  private backfillTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Bumped on every change. React subscribes to this integer rather than to
   * derived state, because `resolveRoomSettings` returns a fresh object each
   * call and `useSyncExternalStore` would loop forever on an unstable snapshot.
   */
  revision = 0;

  /** How long a simulated backfill takes, so `pending` is actually visible. */
  backfillLatencyMs = 1800;

  constructor(opts: WorldOptions = {}) {
    this.roomId = opts.roomId ?? '!experiment:example.org';
    this.clock = new ManualClock(opts.startTs ?? EPOCH);
    this.viewer = opts.viewer ?? '@you:example.org';
    this.stateStore.subscribe(() => this.emit());
    this.clock.subscribe(() => this.emit());
  }

  // --- arrangement, used by scenarios and the panel -----------------------

  reset(): void {
    this.backfillTimers.forEach(clearTimeout);
    this.backfillTimers.clear();
    this.envelopeList = [];
    this.pruned.clear();
    this.forbidden.clear();
    this.notYetBackfilled.clear();
    this.stateStore.reset([]);
    this.clock.pause();
    this.clock.set(EPOCH);
    this.emit();
  }

  add(...envelopes: Envelope[]): this {
    this.envelopeList.push(...envelopes);
    this.envelopeList.sort((a, b) => a.originTs - b.originTs);
    this.emit();
    return this;
  }

  /** The event is real, but the server has thrown it away. */
  markPruned(id: EventId): this {
    this.pruned.add(id);
    this.emit();
    return this;
  }

  /** The event is real, but we are not allowed to read it. */
  markForbidden(id: EventId): this {
    this.forbidden.add(id);
    this.emit();
    return this;
  }

  /** The event is real and fetchable, just not local yet. */
  markNotBackfilled(id: EventId): this {
    this.notYetBackfilled.add(id);
    this.emit();
    return this;
  }

  redact(id: EventId, by = '@moderator:example.org'): this {
    const target = this.envelopeList.find((e) => e.id === id);
    if (target) target.redaction = { at: this.clock.now(), by };
    this.emit();
    return this;
  }

  // --- adapter implementations -------------------------------------------

  lookup(id: EventId): TimelineLookup {
    if (this.forbidden.has(id)) return { status: 'forbidden' };
    if (this.pruned.has(id)) return { status: 'pruned' };
    if (this.notYetBackfilled.has(id)) return { status: 'unknown' };
    const envelope = this.envelopeList.find((e) => e.id === id);
    return envelope ? { status: 'found', envelope } : { status: 'unknown' };
  }

  envelopes(): Envelope[] {
    return this.envelopeList;
  }

  /**
   * Simulated network. The delay is the point: it is what makes the `pending`
   * branch of the union something you can actually see on screen rather than a
   * state you have to take on faith.
   */
  requestBackfill(id: EventId): void {
    if (!this.notYetBackfilled.has(id)) return;
    const timer = setTimeout(() => {
      this.backfillTimers.delete(timer);
      this.notYetBackfilled.delete(id);
      this.emit();
    }, this.backfillLatencyMs);
    this.backfillTimers.add(timer);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.backfillTimers.forEach(clearTimeout);
    this.backfillTimers.clear();
    this.clock.pause();
  }

  private emit(): void {
    this.revision += 1;
    this.listeners.forEach((l) => l());
  }

  getRevision = (): number => this.revision;

  get timelineSource(): TimelineSource {
    return {
      lookup: this.lookup.bind(this),
      envelopes: this.envelopes.bind(this),
      requestBackfill: this.requestBackfill.bind(this),
      subscribe: this.subscribe.bind(this),
    };
  }

  get roomStateSource(): RoomStateSource {
    return {
      roomId: this.roomId,
      state: () => this.stateStore,
      subscribe: this.subscribe.bind(this),
    };
  }
}

let envelopeSeq = 0;

export function envelope(partial: Partial<Envelope> & Pick<Envelope, 'sender' | 'body'>): Envelope {
  envelopeSeq += 1;
  return {
    id: partial.id ?? `$e${envelopeSeq}`,
    roomId: partial.roomId ?? '!experiment:example.org',
    originTs: partial.originTs ?? EPOCH,
    ...partial,
  };
}

export const text = (s: string): Envelope['body'] => ({ kind: 'text', text: s });

export function replyTo(id: EventId): Pick<Envelope, 'replyTo'> {
  return { replyTo: { relType: 'app.envelope.reply', eventId: id } };
}
