/**
 * The subrender.
 *
 * One component per outcome of `planReplyRender`, so the switch below is the
 * complete list of things a quote can be. The `never` check at the bottom is
 * load-bearing: add a case to the union and this stops compiling until it is
 * drawn.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatDuration } from '../core/clock';
import type { ReplyRenderPlan, ReplyTarget } from '../core/replyTarget';
import { theme } from './theme';

const shortName = (userId: string) => userId.replace(/^@/, '').split(':')[0];

/** The live case: an actual quote of an actual message. */
function Quote({ target, depth }: { target: Extract<ReplyTarget, { kind: 'available' }>; depth: number }) {
  const { quote, lifecycle } = target;
  const expiring = lifecycle.status === 'expiring';

  return (
    <View style={[styles.quote, expiring && styles.quoteExpiring]}>
      <View style={[styles.rail, expiring && styles.railExpiring]} />
      <View style={styles.quoteBody}>
        <View style={styles.quoteHeader}>
          <Text style={[styles.quoteSender, expiring && styles.quoteSenderExpiring]} numberOfLines={1}>
            {shortName(quote.sender)}
          </Text>
          {quote.edited && <Text style={styles.tag}>edited</Text>}
          {expiring && <Text style={styles.countdown}>{formatDuration(lifecycle.msRemaining)} left</Text>}
        </View>

        {quote.mediaSummary && (
          <View style={styles.mediaRow}>
            {/* A real thumbnail goes here; the template keeps the slot visible
                so the layout is honest about the space it will take. */}
            <View style={styles.thumbStub}>
              <Text style={styles.thumbGlyph}>{quote.kind === 'mixed' ? '▦' : '▶'}</Text>
            </View>
            <Text style={styles.mediaSummary}>{quote.mediaSummary}</Text>
          </View>
        )}

        {quote.text !== null && (
          <Text style={styles.quoteText} numberOfLines={depth > 0 ? 2 : 3}>
            {quote.text}
            {quote.truncated && <Text style={styles.ellipsis}>…</Text>}
          </Text>
        )}
      </View>
    </View>
  );
}

function Placeholder({ label, tone }: { label: string; tone: 'neutral' | 'warn' }) {
  return (
    <View style={[styles.quote, styles.placeholder, tone === 'warn' && styles.placeholderWarn]}>
      <View style={[styles.rail, tone === 'warn' ? styles.railWarn : styles.railNeutral]} />
      <View style={styles.quoteBody}>
        <Text style={[styles.placeholderText, tone === 'warn' && styles.placeholderTextWarn]}>{label}</Text>
      </View>
    </View>
  );
}

export function ReplyQuote({ plan, depth = 0 }: { plan: ReplyRenderPlan; depth?: number }) {
  switch (plan.render) {
    case 'none':
    case 'quote_omitted':
      return null;
    case 'quote':
      return <Quote target={plan.target} depth={depth} />;
    case 'placeholder':
      return <Placeholder label={plan.label} tone={plan.tone} />;
    case 'message_hidden':
      // The row above us decides not to render at all in this case; if we are
      // reached anyway, say why rather than silently drawing nothing.
      return <Placeholder label={plan.reason} tone="warn" />;
    default: {
      const exhaustive: never = plan;
      return exhaustive;
    }
  }
}

const styles = StyleSheet.create({
  quote: {
    flexDirection: 'row',
    backgroundColor: theme.surfaceAlt,
    borderRadius: theme.radiusSm,
    overflow: 'hidden',
    marginBottom: 6,
  },
  quoteExpiring: { backgroundColor: '#2a2318' },
  rail: { width: 3, backgroundColor: theme.accent },
  railExpiring: { backgroundColor: theme.warn },
  railWarn: { backgroundColor: theme.danger },
  railNeutral: { backgroundColor: theme.textFaint },
  quoteBody: { flex: 1, paddingVertical: 6, paddingHorizontal: 9 },
  quoteHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  quoteSender: { color: theme.accent, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  quoteSenderExpiring: { color: theme.warn },
  tag: {
    color: theme.textFaint,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  countdown: { color: theme.warn, fontSize: 11, marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  quoteText: { color: theme.textDim, fontSize: 13, lineHeight: 17 },
  ellipsis: { color: theme.textFaint },
  mediaRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 3 },
  thumbStub: {
    width: 26,
    height: 26,
    borderRadius: 4,
    backgroundColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbGlyph: { color: theme.textDim, fontSize: 12 },
  mediaSummary: { color: theme.text, fontSize: 12, fontWeight: '600' },
  placeholder: { backgroundColor: '#1a1d24' },
  placeholderWarn: { backgroundColor: '#2a1a1d' },
  placeholderText: { color: theme.textDim, fontSize: 12, fontStyle: 'italic' },
  placeholderTextWarn: { color: '#e0a0a6' },
});
