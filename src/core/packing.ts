/**
 * Reply envelopes, packed for the wire and unpacked off it.
 *
 * `envelope.ts` is the shared boundary; this file is the part that is specific to
 * replies, and it is where the decisions live. There is no precedent for any of
 * them: the only inner envelope anywhere in the ecosystem is
 * `{ msgtype: 'm.text', body }`, so a reply is the first content shape this stack
 * has had to actually design.
 *
 * ## Three decisions, and what each one costs
 *
 * **1. No Matrix reply fallback.** Matrix replies embed the parent's text in the
 * child's own `body`, prefixed with `> `, so unaware clients show something. We
 * do not, and cannot: that copy survives the parent's revocation and its
 * retention window. A reply carrying a fallback quote shows the parent's words
 * after the parent has been unsent — which is the precise thing this repo exists
 * to get right. Cost: a client that does not understand
 * `app.envelope.relates_to` renders our reply as a bare message with no context.
 * Acceptable, because there is exactly one client.
 *
 * **2. `msgtype` stays Matrix-flavoured; the relation does not.** Content uses
 * `m.text` / `m.image` / `m.audio` because those are what the crypto layer's
 * ecosystem expects and cost nothing to keep. The relation is namespaced
 * `app.envelope.*` because it has our semantics, not Matrix's. Mixing the two
 * namespaces in one content object looks untidy and is honest: some of this is
 * inherited and some is ours.
 *
 * **3. A reply to something unreadable is still sendable.** You can reply to an
 * event you cannot decrypt — you have its `eventId` from the timeline shell even
 * without its room key. Refusing would be defensible and is wrong: the reply is
 * the user's, and their inability to read the parent is our failure, not theirs.
 */

import {
  asNumber,
  asString,
  decodeWire,
  isRecord,
  makeTxnId,
  RELATES_TO_KEY,
  readReplyRelation,
  replyRelation,
  wireTimestampMs,
  type DecodedEnvelope,
  type EncryptedFileRef,
  type OutgoingEnvelope,
  type WireEvent,
} from './envelope';
import type { Envelope, EnvelopeBody, EventId, RoomId, UserId } from './types';

/** The inner plaintext type we send. Matrix's, because it costs nothing. */
export const MESSAGE_EVENT_TYPE = 'm.room.message';

/** Inner types this client will render. Anything else decodes as `unknown_type`. */
export const ACCEPTED_EVENT_TYPES = [MESSAGE_EVENT_TYPE];

export interface PackReplyInput {
  body: EnvelopeBody;
  /** Omit for a message that is not a reply. */
  replyToEventId?: EventId;
  /** Encrypted media carried by this envelope, if any. */
  files?: EncryptedFileRef[];
  /** Sender-requested lifetime, independent of the room's retention. */
  selfDestructMs?: number;
  /** Deterministic entropy for the txnId. See `makeTxnId`. */
  seed: string | number;
}

/**
 * Build the four things a send needs.
 *
 * Note what comes back alongside the content: `txnId` and `mediaIds`. Neither is
 * part of the HTTP body, and both have to outlive the request — the txnId because
 * it is the only handle for unsending, the mediaIds because revocation takes them
 * explicitly. Returning them together is the point of the type.
 */
export function packReply(input: PackReplyInput): OutgoingEnvelope {
  const content: Record<string, unknown> = { ...bodyToContent(input.body) };

  if (input.replyToEventId !== undefined) {
    content[RELATES_TO_KEY] = replyRelation(input.replyToEventId);
  }
  if (input.files && input.files.length > 0) {
    content['app.envelope.files'] = input.files;
  }
  if (input.selfDestructMs !== undefined) {
    // Ours. Matrix has no sender-side lifetime, only room retention — and the
    // two are different powers: one is the author's, one is the admin's.
    content['app.envelope.self_destruct_ms'] = input.selfDestructMs;
  }

  return {
    eventType: MESSAGE_EVENT_TYPE,
    content,
    txnId: makeTxnId(input.seed),
    mediaIds: (input.files ?? []).map((f) => f.mediaId),
  };
}

function bodyToContent(body: EnvelopeBody): Record<string, unknown> {
  switch (body.kind) {
    case 'text':
      return { msgtype: 'm.text', body: body.text };
    case 'media':
      return {
        // `m.file` rather than guessing `m.image`/`m.video` from the mimetype:
        // the renderer has the mimetype and can decide, and a wrong msgtype is
        // stickier than a general one.
        msgtype: 'm.file',
        body: body.caption ?? '',
        info: {
          mimetype: body.mimetype,
          ...(body.durationMs === undefined ? {} : { duration: body.durationMs }),
          ...(body.thumbnailUri === undefined ? {} : { thumbnail_media_id: body.thumbnailUri }),
        },
      };
    case 'mixed':
      // No Matrix msgtype means "several things". See meda-message for the
      // argument; here it just needs a stable name.
      return {
        msgtype: 'app.envelope.multi',
        body: body.caption ?? '',
        'app.envelope.item_count': body.itemCount,
        ...(body.thumbnailUri === undefined ? {} : { 'app.envelope.cover': body.thumbnailUri }),
      };
  }
}

export interface UnpackContext {
  roomId: RoomId;
}

/**
 * Decode a wire event into the local `Envelope`.
 *
 * The `revoked` ordering inside `decodeWire` matters most here: a revoked parent
 * is exactly the case a reply quote has to handle, and a decoder that reads
 * content before checking `revoked` would hand the quote renderer readable text
 * for a message that has been unsent.
 */
export function unpackEnvelope(wire: WireEvent, ctx: UnpackContext): DecodedEnvelope<Envelope> {
  return decodeWire<Envelope>(
    wire,
    (_eventType, content) => {
      const body = contentToBody(content);
      if (body === null) return null;
      const relation = readReplyRelation(content);
      const selfDestruct = asNumber(content['app.envelope.self_destruct_ms']);

      return {
        id: wire.eventId,
        roomId: ctx.roomId,
        sender: wire.senderUserId as UserId,
        originTs: wireTimestampMs(wire),
        body,
        ...(relation === null ? {} : { replyTo: { relType: 'app.envelope.reply', eventId: relation.event_id } }),
        ...(selfDestruct === null ? {} : { selfDestructMs: selfDestruct }),
      };
    },
    (eventType) => ACCEPTED_EVENT_TYPES.includes(eventType),
  );
}

function contentToBody(content: Record<string, unknown>): EnvelopeBody | null {
  const msgtype = asString(content['msgtype']);
  if (msgtype === null) return null;

  if (msgtype === 'm.text') {
    const text = asString(content['body']);
    return text === null ? null : { kind: 'text', text };
  }

  if (msgtype === 'm.file' || msgtype === 'm.image' || msgtype === 'm.video' || msgtype === 'm.audio') {
    const info = isRecord(content['info']) ? content['info'] : {};
    const mimetype = asString(info['mimetype']) ?? 'application/octet-stream';
    const caption = asString(content['body']);
    const duration = asNumber(info['duration']);
    const thumb = asString(info['thumbnail_media_id']);
    return {
      kind: 'media',
      mimetype,
      ...(caption === null || caption === '' ? {} : { caption }),
      ...(duration === null ? {} : { durationMs: duration }),
      ...(thumb === null ? {} : { thumbnailUri: thumb }),
    };
  }

  if (msgtype === 'app.envelope.multi') {
    const count = asNumber(content['app.envelope.item_count']);
    if (count === null || count < 1) return null;
    const caption = asString(content['body']);
    const cover = asString(content['app.envelope.cover']);
    return {
      kind: 'mixed',
      itemCount: Math.round(count),
      ...(caption === null || caption === '' ? {} : { caption }),
      ...(cover === null ? {} : { thumbnailUri: cover }),
    };
  }

  // A msgtype we do not render. Distinct from malformed: the event is fine, we
  // just do not know this kind — so the timeline should say "unsupported
  // message", not "corrupt".
  return null;
}

/**
 * Read the files off a decoded envelope.
 *
 * Separate from `unpackEnvelope` because the local `Envelope` model deliberately
 * does not hold key material: a quote preview renders from `body`, and giving the
 * preview layer access to AES keys it has no use for is how keys end up in logs.
 */
export function readFiles(content: Record<string, unknown>): EncryptedFileRef[] {
  const raw = content['app.envelope.files'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is EncryptedFileRef => isRecord(f) && typeof f['mediaId'] === 'string');
}
