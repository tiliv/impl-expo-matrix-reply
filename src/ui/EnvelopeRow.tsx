/**
 * One envelope in the timeline, plus its quote stack.
 *
 * The nesting here is what "subrendering within the room" means in practice:
 * the reply chain resolves to N plans, and they draw innermost-last so the
 * immediate parent sits closest to the reply that references it.
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatDuration } from '../core/clock';
import { lifecycleOf } from '../core/lifecycle';
import { planReplyRender, resolveReplyChain } from '../core/replyTarget';
import type { RoomSettings } from '../core/settings';
import type { Envelope, TimelineSource } from '../adapters';
import { ReplyQuote } from './ReplyQuote';
import { theme } from './theme';

const shortName = (userId: string) => userId.replace(/^@/, '').split(':')[0];

const timeOf = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

interface Props {
  envelope: Envelope;
  timeline: TimelineSource;
  settings: RoomSettings;
  now: number;
  viewer: string;
}

export function EnvelopeRow({ envelope, timeline, settings, now, viewer }: Props) {
  const chain = resolveReplyChain(envelope, { timeline, settings, now });
  const plans = chain.map((target) => planReplyRender(target, settings.expiredParentBehavior.value));

  // A `pending` parent is a request to go and fetch it. Doing that from an
  // effect keeps resolution pure — core decides *that* a fetch is needed, the
  // view decides *when* to ask.
  const pendingIds = chain.flatMap((t) => (t.kind === 'pending' ? [t.eventId] : []));
  const pendingKey = pendingIds.join(',');
  useEffect(() => {
    for (const id of pendingIds) timeline.requestBackfill(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, timeline]);

  const hidden = plans.find((p) => p.render === 'message_hidden');
  if (hidden && hidden.render === 'message_hidden') {
    return (
      <View style={styles.hiddenRow}>
        <Text style={styles.hiddenText}>Reply withheld — {hidden.reason.toLowerCase()}</Text>
      </View>
    );
  }

  const own = envelope.sender === viewer;
  const lifecycle = lifecycleOf(envelope, settings, now);
  const gone = lifecycle.status === 'expired' || lifecycle.status === 'redacted';
  const undecryptable = lifecycle.status === 'undecryptable';

  return (
    <View style={[styles.row, own && styles.rowOwn]}>
      <View style={[styles.bubble, own && styles.bubbleOwn]}>
        {!own && <Text style={styles.sender}>{shortName(envelope.sender)}</Text>}

        {/* Outermost ancestor first, so the immediate parent ends up adjacent
            to the body it is being quoted for. */}
        {[...plans].reverse().map((plan, i) => (
          <ReplyQuote key={`${envelope.id}-q${i}`} plan={plan} depth={plans.length - 1 - i} />
        ))}

        {gone ? (
          <Text style={styles.tombstone}>
            {lifecycle.status === 'redacted' ? 'Message deleted' : 'Message expired'}
          </Text>
        ) : undecryptable ? (
          <Text style={styles.tombstone}>Unable to decrypt</Text>
        ) : (
          <Body envelope={envelope} />
        )}

        <View style={styles.meta}>
          <Text style={styles.time}>{timeOf(envelope.originTs)}</Text>
          {lifecycle.status === 'expiring' && (
            <Text style={styles.expiring}>expires in {formatDuration(lifecycle.msRemaining)}</Text>
          )}
          {lifecycle.status === 'live' && lifecycle.expiresAt !== null && (
            <Text style={styles.retained}>
              retained {formatDuration(lifecycle.expiresAt - now)}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

function Body({ envelope }: { envelope: Envelope }) {
  switch (envelope.body.kind) {
    case 'text':
      return <Text style={styles.text}>{envelope.body.text}</Text>;
    case 'media':
      return (
        <View style={styles.mediaBody}>
          <Text style={styles.mediaGlyph}>▶</Text>
          <Text style={styles.text}>{envelope.body.caption ?? envelope.body.mimetype}</Text>
        </View>
      );
    case 'mixed':
      return (
        <View style={styles.mediaBody}>
          <Text style={styles.mediaGlyph}>▦</Text>
          <Text style={styles.text}>
            {envelope.body.caption ?? `${envelope.body.itemCount} items`}
          </Text>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 12, marginBottom: 8, alignItems: 'flex-start' },
  rowOwn: { alignItems: 'flex-end' },
  bubble: {
    maxWidth: '88%',
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    padding: 10,
  },
  bubbleOwn: { backgroundColor: theme.ownBubble, borderColor: '#2b4a72' },
  sender: { color: theme.accent, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  text: { color: theme.text, fontSize: 15, lineHeight: 20 },
  mediaBody: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mediaGlyph: { color: theme.textDim, fontSize: 16 },
  tombstone: { color: theme.textFaint, fontSize: 14, fontStyle: 'italic' },
  meta: { flexDirection: 'row', gap: 8, marginTop: 5, alignItems: 'center' },
  time: { color: theme.textFaint, fontSize: 10, fontVariant: ['tabular-nums'] },
  expiring: { color: theme.warn, fontSize: 10, fontVariant: ['tabular-nums'] },
  retained: { color: theme.textFaint, fontSize: 10, fontVariant: ['tabular-nums'] },
  hiddenRow: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radiusSm,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: theme.border,
  },
  hiddenText: { color: theme.textFaint, fontSize: 12, fontStyle: 'italic', textAlign: 'center' },
});
