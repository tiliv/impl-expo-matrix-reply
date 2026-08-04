/**
 * How alive is this envelope, right now?
 *
 * Precedence is deliberate and worth stating, because two of these can be
 * true at once:
 *
 *   redacted > undecryptable > expired > expiring > live
 *
 * Redaction wins because it is the strongest statement: someone removed the
 * content on purpose, and that stays true even if we also lack the key.
 * Undecryptable outranks expiry because we cannot honestly claim an envelope
 * expired when we never read it in the first place.
 */

import type { RoomSettings } from './settings';
import type { DecryptionFailure, Envelope } from './types';

export type Lifecycle =
  | { status: 'live'; expiresAt: number | null }
  | { status: 'expiring'; expiresAt: number; msRemaining: number }
  | { status: 'expired'; expiresAt: number }
  | { status: 'redacted'; at: number; by?: string }
  | { status: 'undecryptable'; reason: DecryptionFailure };

/**
 * When does this envelope stop being showable?
 *
 * Two clocks can apply: the room's retention policy and the sender's own
 * self-destruct. We take the *earlier* of the two. Privacy settings compose
 * by tightening, never by loosening — a room with a generous retention policy
 * must not extend the life of a message its sender marked short-lived.
 */
export function expiryOf(envelope: Envelope, settings: RoomSettings): number | null {
  const roomLifetime = settings.retentionMaxLifetimeMs.value;
  const candidates: number[] = [];
  if (roomLifetime !== null) candidates.push(envelope.originTs + roomLifetime);
  if (envelope.selfDestructMs !== undefined) candidates.push(envelope.originTs + envelope.selfDestructMs);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

export function lifecycleOf(envelope: Envelope, settings: RoomSettings, now: number): Lifecycle {
  if (envelope.redaction) return { status: 'redacted', at: envelope.redaction.at, by: envelope.redaction.by };
  if (envelope.decryptionFailure) return { status: 'undecryptable', reason: envelope.decryptionFailure };

  const expiresAt = expiryOf(envelope, settings);
  if (expiresAt === null) return { status: 'live', expiresAt: null };
  if (now >= expiresAt) return { status: 'expired', expiresAt };

  const msRemaining = expiresAt - now;
  if (msRemaining <= settings.retentionWarnBeforeMs.value) {
    return { status: 'expiring', expiresAt, msRemaining };
  }
  return { status: 'live', expiresAt };
}

/** True when the envelope's own content may still be drawn. */
export const isReadable = (l: Lifecycle): boolean => l.status === 'live' || l.status === 'expiring';
