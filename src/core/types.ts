/**
 * Envelope model.
 *
 * We ride Matrix's cryptography and event graph, but not its content
 * vocabulary. So: an `Envelope` is our payload, carried inside a Matrix
 * event. Everything below the `event` shell is ours to define; everything on
 * the shell (id, sender, origin_server_ts, redaction, decryption failure) is
 * a fact the Matrix layer hands us.
 *
 * The split matters for expiry: the shell can survive while the content is
 * gone (redaction, retention), and the shell can be present while the content
 * is unreadable (no megolm session). The UI has to render all three states.
 */

export type EventId = string;
export type RoomId = string;
export type UserId = string;

/** Why a decryption attempt failed. Mirrors the failures megolm actually gives us. */
export type DecryptionFailure =
  | 'unknown_session' // we never received the room key
  | 'session_withheld' // sender deliberately withheld the key
  | 'sender_unverified' // key present, sender identity not trusted
  | 'malformed';

export type EnvelopeBody =
  | { kind: 'text'; text: string }
  | { kind: 'media'; mimetype: string; caption?: string; thumbnailUri?: string; durationMs?: number }
  | { kind: 'mixed'; itemCount: number; caption?: string; thumbnailUri?: string };

/**
 * Our reply pointer. Deliberately *not* `m.in_reply_to`: we do not want the
 * fallback-quote body convention that comes with it, because our quote is
 * rendered from the resolved parent, never from text embedded in the child.
 * Same idea, our namespace.
 */
export interface ReplyRelation {
  relType: 'app.envelope.reply';
  eventId: EventId;
}

export interface Envelope {
  id: EventId;
  roomId: RoomId;
  sender: UserId;
  /** Server-stamped. This, not local receipt time, anchors retention. */
  originTs: number;
  body: EnvelopeBody;
  replyTo?: ReplyRelation;

  /** Shell facts, supplied by the Matrix layer. */
  redaction?: { at: number; by?: UserId };
  decryptionFailure?: DecryptionFailure;
  /** Last edit's timestamp, if the envelope was edited. */
  editedAt?: number;
  /**
   * Sender-requested lifetime, independent of the room's retention policy.
   * When both exist the *earlier* expiry wins — see `lifecycle.ts`.
   */
  selfDestructMs?: number;
}

/** What the local timeline can tell us about an event id we do not hold. */
export type TimelineLookup =
  | { status: 'found'; envelope: Envelope }
  | { status: 'unknown' } // not in the local slice; may be backfillable
  | { status: 'forbidden' } // history visibility says we may never read it
  | { status: 'pruned'}; // server no longer has it (retention ran server-side)

export interface TimelineSlice {
  lookup(id: EventId): TimelineLookup;
}

export const isReply = (e: Envelope): boolean => e.replyTo !== undefined;
