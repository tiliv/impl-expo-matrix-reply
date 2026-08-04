import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ControlPanel } from './src/experiment/ControlPanel';
import { ExperimentProvider, useExperiment } from './src/experiment/ExperimentContext';
import { EnvelopeRow } from './src/ui/EnvelopeRow';
import { theme } from './src/ui/theme';

function Timeline() {
  const { world, settings, now } = useExperiment();
  const timeline = world.timelineSource;
  const envelopes = timeline.envelopes();

  return (
    <FlatList
      style={styles.timeline}
      contentContainerStyle={styles.timelineContent}
      data={envelopes}
      keyExtractor={(e) => e.id}
      renderItem={({ item }) => (
        <EnvelopeRow
          envelope={item}
          timeline={timeline}
          settings={settings}
          now={now}
          viewer={world.viewer}
        />
      )}
      ListEmptyComponent={<Text style={styles.empty}>No envelopes in this arrangement.</Text>}
    />
  );
}

function Screen() {
  const insets = useSafeAreaInsets();
  const { scenario, world } = useExperiment();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{scenario.title}</Text>
        <Text style={styles.subtitle}>{world.roomId}</Text>
      </View>
      <Timeline />
      <View style={{ paddingBottom: insets.bottom }}>
        <ControlPanel />
      </View>
      <StatusBar style="light" />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ExperimentProvider>
        <Screen />
      </ExperimentProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  subtitle: { color: theme.textFaint, fontSize: 11, marginTop: 2 },
  timeline: { flex: 1 },
  timelineContent: { paddingVertical: 12 },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 40, fontSize: 13 },
});
