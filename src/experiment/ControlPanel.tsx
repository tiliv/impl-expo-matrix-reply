/**
 * The control panel.
 *
 * Every control here sends a room state event. None of them writes a settings
 * object directly — that is the constraint that keeps the experiment honest,
 * because it means the code path you are exercising on screen is the same one
 * the real room will drive.
 *
 * The provenance line under each control is the payoff: it tells you whether a
 * value came from a state event or quietly fell back to a default.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DAY, HOUR, MINUTE } from '../core/clock';
import { stateEvent } from '../core/roomState';
import {
  describeSource,
  STATE_HISTORY_VISIBILITY,
  STATE_REPLY,
  STATE_RETENTION,
  type ExpiredParentBehavior,
  type Resolved,
} from '../core/settings';
import { theme } from '../ui/theme';
import { SCENARIOS } from './scenarios';
import { useExperiment } from './ExperimentContext';

function Chip({
  label,
  active,
  onPress,
  tone = 'default',
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
  tone?: 'default' | 'accent';
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active && styles.chipActive,
        tone === 'accent' && styles.chipAccent,
        pressed && styles.chipPressed,
      ]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Row({ label, source, children }: { label: string; source?: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowControls}>{children}</View>
      {source && <Text style={styles.provenance}>← {source}</Text>}
    </View>
  );
}

const src = <T,>(r: Resolved<T>) => describeSource(r.source);

export function ControlPanel() {
  const { world, settings, warnings, scenario, setScenario, now } = useExperiment();
  const [tab, setTab] = useState<'scenario' | 'room' | 'time'>('scenario');

  const sendReply = (patch: Record<string, unknown>) => {
    // Merge, so setting one field does not silently reset the others — the
    // same read-modify-write a real client does against room state.
    const current = world.stateStore.get(STATE_REPLY)?.content ?? {};
    world.stateStore.send(stateEvent(STATE_REPLY, { ...current, ...patch }, { originTs: now }));
  };

  return (
    <View style={styles.panel}>
      <View style={styles.tabs}>
        {(['scenario', 'room', 'time'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {tab === 'scenario' && (
          <>
            <Text style={styles.question}>{scenario.question}</Text>
            <View style={styles.chipWrap}>
              {SCENARIOS.map((s) => (
                <Chip key={s.id} label={s.title} active={s.id === scenario.id} onPress={() => setScenario(s)} />
              ))}
            </View>
            <Text style={styles.sectionLabel}>Expected</Text>
            {scenario.expect.map((line, i) => (
              <Text key={i} style={styles.expectLine}>
                • {line}
              </Text>
            ))}
            {scenario.tryNext?.length ? (
              <>
                <Text style={styles.sectionLabel}>Try next</Text>
                {scenario.tryNext.map((line, i) => (
                  <Text key={i} style={styles.tryLine}>
                    → {line}
                  </Text>
                ))}
              </>
            ) : null}
          </>
        )}

        {tab === 'room' && (
          <>
            <Text style={styles.hint}>
              Each control sends a room state event. Nothing here writes settings directly.
            </Text>

            <Row label={`m.room.retention · max_lifetime`} source={src(settings.retentionMaxLifetimeMs)}>
              {[
                { label: 'none', seconds: null },
                { label: '2m', seconds: 120 },
                { label: '15m', seconds: 900 },
                { label: '1h', seconds: 3600 },
                { label: '7d', seconds: 604800 },
              ].map(({ label, seconds }) => (
                <Chip
                  key={label}
                  label={label}
                  active={
                    seconds === null
                      ? settings.retentionMaxLifetimeMs.value === null
                      : settings.retentionMaxLifetimeMs.value === seconds * 1000
                  }
                  onPress={() =>
                    seconds === null
                      ? world.stateStore.clear(STATE_RETENTION)
                      : world.stateStore.send(
                          stateEvent(STATE_RETENTION, { max_lifetime: seconds }, { originTs: now }),
                        )
                  }
                />
              ))}
            </Row>

            <Row label="render_depth" source={src(settings.renderDepth)}>
              {[0, 1, 2, 3, 4].map((d) => (
                <Chip
                  key={d}
                  label={String(d)}
                  active={settings.renderDepth.value === d}
                  onPress={() => sendReply({ render_depth: d })}
                />
              ))}
            </Row>

            <Row label="expired_parent_behavior" source={src(settings.expiredParentBehavior)}>
              {(['placeholder', 'hide_quote', 'hide_message'] as ExpiredParentBehavior[]).map((b) => (
                <Chip
                  key={b}
                  label={b.replace('_', ' ')}
                  active={settings.expiredParentBehavior.value === b}
                  onPress={() => sendReply({ expired_parent_behavior: b })}
                />
              ))}
            </Row>

            <Row label="quote_preview_chars" source={src(settings.quotePreviewChars)}>
              {[40, 140, 320].map((n) => (
                <Chip
                  key={n}
                  label={String(n)}
                  active={settings.quotePreviewChars.value === n}
                  onPress={() => sendReply({ quote_preview_chars: n })}
                />
              ))}
            </Row>

            <Row label="warn_before_ms" source={src(settings.retentionWarnBeforeMs)}>
              {[
                { label: '30s', ms: 30_000 },
                { label: '5m', ms: 5 * MINUTE },
                { label: '1h', ms: HOUR },
              ].map(({ label, ms }) => (
                <Chip
                  key={label}
                  label={label}
                  active={settings.retentionWarnBeforeMs.value === ms}
                  onPress={() => sendReply({ warn_before_ms: ms })}
                />
              ))}
            </Row>

            <Row label="backfill_missing_parents" source={src(settings.backfillMissingParents)}>
              {[true, false].map((v) => (
                <Chip
                  key={String(v)}
                  label={v ? 'on' : 'off'}
                  active={settings.backfillMissingParents.value === v}
                  onPress={() => sendReply({ backfill_missing_parents: v })}
                />
              ))}
            </Row>

            <Row label="m.room.history_visibility" source={src(settings.historyVisibility)}>
              {(['world_readable', 'shared', 'joined'] as const).map((v) => (
                <Chip
                  key={v}
                  label={v.replace('_', ' ')}
                  active={settings.historyVisibility.value === v}
                  onPress={() =>
                    world.stateStore.send(
                      stateEvent(STATE_HISTORY_VISIBILITY, { history_visibility: v }, { originTs: now }),
                    )
                  }
                />
              ))}
            </Row>

            <Text style={styles.sectionLabel}>Send a deliberately bad value</Text>
            <View style={styles.chipWrap}>
              <Chip label="render_depth: 99" onPress={() => sendReply({ render_depth: 99 })} />
              <Chip label='preview_chars: "lots"' onPress={() => sendReply({ quote_preview_chars: 'lots' })} />
              <Chip label="behavior: explode" onPress={() => sendReply({ expired_parent_behavior: 'explode' })} />
            </View>

            {warnings.length > 0 && (
              <View style={styles.warnings}>
                <Text style={styles.warningTitle}>Resolver warnings</Text>
                {warnings.map((w, i) => (
                  <Text key={i} style={styles.warningLine}>
                    {w.setting}: {w.message}
                  </Text>
                ))}
              </View>
            )}

            <Text style={styles.sectionLabel}>Room state ({world.stateStore.all().length} events)</Text>
            {world.stateStore.all().map((e) => (
              <Text key={e.eventId} style={styles.stateLine}>
                {e.type} {JSON.stringify(e.content)}
              </Text>
            ))}
          </>
        )}

        {tab === 'time' && (
          <>
            <Text style={styles.hint}>
              Expiry is only observable if you can move the clock. Nothing else in the app reads
              Date.now().
            </Text>
            <Text style={styles.clockReadout}>{new Date(now).toISOString().replace('T', ' ').slice(0, 19)}</Text>
            <Row label="advance">
              {[
                { label: '+10s', ms: 10_000 },
                { label: '+1m', ms: MINUTE },
                { label: '+5m', ms: 5 * MINUTE },
                { label: '+1h', ms: HOUR },
                { label: '+1d', ms: DAY },
              ].map(({ label, ms }) => (
                <Chip key={label} label={label} tone="accent" onPress={() => world.clock.advance(ms)} />
              ))}
            </Row>
            <Row label="run">
              <Chip
                label={world.clock.playing ? '❙❙ pause' : '▶ play 10×'}
                tone="accent"
                onPress={() => {
                  if (world.clock.playing) world.clock.pause();
                  else world.clock.play(500, 20);
                }}
              />
              <Chip label="↺ reload scenario" onPress={() => setScenario(scenario)} />
            </Row>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: theme.surface, borderTopWidth: 1, borderTopColor: theme.border, maxHeight: '52%' },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.border },
  tab: { flex: 1, paddingVertical: 9, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: theme.accent },
  tabText: { color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  tabTextActive: { color: theme.accent },
  body: { flexGrow: 0 },
  bodyContent: { padding: 12, paddingBottom: 24 },
  question: { color: theme.text, fontSize: 14, fontWeight: '600', marginBottom: 10, lineHeight: 19 },
  hint: { color: theme.textDim, fontSize: 11, marginBottom: 10, lineHeight: 15, fontStyle: 'italic' },
  sectionLabel: {
    color: theme.textFaint,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 12,
    marginBottom: 5,
  },
  expectLine: { color: theme.textDim, fontSize: 12, lineHeight: 17, marginBottom: 3 },
  tryLine: { color: theme.accent, fontSize: 12, lineHeight: 17, marginBottom: 3 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
  },
  chipActive: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  chipAccent: { borderColor: theme.accentDim },
  chipPressed: { opacity: 0.6 },
  chipText: { color: theme.textDim, fontSize: 11 },
  chipTextActive: { color: theme.text, fontWeight: '700' },
  row: { marginBottom: 10 },
  rowLabel: { color: theme.text, fontSize: 11, fontWeight: '600', marginBottom: 5 },
  rowControls: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  provenance: { color: theme.textFaint, fontSize: 10, marginTop: 4, fontStyle: 'italic' },
  warnings: {
    marginTop: 12,
    padding: 9,
    borderRadius: theme.radiusSm,
    backgroundColor: '#2a1a1d',
    borderWidth: 1,
    borderColor: '#4a2b30',
  },
  warningTitle: { color: theme.danger, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  warningLine: { color: '#e0a0a6', fontSize: 11, lineHeight: 15 },
  stateLine: { color: theme.textFaint, fontSize: 10, lineHeight: 14 },
  clockReadout: {
    color: theme.accent,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
    fontVariant: ['tabular-nums'],
  },
});
