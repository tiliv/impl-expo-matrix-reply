/**
 * Scenarios: arrange, then observe.
 *
 * Each scenario is a named arrangement of room state and timeline plus a
 * written-down expectation. The app shows the expectation next to the render,
 * so the experiment states its hypothesis instead of leaving you to squint at
 * the result and decide afterwards whether it was right.
 *
 * `arrange` is plain data-in, so the same function drives both the on-device
 * demo and the unit tests in `src/core/__tests__`. When a scenario's
 * expectation and its test disagree, one of them is a bug — that is the useful
 * property.
 */

import { DAY, HOUR, MINUTE } from '../core/clock';
import { STATE_HISTORY_VISIBILITY, STATE_REPLY, STATE_RETENTION } from '../core/settings';
import { stateEvent } from '../core/roomState';
import { envelope, EPOCH, ExperimentWorld, replyTo, text } from './world';

export interface Scenario {
  id: string;
  title: string;
  /** The question this arrangement is designed to answer. */
  question: string;
  arrange(world: ExperimentWorld): void;
  /** What you should see if the implementation is right. */
  expect: string[];
  /** Suggested next moves in the panel, once the scenario is loaded. */
  tryNext?: string[];
}

const ALICE = '@alice:example.org';
const YOU = '@you:example.org';

/** Retention is expressed in seconds on the wire, ms everywhere else. */
const retention = (seconds: number | null) =>
  stateEvent(STATE_RETENTION, { max_lifetime: seconds }, { sender: '@admin:example.org' });

const replyConfig = (content: Record<string, unknown>) =>
  stateEvent(STATE_REPLY, content, { sender: '@admin:example.org' });

export const SCENARIOS: Scenario[] = [
  {
    id: 'baseline',
    title: 'Plain reply',
    question: 'Does a reply subrender its parent at all?',
    arrange(w) {
      const parent = envelope({
        id: '$parent',
        sender: ALICE,
        originTs: EPOCH - 10 * MINUTE,
        body: text('Has anyone got the deploy key for staging? I keep getting 403s.'),
      });
      w.add(
        parent,
        envelope({
          id: '$child',
          sender: YOU,
          originTs: EPOCH - 2 * MINUTE,
          body: text('Rotated it this morning — check 1Password, the old one is dead.'),
          ...replyTo(parent.id),
        }),
      );
    },
    expect: [
      'The reply carries a quote block naming @alice.',
      'The quote is truncated to the room preview length, not the full body.',
      'No retention state event is set, so nothing shows a countdown.',
    ],
    tryNext: ['Send a retention policy and watch both messages acquire a countdown.'],
  },

  {
    id: 'expiring-live',
    title: 'Parent expires while you watch',
    question: 'What happens to a quote at the moment its parent expires?',
    arrange(w) {
      w.stateStore.send(retention(15 * 60));
      w.stateStore.send(replyConfig({ warn_before_ms: 10 * MINUTE }));
      const parent = envelope({
        id: '$parent',
        sender: ALICE,
        originTs: EPOCH - 9 * MINUTE,
        body: text('Door code is 4417, please do not put it in the group chat.'),
      });
      w.add(
        parent,
        envelope({
          id: '$child',
          sender: YOU,
          originTs: EPOCH - 1 * MINUTE,
          body: text('Got it, thanks.'),
          ...replyTo(parent.id),
        }),
      );
    },
    expect: [
      'The quote renders now, with roughly 6 minutes left on its countdown.',
      'Press play (or +5m) and the quote becomes a tombstone the instant it crosses the line.',
      'The reply itself survives — only the quoted content goes.',
    ],
    tryNext: [
      'Switch expired_parent_behavior to hide_message and advance again: now the reply goes too.',
    ],
  },

  {
    id: 'expired-parent',
    title: 'Reply to something already expired',
    question: 'Does an orphaned reply still make sense on its own?',
    arrange(w) {
      w.stateStore.send(retention(60 * 60));
      const parent = envelope({
        id: '$parent',
        sender: ALICE,
        originTs: EPOCH - 3 * HOUR,
        body: text('The number is 0161 496 0000.'),
      });
      w.add(
        parent,
        envelope({
          id: '$child',
          sender: YOU,
          originTs: EPOCH - 5 * MINUTE,
          body: text('That worked, cheers.'),
          ...replyTo(parent.id),
        }),
      );
    },
    expect: [
      'The parent is gone from the timeline body and the quote is a tombstone.',
      'We still name @alice: the shell survived retention, only the content went.',
      'This is the case that argues for hide_message — "That worked, cheers." alone is noise.',
    ],
    tryNext: ['Cycle expired_parent_behavior through all three values and pick the one you would ship.'],
  },

  {
    id: 'self-destruct-beats-room',
    title: 'Sender self-destruct vs. generous room policy',
    question: 'When two clocks disagree, which one wins?',
    arrange(w) {
      w.stateStore.send(retention(7 * 24 * 60 * 60));
      const parent = envelope({
        id: '$parent',
        sender: ALICE,
        originTs: EPOCH - 30 * MINUTE,
        body: text('Here is the draft before legal sees it.'),
        selfDestructMs: 20 * MINUTE,
      });
      w.add(
        parent,
        envelope({
          id: '$child',
          sender: YOU,
          originTs: EPOCH - 25 * MINUTE,
          body: text('Reading now.'),
          ...replyTo(parent.id),
        }),
      );
    },
    expect: [
      'The room would keep this for a week; the sender said 20 minutes.',
      'The shorter lifetime wins — the quote is already a tombstone.',
      'Privacy settings compose by tightening. A generous room must never extend a short-lived message.',
    ],
  },

  {
    id: 'redacted-parent',
    title: 'Parent was deleted',
    question: 'Is "deleted" distinguishable from "expired"?',
    arrange(w) {
      const parent = envelope({
        id: '$parent',
        sender: ALICE,
        originTs: EPOCH - 20 * MINUTE,
        body: text('[message that got moderated]'),
      });
      w.add(
        parent,
        envelope({
          id: '$child',
          sender: YOU,
          originTs: EPOCH - 18 * MINUTE,
          body: text('Reported.'),
          ...replyTo(parent.id),
        }),
      );
      w.redact(parent.id);
    },
    expect: [
      'The placeholder says deleted, not expired — different cause, different words.',
      'Redaction outranks retention: it stays "deleted" even after the retention window passes.',
    ],
    tryNext: ['Advance a day. The wording must not drift to "expired".'],
  },

  {
    id: 'undecryptable-parent',
    title: 'Parent we never got the key for',
    question: 'Do we claim a message expired when we never read it?',
    arrange(w) {
      w.stateStore.send(retention(60 * 60));
      const parent = envelope({
        id: '$parent',
        sender: ALICE,
        originTs: EPOCH - 90 * MINUTE,
        body: text('(unreadable)'),
        decryptionFailure: 'unknown_session',
      });
      w.add(
        parent,
        envelope({
          id: '$child',
          sender: YOU,
          originTs: EPOCH - 80 * MINUTE,
          body: text('Agreed.'),
          ...replyTo(parent.id),
        }),
      );
    },
    expect: [
      'Placeholder reads "cannot decrypt", even though retention would also call this expired.',
      'Undecryptable outranks expiry on purpose — we cannot honestly say a message we never read has aged out.',
    ],
  },

  {
    id: 'not-backfilled',
    title: 'Parent not fetched yet',
    question: 'Does "still loading" look different from "gone"?',
    arrange(w) {
      w.markNotBackfilled('$ancient');
      w.add(
        envelope({
          id: '$child',
          sender: YOU,
          originTs: EPOCH - 1 * MINUTE,
          body: text('Replying to something from way back up the scrollback.'),
          ...replyTo('$ancient'),
        }),
      );
    },
    expect: [
      'The quote is a neutral "loading" placeholder, not a warning tombstone.',
      'After ~2s the simulated backfill lands and the quote fills in.',
      'This is the case a naive not-found check gets wrong: it would say "deleted" and be lying.',
    ],
    tryNext: ['Turn off backfill_missing_parents and reload: it becomes a permanent unavailable.'],
  },

  {
    id: 'forbidden-parent',
    title: 'Parent behind history visibility',
    question: 'Do room permissions read as an error?',
    arrange(w) {
      w.stateStore.send(stateEvent(STATE_HISTORY_VISIBILITY, { history_visibility: 'joined' }));
      w.markForbidden('$before-you-joined');
      w.add(
        envelope({
          id: '$child',
          sender: ALICE,
          originTs: EPOCH - 4 * MINUTE,
          body: text('Following up on the thing from before you joined.'),
          ...replyTo('$before-you-joined'),
        }),
      );
    },
    expect: [
      'Placeholder says you do not have access — a rule, not a failure.',
      'history_visibility is a real Matrix state event; it resolves through the same path as our own config.',
    ],
  },

  {
    id: 'deep-chain',
    title: 'Three-deep chain, room-controlled depth',
    question: 'How far up does the subrender go, and who decides?',
    arrange(w) {
      w.stateStore.send(replyConfig({ render_depth: 2 }));
      const a = envelope({ id: '$a', sender: ALICE, originTs: EPOCH - 30 * MINUTE, body: text('Original question about the migration plan.') });
      const b = envelope({ id: '$b', sender: YOU, originTs: EPOCH - 20 * MINUTE, body: text('First answer.'), ...replyTo('$a') });
      const c = envelope({ id: '$c', sender: ALICE, originTs: EPOCH - 10 * MINUTE, body: text('Follow-up on the answer.'), ...replyTo('$b') });
      w.add(a, b, c, envelope({ id: '$d', sender: YOU, originTs: EPOCH - 1 * MINUTE, body: text('Final word.'), ...replyTo('$c') }));
    },
    expect: [
      'The last reply nests two quotes deep, then stops with "earlier messages not shown".',
      'Set render_depth to 1 and the nesting collapses; set it to 0 and quotes disappear entirely.',
      'Depth is a room decision, so the client cannot unilaterally decide how much history to surface.',
    ],
    tryNext: ['Send render_depth: 4 and confirm the chain ends cleanly at the root rather than at the limit.'],
  },

  {
    id: 'media-parent',
    title: 'Reply to a media envelope',
    question: 'What does a quote look like when the parent has no text?',
    arrange(w) {
      const parent = envelope({
        id: '$parent',
        sender: ALICE,
        originTs: EPOCH - 8 * MINUTE,
        body: { kind: 'media', mimetype: 'video/mp4', durationMs: 14_000, caption: 'the bit where it falls over' },
      });
      w.add(
        parent,
        envelope({
          id: '$child',
          sender: YOU,
          originTs: EPOCH - 3 * MINUTE,
          body: text('That is the exact frame the bug report is about.'),
          ...replyTo(parent.id),
        }),
      );
    },
    expect: [
      'The quote shows "Video · 0:14" plus the caption, not an empty text row.',
      'Every body kind must produce a preview — this is where the mixed-media envelope will plug in.',
    ],
  },

  {
    id: 'cycle',
    title: 'Malformed: reply loop',
    question: 'Does a hostile relation hang the renderer?',
    arrange(w) {
      const a = envelope({ id: '$a', sender: ALICE, originTs: EPOCH - 6 * MINUTE, body: text('Loop A'), ...replyTo('$b') });
      const b = envelope({ id: '$b', sender: ALICE, originTs: EPOCH - 5 * MINUTE, body: text('Loop B'), ...replyTo('$a') });
      w.stateStore.send(replyConfig({ render_depth: 4 }));
      w.add(a, b);
    },
    expect: [
      'Both rows render; the walk stops at the cycle instead of recursing.',
      'Nothing here is user-visible drama — it just must not hang or blow the stack.',
    ],
  },

  {
    id: 'bad-config',
    title: 'Room sends nonsense config',
    question: 'Can a bad state event break the timeline?',
    arrange(w) {
      w.stateStore.send(retention(-5));
      w.stateStore.send(
        replyConfig({ render_depth: 99, quote_preview_chars: 'lots', expired_parent_behavior: 'explode' }),
      );
      const parent = envelope({ id: '$parent', sender: ALICE, originTs: EPOCH - 12 * MINUTE, body: text('Perfectly ordinary message.') });
      w.add(parent, envelope({ id: '$child', sender: YOU, originTs: EPOCH - 2 * MINUTE, body: text('Perfectly ordinary reply.'), ...replyTo(parent.id) }));
    },
    expect: [
      'The timeline renders normally: every bad value falls back to its default.',
      'render_depth 99 clamps to 4; the other two fall back and raise warnings.',
      'The panel lists the warnings, so a misconfigured room is diagnosable instead of just broken.',
    ],
  },
];

export const DEFAULT_SCENARIO = SCENARIOS[0];

export function loadScenario(world: ExperimentWorld, scenario: Scenario): void {
  world.reset();
  scenario.arrange(world);
}

/** Re-exported so tests can build a world from a scenario in one line. */
export function worldFor(scenario: Scenario): ExperimentWorld {
  const world = new ExperimentWorld();
  loadScenario(world, scenario);
  return world;
}

export { DAY, HOUR, MINUTE };
