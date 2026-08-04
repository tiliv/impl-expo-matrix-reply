import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { resolveRoomSettings, type ResolvedRoomSettings } from '../core/settings';
import { ExperimentWorld } from './world';
import { DEFAULT_SCENARIO, loadScenario, type Scenario } from './scenarios';

interface ExperimentValue extends ResolvedRoomSettings {
  world: ExperimentWorld;
  now: number;
  scenario: Scenario;
  setScenario(scenario: Scenario): void;
  /** Bumping this forces a re-resolve; exposed for the panel's controls. */
  revision: number;
}

const ExperimentContext = createContext<ExperimentValue | null>(null);

export function ExperimentProvider({ children }: { children: React.ReactNode }) {
  const worldRef = useRef<ExperimentWorld | null>(null);
  if (worldRef.current === null) {
    worldRef.current = new ExperimentWorld();
    loadScenario(worldRef.current, DEFAULT_SCENARIO);
  }
  const world = worldRef.current;

  const [scenario, setScenarioState] = useState<Scenario>(DEFAULT_SCENARIO);

  const revision = useSyncExternalStore(world.subscribe.bind(world), world.getRevision, world.getRevision);

  useEffect(() => () => world.dispose(), [world]);

  const value = useMemo<ExperimentValue>(() => {
    const resolved = resolveRoomSettings(world.stateStore);
    return {
      ...resolved,
      world,
      revision,
      now: world.clock.now(),
      scenario,
      setScenario(next: Scenario) {
        loadScenario(world, next);
        setScenarioState(next);
      },
    };
  }, [world, revision, scenario]);

  return <ExperimentContext.Provider value={value}>{children}</ExperimentContext.Provider>;
}

export function useExperiment(): ExperimentValue {
  const value = useContext(ExperimentContext);
  if (!value) throw new Error('useExperiment must be used inside <ExperimentProvider>');
  return value;
}
