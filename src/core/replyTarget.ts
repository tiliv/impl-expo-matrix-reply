/**
 * "What am I replying to?" — every honest answer.
 *
 * This union is the actual deliverable of this template. The reason a reply
 * quote is hard is not layout, it is that the parent has about eight ways of
 * not being there, and a UI that only handles "found" and "not found" will
 * ship placeholders that lie: showing "message deleted" for a message that
 * merely has not been backfilled yet, or showing nothing at all for a message
 * that was actually redacted.
 *
 * Making the union exhaustive forces the renderer to have an opinion about
 * each case, and `never`-checks the day someone adds a ninth.
 */

import { isReadable, lifecycleOf, type Lifecycle } from './lifecycle';
import type { ExpiredParentBehavior, RoomSettings } from './settings';
import type { DecryptionFailure, Envelope, EventId, TimelineSlice } from './types';

export interface QuotePreview {
  sender: string;
  kind: 'text' | 'media' | 'mixed';
  /** Already truncated to the room's preview length. */
  text: string | null;
  truncated: boolean;
  /** "Photo", "Video · 0:14", "3 items" — set for non-text bodies. */
  mediaSummary: string | null;
  thumbnailUri: string | null;
  edited: boolean;
}

export type ReplyTarget =
  /** The envelope is not a reply at all. */
  | { kind: 'none' }
  | { kind: 'available'; envelope: Envelope; lifecycle: Lifecycle; quote: QuotePreview }
  /**
   * Referenced, not held locally, and the room lets us go ask. Distinct from
   * `unavailable` on purpose: this one resolves itself if you wait.
   */
  | { kind: 'pending'; eventId: EventId }
  /**
   * We hold the shell, the content is past its retention. We still know who
   * sent it and when, which is more than `unavailable` can say.
   */
  | { kind: 'expired'; eventId: EventId; sender: string; expiredAt: number }
  | { kind: 'redacted'; eventId: EventId; at: number; by?: string }
  | { kind: 'undecryptable'; eventId: EventId; reason: DecryptionFailure }
  /** The server dropped it: server-side retention, or it never existed. */
  | { kind: 'unavailable'; eventId: EventId; reason: 'pruned' | 'not_found' | 'backfill_disabled' }
  /** History visibility forbids us reading this far back. Not a bug — a rule. */
  | { kind: 'forbidden'; eventId: EventId }
  /** A reply to itself, or a loop. Malformed, but it must not hang the walk. */
  | { kind: 'cycle'; eventId: EventId }
  /** Real parent, but `renderDepth` says stop here. */
  | { kind: 'depth_exceeded'; eventId: EventId };

export interface ResolveContext {
  timeline: TimelineSlice;
  settings: RoomSettings;
  now: number;
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return { text: flat, truncated: false };
  // Break on a word boundary when one is close enough to the limit that the
  // result still reads as a sentence fragment rather than a severed word.
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return { text: (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd(), truncated: true };
}

function formatClipDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function buildQuotePreview(envelope: Envelope, settings: RoomSettings): QuotePreview {
  const max = settings.quotePreviewChars.value;
  const base = {
    sender: envelope.sender,
    edited: envelope.editedAt !== undefined,
    thumbnailUri: null as string | null,
    mediaSummary: null as string | null,
    text: null as string | null,
    truncated: false,
  };

  switch (envelope.body.kind) {
    case 'text': {
      const { text, truncated } = truncate(envelope.body.text, max);
      return { ...base, kind: 'text', text, truncated };
    }
    case 'media': {
      const { mimetype, caption, thumbnailUri, durationMs } = envelope.body;
      const noun = mimetype.startsWith('image/')
        ? 'Photo'
        : mimetype.startsWith('video/')
          ? 'Video'
          : mimetype.startsWith('audio/')
            ? 'Audio'
            : 'File';
      const summary = durationMs ? `${noun} · ${formatClipDuration(durationMs)}` : noun;
      const c = caption ? truncate(caption, max) : null;
      return {
        ...base,
        kind: 'media',
        mediaSummary: summary,
        thumbnailUri: thumbnailUri ?? null,
        text: c?.text ?? null,
        truncated: c?.truncated ?? false,
      };
    }
    case 'mixed': {
      const { itemCount, caption, thumbnailUri } = envelope.body;
      const c = caption ? truncate(caption, max) : null;
      return {
        ...base,
        kind: 'mixed',
        mediaSummary: `${itemCount} item${itemCount === 1 ? '' : 's'}`,
        thumbnailUri: thumbnailUri ?? null,
        text: c?.text ?? null,
        truncated: c?.truncated ?? false,
      };
    }
  }
}

/**
 * Resolve one hop up.
 *
 * `visited` carries the ids already seen on this walk so a reply cycle
 * terminates instead of recursing until the stack gives out.
 */
export function resolveReplyTarget(
  envelope: Envelope,
  ctx: ResolveContext,
  visited: ReadonlySet<EventId> = new Set(),
): ReplyTarget {
  const relation = envelope.replyTo;
  if (!relation) return { kind: 'none' };

  const targetId = relation.eventId;
  if (targetId === envelope.id || visited.has(targetId)) return { kind: 'cycle', eventId: targetId };

  const lookup = ctx.timeline.lookup(targetId);

  switch (lookup.status) {
    case 'forbidden':
      return { kind: 'forbidden', eventId: targetId };
    case 'pruned':
      return { kind: 'unavailable', eventId: targetId, reason: 'pruned' };
    case 'unknown':
      return ctx.settings.backfillMissingParents.value
        ? { kind: 'pending', eventId: targetId }
        : { kind: 'unavailable', eventId: targetId, reason: 'backfill_disabled' };
    case 'found': {
      const parent = lookup.envelope;
      const lifecycle = lifecycleOf(parent, ctx.settings, ctx.now);
      switch (lifecycle.status) {
        case 'redacted':
          return { kind: 'redacted', eventId: targetId, at: lifecycle.at, by: lifecycle.by };
        case 'undecryptable':
          return { kind: 'undecryptable', eventId: targetId, reason: lifecycle.reason };
        case 'expired':
          return {
            kind: 'expired',
            eventId: targetId,
            sender: parent.sender,
            expiredAt: lifecycle.expiresAt,
          };
        default:
          return {
            kind: 'available',
            envelope: parent,
            lifecycle,
            quote: buildQuotePreview(parent, ctx.settings),
          };
      }
    }
  }
}

/**
 * Walk the reply chain up to the room's render depth.
 *
 * Returns nearest-parent-first. The last entry is `depth_exceeded` when the
 * chain continues past what the room allows us to draw — the UI wants to know
 * the difference between "chain ends here" and "chain continues, we stopped".
 */
export function resolveReplyChain(envelope: Envelope, ctx: ResolveContext): ReplyTarget[] {
  const maxDepth = ctx.settings.renderDepth.value;
  if (!envelope.replyTo) return [];
  if (maxDepth <= 0) return [{ kind: 'depth_exceeded', eventId: envelope.replyTo.eventId }];

  const chain: ReplyTarget[] = [];
  const visited = new Set<EventId>([envelope.id]);
  let current: Envelope = envelope;

  for (let depth = 0; depth < maxDepth; depth++) {
    const target = resolveReplyTarget(current, ctx, visited);
    if (target.kind === 'none') break;
    chain.push(target);
    if (target.kind !== 'available') break;
    visited.add(target.envelope.id);
    if (!target.envelope.replyTo) break;
    current = target.envelope;
  }

  const last = chain[chain.length - 1];
  if (last?.kind === 'available' && last.envelope.replyTo && chain.length === maxDepth) {
    chain.push({ kind: 'depth_exceeded', eventId: last.envelope.replyTo.eventId });
  }
  return chain;
}

/**
 * Settings decide what a resolved target *looks* like, and that decision is
 * separate from resolution on purpose: the same `expired` target renders three
 * different ways depending on the room, and we want to test that mapping
 * without constructing timelines.
 */
export type ReplyRenderPlan =
  | { render: 'none' }
  | { render: 'quote'; target: Extract<ReplyTarget, { kind: 'available' }> }
  | { render: 'placeholder'; target: ReplyTarget; label: string; tone: 'neutral' | 'warn' }
  /** Draw the reply as an ordinary message, with no quote block at all. */
  | { render: 'quote_omitted'; target: ReplyTarget }
  /** Withhold the reply itself; without its parent it could mislead. */
  | { render: 'message_hidden'; target: ReplyTarget; reason: string };

const PLACEHOLDER_LABELS: Record<Exclude<ReplyTarget['kind'], 'none' | 'available'>, string> = {
  pending: 'Loading the message this replies to…',
  expired: 'The message this replies to has expired',
  redacted: 'The message this replies to was deleted',
  undecryptable: 'Cannot decrypt the message this replies to',
  unavailable: 'The message this replies to is no longer available',
  forbidden: 'You do not have access to the message this replies to',
  cycle: 'This reply points at itself',
  depth_exceeded: 'Earlier messages in this thread are not shown',
};

/** Only content that *was* readable and is now gone follows the room's policy. */
const GONE: ReadonlySet<ReplyTarget['kind']> = new Set(['expired', 'redacted', 'unavailable']);

export function planReplyRender(target: ReplyTarget, behavior: ExpiredParentBehavior): ReplyRenderPlan {
  if (target.kind === 'none') return { render: 'none' };
  if (target.kind === 'available') {
    // A parent that is itself close to expiry still renders, but the row wants
    // the warning tone so the countdown is visible before the content vanishes.
    return isReadable(target.lifecycle)
      ? { render: 'quote', target }
      : { render: 'placeholder', target, label: PLACEHOLDER_LABELS.expired, tone: 'warn' };
  }

  if (GONE.has(target.kind)) {
    switch (behavior) {
      case 'hide_quote':
        return { render: 'quote_omitted', target };
      case 'hide_message':
        return {
          render: 'message_hidden',
          target,
          reason: PLACEHOLDER_LABELS[target.kind as keyof typeof PLACEHOLDER_LABELS],
        };
      case 'placeholder':
        break;
    }
  }

  const kind = target.kind as keyof typeof PLACEHOLDER_LABELS;
  return {
    render: 'placeholder',
    target,
    label: PLACEHOLDER_LABELS[kind],
    tone: kind === 'pending' || kind === 'depth_exceeded' ? 'neutral' : 'warn',
  };
}
