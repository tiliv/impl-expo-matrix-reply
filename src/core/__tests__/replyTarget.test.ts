/**
 * These tests drive the *same* arrange functions the on-device scenarios use.
 * If a scenario's written expectation and its test ever disagree, one of them
 * is wrong — which is the point of writing the expectation down.
 */

import { DAY, HOUR, MINUTE } from '../clock';
import { lifecycleOf } from '../lifecycle';
import { planReplyRender, resolveReplyChain, resolveReplyTarget } from '../replyTarget';
import { resolveRoomSettings, STATE_REPLY, STATE_RETENTION } from '../settings';
import { stateEvent } from '../roomState';
import { envelope, EPOCH, ExperimentWorld, text } from '../../experiment/world';
import { SCENARIOS } from '../../experiment/scenarios';

const worldFor = (id: string) => {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`no scenario ${id}`);
  const world = new ExperimentWorld();
  scenario.arrange(world);
  return world;
};

const ctxOf = (world: ExperimentWorld, at = world.clock.now()) => ({
  timeline: world.timelineSource,
  settings: resolveRoomSettings(world.stateStore).settings,
  now: at,
});

const byId = (world: ExperimentWorld, id: string) => {
  const found = world.envelopes().find((e) => e.id === id);
  if (!found) throw new Error(`no envelope ${id}`);
  return found;
};

describe('resolveReplyTarget', () => {
  it('quotes a live parent', () => {
    const world = worldFor('baseline');
    const target = resolveReplyTarget(byId(world, '$child'), ctxOf(world));
    expect(target.kind).toBe('available');
    if (target.kind !== 'available') return;
    expect(target.quote.sender).toBe('@alice:example.org');
    expect(target.quote.text).toContain('deploy key');
  });

  it('truncates the preview to the room-configured length', () => {
    const world = worldFor('baseline');
    world.stateStore.send(stateEvent(STATE_REPLY, { quote_preview_chars: 20 }));
    const target = resolveReplyTarget(byId(world, '$child'), ctxOf(world));
    if (target.kind !== 'available') throw new Error('expected available');
    expect(target.quote.truncated).toBe(true);
    expect(target.quote.text!.length).toBeLessThanOrEqual(20);
  });

  it('reports expired once the retention window passes, and not before', () => {
    const world = worldFor('expiring-live');
    expect(resolveReplyTarget(byId(world, '$child'), ctxOf(world)).kind).toBe('available');
    const later = ctxOf(world, world.clock.now() + 10 * MINUTE);
    expect(resolveReplyTarget(byId(world, '$child'), later).kind).toBe('expired');
  });

  it('lets the sender self-destruct beat a generous room policy', () => {
    const world = worldFor('self-destruct-beats-room');
    const target = resolveReplyTarget(byId(world, '$child'), ctxOf(world));
    expect(target.kind).toBe('expired');
  });

  it('keeps saying deleted, not expired, long after retention would have hit', () => {
    const world = worldFor('redacted-parent');
    world.stateStore.send(stateEvent(STATE_RETENTION, { max_lifetime: 60 }));
    const target = resolveReplyTarget(byId(world, '$child'), ctxOf(world, world.clock.now() + 30 * DAY));
    expect(target.kind).toBe('redacted');
  });

  it('does not claim expiry for a parent we never decrypted', () => {
    const world = worldFor('undecryptable-parent');
    const target = resolveReplyTarget(byId(world, '$child'), ctxOf(world));
    expect(target.kind).toBe('undecryptable');
  });

  it('separates not-yet-backfilled from gone', () => {
    const world = worldFor('not-backfilled');
    expect(resolveReplyTarget(byId(world, '$child'), ctxOf(world)).kind).toBe('pending');

    world.stateStore.send(stateEvent(STATE_REPLY, { backfill_missing_parents: false }));
    const target = resolveReplyTarget(byId(world, '$child'), ctxOf(world));
    expect(target.kind).toBe('unavailable');
    if (target.kind === 'unavailable') expect(target.reason).toBe('backfill_disabled');
  });

  it('separates forbidden from missing', () => {
    const world = worldFor('forbidden-parent');
    expect(resolveReplyTarget(byId(world, '$child'), ctxOf(world)).kind).toBe('forbidden');
  });

  it('terminates on a reply cycle instead of recursing', () => {
    const world = worldFor('cycle');
    const chain = resolveReplyChain(byId(world, '$a'), ctxOf(world));
    expect(chain.some((t) => t.kind === 'cycle')).toBe(true);
    expect(chain.length).toBeLessThanOrEqual(4);
  });
});

describe('resolveReplyChain depth', () => {
  it('honours render_depth and flags that the chain continues', () => {
    const world = worldFor('deep-chain');
    const chain = resolveReplyChain(byId(world, '$d'), ctxOf(world));
    expect(chain.filter((t) => t.kind === 'available')).toHaveLength(2);
    expect(chain[chain.length - 1].kind).toBe('depth_exceeded');
  });

  it('renders no quote at all at depth 0', () => {
    const world = worldFor('deep-chain');
    world.stateStore.send(stateEvent(STATE_REPLY, { render_depth: 0 }));
    const chain = resolveReplyChain(byId(world, '$d'), ctxOf(world));
    expect(chain).toEqual([{ kind: 'depth_exceeded', eventId: '$c' }]);
  });

  it('stops at the root without a depth_exceeded marker when the chain truly ends', () => {
    const world = worldFor('deep-chain');
    world.stateStore.send(stateEvent(STATE_REPLY, { render_depth: 4 }));
    const chain = resolveReplyChain(byId(world, '$d'), ctxOf(world));
    expect(chain.some((t) => t.kind === 'depth_exceeded')).toBe(false);
    expect(chain).toHaveLength(3);
  });
});

describe('planReplyRender', () => {
  const world = worldFor('expired-parent');
  const expiredTarget = resolveReplyTarget(byId(world, '$child'), ctxOf(world));

  it('maps one expired target onto three different renders', () => {
    expect(planReplyRender(expiredTarget, 'placeholder').render).toBe('placeholder');
    expect(planReplyRender(expiredTarget, 'hide_quote').render).toBe('quote_omitted');
    expect(planReplyRender(expiredTarget, 'hide_message').render).toBe('message_hidden');
  });

  it('never hides a reply just because its parent is still loading', () => {
    const pending = resolveReplyTarget(byId(worldFor('not-backfilled'), '$child'), ctxOf(worldFor('not-backfilled')));
    expect(planReplyRender(pending, 'hide_message').render).toBe('placeholder');
  });
});

describe('resolveRoomSettings', () => {
  it('converts retention from seconds to milliseconds', () => {
    const world = new ExperimentWorld();
    world.stateStore.send(stateEvent(STATE_RETENTION, { max_lifetime: 3600 }));
    expect(resolveRoomSettings(world.stateStore).settings.retentionMaxLifetimeMs.value).toBe(HOUR);
  });

  it('falls back and warns on unusable values rather than throwing', () => {
    const world = worldFor('bad-config');
    const { settings, warnings } = resolveRoomSettings(world.stateStore);

    expect(settings.renderDepth.value).toBe(4); // clamped, not rejected
    expect(settings.quotePreviewChars.value).toBe(140); // fell back
    expect(settings.expiredParentBehavior.value).toBe('placeholder');
    expect(settings.retentionMaxLifetimeMs.value).toBeNull();
    expect(warnings.map((w) => w.setting)).toEqual(
      expect.arrayContaining(['quotePreviewChars', 'expiredParentBehavior']),
    );
  });

  it('records provenance so a silent default is distinguishable from a set value', () => {
    const world = new ExperimentWorld();
    expect(resolveRoomSettings(world.stateStore).settings.renderDepth.source.kind).toBe('default');
    world.stateStore.send(stateEvent(STATE_REPLY, { render_depth: 2 }, { sender: '@admin:example.org' }));
    const source = resolveRoomSettings(world.stateStore).settings.renderDepth.source;
    expect(source.kind).toBe('state_event');
    if (source.kind === 'state_event') expect(source.sender).toBe('@admin:example.org');
  });
});

describe('lifecycleOf', () => {
  it('warns before it expires', () => {
    const world = new ExperimentWorld();
    world.stateStore.send(stateEvent(STATE_RETENTION, { max_lifetime: 600 }));
    world.stateStore.send(stateEvent(STATE_REPLY, { warn_before_ms: 5 * MINUTE }));
    const settings = resolveRoomSettings(world.stateStore).settings;
    const e = envelope({ sender: '@a:b', originTs: EPOCH, body: text('hi') });

    expect(lifecycleOf(e, settings, EPOCH + 1 * MINUTE).status).toBe('live');
    expect(lifecycleOf(e, settings, EPOCH + 6 * MINUTE).status).toBe('expiring');
    expect(lifecycleOf(e, settings, EPOCH + 11 * MINUTE).status).toBe('expired');
  });

  it('never expires when the room sets no retention', () => {
    const settings = resolveRoomSettings(new ExperimentWorld().stateStore).settings;
    const e = envelope({ sender: '@a:b', originTs: EPOCH, body: text('hi') });
    expect(lifecycleOf(e, settings, EPOCH + 10 * DAY).status).toBe('live');
  });
});

describe('every scenario', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s arranges and resolves without throwing', (_id, scenario) => {
    const world = new ExperimentWorld();
    scenario.arrange(world);
    const ctx = ctxOf(world);
    for (const e of world.envelopes()) {
      const chain = resolveReplyChain(e, ctx);
      for (const target of chain) {
        expect(planReplyRender(target, ctx.settings.expiredParentBehavior.value)).toBeDefined();
      }
    }
    expect(scenario.expect.length).toBeGreaterThan(0);
  });
});
