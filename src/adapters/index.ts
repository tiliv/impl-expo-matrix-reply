/**
 * The seam.
 *
 * Everything in `src/core` is pure TypeScript with no React, no React Native
 * and no Matrix SDK import. It talks to the outside world only through the
 * three interfaces below. The experiment implements them with in-memory
 * objects; your app implements them with its real sync loop.
 *
 * Wiring this template into the app should mean writing three adapters and
 * deleting `src/experiment`. If it ever means editing `src/core`, the seam
 * was drawn in the wrong place — that is worth fixing rather than working
 * around.
 */

import type { Clock } from '../core/clock';
import type { RoomStateStore } from '../core/roomState';
import type { EventId, Envelope, RoomId, TimelineLookup, TimelineSlice } from '../core/types';

export type { Clock, TimelineSlice, TimelineLookup, Envelope, EventId, RoomId };

/**
 * Room state as the client currently knows it.
 *
 * Note the shape: this hands back a *store of state events*, not settings.
 * Resolution stays in core so that the app and the experiment cannot drift on
 * what a given room config means.
 */
export interface RoomStateSource {
  roomId: RoomId;
  state(): RoomStateStore;
  subscribe(listener: () => void): () => void;
}

/**
 * The local timeline slice, plus the ability to go get more of it.
 *
 * `requestBackfill` is fire-and-forget: it should kick off a fetch and then
 * notify through the source's own subscription when the event lands. The
 * renderer never awaits it — it draws `pending` and re-renders when told.
 */
export interface TimelineSource extends TimelineSlice {
  envelopes(): Envelope[];
  requestBackfill(id: EventId): void;
  subscribe(listener: () => void): () => void;
}

/**
 * A sketch of the real implementation, for whoever picks this up:
 *
 *   class SyncTimelineSource implements TimelineSource {
 *     lookup(id) {
 *       const ev = this.store.getEvent(id);
 *       if (!ev) return this.store.knownPruned(id)
 *         ? { status: 'pruned' }
 *         : { status: 'unknown' };
 *       if (!this.canRead(ev)) return { status: 'forbidden' };
 *       return { status: 'found', envelope: toEnvelope(ev) };
 *     }
 *     ...
 *   }
 *
 * The one thing worth insisting on: `lookup` must distinguish "we do not have
 * it" from "it is gone" from "you may not see it". Collapsing those three into
 * null is what produces quote placeholders that tell the user the wrong story.
 */
