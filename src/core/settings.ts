/**
 * Room state -> typed settings.
 *
 * Every resolved value carries its provenance, so the UI can answer "why is
 * this quote hidden?" with "because @admin set app.envelope.reply 4 minutes
 * ago", rather than leaving you to guess. Provenance is also how you spot the
 * bug where a setting silently fell back to its default.
 *
 * Bad values do not throw and do not propagate. They fall back and record a
 * warning, because a hostile or stale room should not be able to break the
 * timeline.
 */

import { DAY, MINUTE } from './clock';
import type { RoomStateStore } from './roomState';
import type { UserId } from './types';

export const STATE_RETENTION = 'm.room.retention';
export const STATE_HISTORY_VISIBILITY = 'm.room.history_visibility';
/** Ours: no Matrix event type describes how a client should draw a quote. */
export const STATE_REPLY = 'app.envelope.reply';

export type SettingSource =
  | { kind: 'default' }
  | { kind: 'state_event'; type: string; eventId: string; sender: UserId; originTs: number };

export interface Resolved<T> {
  value: T;
  source: SettingSource;
}

export type HistoryVisibility = 'world_readable' | 'shared' | 'invited' | 'joined';

/** What to do with a reply whose parent we may not show. */
export type ExpiredParentBehavior =
  /** Draw a tombstone where the quote would be. The reply stays readable. */
  | 'placeholder'
  /** Drop the quote, keep the reply. Reads as a normal message. */
  | 'hide_quote'
  /** Withhold the reply too: without its parent it may be misleading. */
  | 'hide_message';

export interface RoomSettings {
  /** null = keep forever. */
  retentionMaxLifetimeMs: Resolved<number | null>;
  /** How long before expiry we start warning in the UI. */
  retentionWarnBeforeMs: Resolved<number>;
  /** 1 = quote the parent. 2 = quote the parent's quote too. 0 = never quote. */
  renderDepth: Resolved<number>;
  quotePreviewChars: Resolved<number>;
  expiredParentBehavior: Resolved<ExpiredParentBehavior>;
  /** May we ask the server for a parent we do not hold locally? */
  backfillMissingParents: Resolved<boolean>;
  historyVisibility: Resolved<HistoryVisibility>;
}

export interface SettingsWarning {
  setting: keyof RoomSettings;
  message: string;
}

export interface ResolvedRoomSettings {
  settings: RoomSettings;
  warnings: SettingsWarning[];
}

const DEFAULTS = {
  retentionMaxLifetimeMs: null as number | null,
  retentionWarnBeforeMs: 5 * MINUTE,
  renderDepth: 1,
  quotePreviewChars: 140,
  expiredParentBehavior: 'placeholder' as ExpiredParentBehavior,
  backfillMissingParents: true,
  historyVisibility: 'shared' as HistoryVisibility,
};

const BEHAVIORS: ExpiredParentBehavior[] = ['placeholder', 'hide_quote', 'hide_message'];
const VISIBILITIES: HistoryVisibility[] = ['world_readable', 'shared', 'invited', 'joined'];

export const DEFAULT_SOURCE: SettingSource = { kind: 'default' };

export function resolveRoomSettings(store: RoomStateStore): ResolvedRoomSettings {
  const warnings: SettingsWarning[] = [];

  const retentionEvent = store.get(STATE_RETENTION);
  const replyEvent = store.get(STATE_REPLY);
  const visibilityEvent = store.get(STATE_HISTORY_VISIBILITY);

  const sourceOf = (e: typeof retentionEvent): SettingSource =>
    e
      ? { kind: 'state_event', type: e.type, eventId: e.eventId, sender: e.sender, originTs: e.originTs }
      : DEFAULT_SOURCE;

  const warn = (setting: keyof RoomSettings, message: string) => warnings.push({ setting, message });

  /** Reads a field, validating it; on failure records a warning and uses the default. */
  function read<T>(
    setting: keyof RoomSettings,
    event: typeof retentionEvent,
    field: string,
    fallback: T,
    validate: (raw: unknown) => T | null,
  ): Resolved<T> {
    if (!event || !(field in event.content)) return { value: fallback, source: DEFAULT_SOURCE };
    const raw = event.content[field];
    if (raw === null || raw === undefined) return { value: fallback, source: DEFAULT_SOURCE };
    const ok = validate(raw);
    if (ok === null) {
      warn(setting, `${event.type}.${field} = ${JSON.stringify(raw)} is not usable; using default`);
      return { value: fallback, source: DEFAULT_SOURCE };
    }
    return { value: ok, source: sourceOf(event) };
  }

  const int = (min: number, max: number) => (raw: unknown): number | null => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    return Math.min(max, Math.max(min, Math.round(raw)));
  };

  // MSC2228 states retention in seconds; we work in ms everywhere else, so this
  // is the one place the unit changes. Getting it wrong is a 1000x expiry bug.
  const retentionMaxLifetimeMs = read<number | null>(
    'retentionMaxLifetimeMs',
    retentionEvent,
    'max_lifetime',
    DEFAULTS.retentionMaxLifetimeMs,
    (raw) => {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
      return Math.min(365 * DAY, Math.round(raw) * 1000);
    },
  );

  return {
    settings: {
      retentionMaxLifetimeMs,
      retentionWarnBeforeMs: read(
        'retentionWarnBeforeMs',
        replyEvent,
        'warn_before_ms',
        DEFAULTS.retentionWarnBeforeMs,
        int(0, 7 * DAY),
      ),
      renderDepth: read('renderDepth', replyEvent, 'render_depth', DEFAULTS.renderDepth, int(0, 4)),
      quotePreviewChars: read(
        'quotePreviewChars',
        replyEvent,
        'quote_preview_chars',
        DEFAULTS.quotePreviewChars,
        int(20, 500),
      ),
      expiredParentBehavior: read(
        'expiredParentBehavior',
        replyEvent,
        'expired_parent_behavior',
        DEFAULTS.expiredParentBehavior,
        (raw) => (BEHAVIORS.includes(raw as ExpiredParentBehavior) ? (raw as ExpiredParentBehavior) : null),
      ),
      backfillMissingParents: read(
        'backfillMissingParents',
        replyEvent,
        'backfill_missing_parents',
        DEFAULTS.backfillMissingParents,
        (raw) => (typeof raw === 'boolean' ? raw : null),
      ),
      historyVisibility: read(
        'historyVisibility',
        visibilityEvent,
        'history_visibility',
        DEFAULTS.historyVisibility,
        (raw) => (VISIBILITIES.includes(raw as HistoryVisibility) ? (raw as HistoryVisibility) : null),
      ),
    },
    warnings,
  };
}

export function describeSource(source: SettingSource): string {
  return source.kind === 'default' ? 'default' : `${source.type} by ${source.sender}`;
}
