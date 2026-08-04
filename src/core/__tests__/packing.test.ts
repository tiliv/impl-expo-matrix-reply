/**
 * The wire boundary.
 *
 * These are the tests that would have caught the things this repo did not model
 * before: a txnId that is not retained, media that outlives its own message, and
 * a revoked parent whose text renders anyway.
 */

import {
  isFullyRevocable,
  isUsableTxnId,
  MEDIA_IDS_PER_REVOCATION,
  revocationPlan,
  WIRE_EVENT_TYPE,
  wireTimestampMs,
  type EncryptedFileRef,
  type WireEvent,
} from '../envelope';
import { packReply, readFiles, unpackEnvelope } from '../packing';

const file = (mediaId: string, viewOnce = false): EncryptedFileRef => ({
  mediaId,
  key: { alg: 'A256CTR', ext: true, k: 'k'.repeat(43), key_ops: ['encrypt', 'decrypt'], kty: 'oct' },
  iv: 'aXY=',
  hashes: { sha256: 'c2hh' },
  v: 'v2',
  mimetype: 'image/jpeg',
  sizeBytes: 2048,
  ...(viewOnce ? { viewOnce: true } : {}),
});

const wire = (over: Partial<WireEvent> = {}): WireEvent => ({
  eventId: '$evt-1',
  txnId: 'n-1',
  senderUserId: '@alice:noodles',
  eventType: 'm.room.message',
  content: { msgtype: 'm.text', body: 'hello' },
  createdAt: '2026-08-04T12:00:00.000Z',
  revoked: false,
  ...over,
});

describe('packing a message for the wire', () => {
  it('produces a Matrix m.room.message for plain text', () => {
    const out = packReply({ body: { kind: 'text', text: 'hello' }, seed: 1 });
    expect(out.eventType).toBe('m.room.message');
    expect(out.content).toMatchObject({ msgtype: 'm.text', body: 'hello' });
  });

  it('returns a txnId alongside the content, because that is the unsend handle', () => {
    // The server derives eventId from (txnId, senderUserId) and the revoke
    // endpoint takes txnId — not eventId. A caller that drops this cannot ever
    // unsend the message.
    const out = packReply({ body: { kind: 'text', text: 'hi' }, seed: 'abc' });
    expect(isUsableTxnId(out.txnId)).toBe(true);
    expect(out.txnId).toBe('n-abc');
  });

  it('carries no Matrix reply fallback', () => {
    // Matrix would put the parent's text into this child's own body prefixed
    // with "> ". That copy survives the parent's revocation, which defeats the
    // entire point of rendering the quote from the resolved parent.
    const out = packReply({ body: { kind: 'text', text: 'agreed' }, replyToEventId: '$parent', seed: 2 });
    expect(out.content['body']).toBe('agreed');
    expect(String(out.content['body'])).not.toContain('>');
    expect(out.content['m.relates_to']).toBeUndefined();
  });

  it('namespaces the relation rather than using m.in_reply_to', () => {
    const out = packReply({ body: { kind: 'text', text: 'x' }, replyToEventId: '$parent', seed: 3 });
    expect(out.content['app.envelope.relates_to']).toEqual({
      rel_type: 'app.envelope.reply',
      event_id: '$parent',
    });
  });

  it('omits the relation entirely for a non-reply', () => {
    const out = packReply({ body: { kind: 'text', text: 'x' }, seed: 4 });
    expect('app.envelope.relates_to' in out.content).toBe(false);
  });

  it('lists every referenced mediaId for the eventual revoke', () => {
    const out = packReply({
      body: { kind: 'mixed', itemCount: 2 },
      files: [file('m_a'), file('m_b')],
      seed: 5,
    });
    expect(out.mediaIds).toEqual(['m_a', 'm_b']);
  });
});

describe('revocation', () => {
  it('covers every attachment when there are ten or fewer', () => {
    const out = packReply({
      body: { kind: 'mixed', itemCount: 3 },
      files: [file('m_1'), file('m_2'), file('m_3')],
      seed: 6,
    });
    const plan = revocationPlan(out);

    expect(isFullyRevocable(out)).toBe(true);
    expect(plan.mediaIds).toEqual(['m_1', 'm_2', 'm_3']);
    expect(plan.unrevocable).toEqual([]);
  });

  it('reports the attachments that will stay downloadable past ten', () => {
    // RevokeRoomMessageRequest.mediaIds is maxItems: 10. An envelope with more
    // than ten attachments loses its text on unsend and keeps its files — and
    // nothing outside the OpenAPI spec says so.
    const files = Array.from({ length: 13 }, (_, i) => file(`m_${i}`));
    const out = packReply({ body: { kind: 'mixed', itemCount: 13 }, files, seed: 7 });
    const plan = revocationPlan(out);

    expect(isFullyRevocable(out)).toBe(false);
    expect(plan.mediaIds).toHaveLength(MEDIA_IDS_PER_REVOCATION);
    expect(plan.unrevocable).toEqual(['m_10', 'm_11', 'm_12']);
  });

  it('does not silently truncate the envelope’s own record', () => {
    // The plan is capped; the envelope keeps all of them, so the problem stays
    // visible instead of being rounded away at pack time.
    const files = Array.from({ length: 12 }, (_, i) => file(`m_${i}`));
    const out = packReply({ body: { kind: 'mixed', itemCount: 12 }, files, seed: 8 });
    expect(out.mediaIds).toHaveLength(12);
  });

  it('carries the txnId into the plan', () => {
    const out = packReply({ body: { kind: 'text', text: 'x' }, seed: 'zz' });
    expect(revocationPlan(out).txnId).toBe('n-zz');
  });
});

describe('unpacking what arrives', () => {
  it('round-trips a text message', () => {
    const out = packReply({ body: { kind: 'text', text: 'hello' }, seed: 9 });
    const decoded = unpackEnvelope(wire({ content: out.content }), { roomId: '!r:noodles' });

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.body).toEqual({ kind: 'text', text: 'hello' });
      expect(decoded.value.sender).toBe('@alice:noodles');
      expect(decoded.value.replyTo).toBeUndefined();
    }
  });

  it('round-trips a reply relation', () => {
    const out = packReply({ body: { kind: 'text', text: 'agreed' }, replyToEventId: '$parent', seed: 10 });
    const decoded = unpackEnvelope(wire({ content: out.content }), { roomId: '!r:noodles' });

    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.replyTo).toEqual({ relType: 'app.envelope.reply', eventId: '$parent' });
  });

  it('refuses a revoked event before reading its content', () => {
    // The server marks revoked events rather than erasing them, so readable text
    // arrives with revoked: true. Decoding first and checking later renders an
    // unsent message — this is the ordering that matters most in the whole file.
    const decoded = unpackEnvelope(
      wire({ revoked: true, content: { msgtype: 'm.text', body: 'take this back' } }),
      { roomId: '!r:noodles' },
    );

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe('revoked');
  });

  it('distinguishes still-encrypted from unrenderable', () => {
    const stillCipher = unpackEnvelope(wire({ eventType: WIRE_EVENT_TYPE, content: { ciphertext: 'x' } }), {
      roomId: '!r:noodles',
    });
    expect(stillCipher.ok).toBe(false);
    if (!stillCipher.ok) expect(stillCipher.reason).toBe('undecrypted');

    const otherType = unpackEnvelope(wire({ eventType: 'noodles.room.membership_changed', content: {} }), {
      roomId: '!r:noodles',
    });
    expect(otherType.ok).toBe(false);
    if (!otherType.ok) {
      expect(otherType.reason).toBe('unknown_type');
      expect(otherType.detail).toBe('noodles.room.membership_changed');
    }
  });

  it('reports malformed content separately from an unknown type', () => {
    // Right type, unusable content. "Corrupt" and "unsupported" are different
    // words for the user.
    const decoded = unpackEnvelope(wire({ content: { msgtype: 'm.text' } }), { roomId: '!r:noodles' });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe('malformed');
  });

  it('keeps the wire event on the failure paths, so the shell can still render', () => {
    // A revoked or undecryptable event still has a sender and a timestamp, and
    // the timeline needs both to draw a tombstone in the right place.
    const decoded = unpackEnvelope(wire({ revoked: true }), { roomId: '!r:noodles' });
    expect(decoded.wire.senderUserId).toBe('@alice:noodles');
    expect(wireTimestampMs(decoded.wire)).toBe(Date.parse('2026-08-04T12:00:00.000Z'));
  });

  it('turns an unparseable timestamp into 0 rather than NaN', () => {
    // NaN propagates through every expiry comparison and makes everything look
    // live forever.
    expect(wireTimestampMs(wire({ createdAt: 'not a date' }))).toBe(0);
  });

  it('round-trips a self-destruct lifetime, which Matrix has no field for', () => {
    const out = packReply({ body: { kind: 'text', text: 'x' }, selfDestructMs: 60_000, seed: 11 });
    const decoded = unpackEnvelope(wire({ content: out.content }), { roomId: '!r:noodles' });
    if (decoded.ok) expect(decoded.value.selfDestructMs).toBe(60_000);
  });
});

describe('media references', () => {
  it('keeps key material out of the rendered envelope model', () => {
    // The quote preview has no use for an AES key, and the surest way to keep
    // keys out of logs is to keep them out of the object that gets logged.
    const out = packReply({ body: { kind: 'media', mimetype: 'image/jpeg' }, files: [file('m_x')], seed: 12 });
    const decoded = unpackEnvelope(wire({ content: out.content }), { roomId: '!r:noodles' });

    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(JSON.stringify(decoded.value)).not.toContain('A256CTR');
  });

  it('reads files back off the raw content when they are actually needed', () => {
    const out = packReply({ body: { kind: 'media', mimetype: 'image/jpeg' }, files: [file('m_x')], seed: 13 });
    const files = readFiles(out.content);

    expect(files).toHaveLength(1);
    expect(files[0]!.mediaId).toBe('m_x');
    expect(files[0]!.v).toBe('v2');
  });

  it('surfaces viewOnce, because a retried download burns the only view', () => {
    const out = packReply({
      body: { kind: 'media', mimetype: 'image/jpeg' },
      files: [file('m_once', true)],
      seed: 14,
    });
    expect(readFiles(out.content)[0]!.viewOnce).toBe(true);
  });

  it('ignores junk in the files array instead of throwing', () => {
    expect(readFiles({ 'app.envelope.files': [{ nope: true }, 'string', null] })).toEqual([]);
    expect(readFiles({ 'app.envelope.files': 'not an array' })).toEqual([]);
    expect(readFiles({})).toEqual([]);
  });
});
