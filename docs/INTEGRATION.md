# Wiring this into the real app

The whole template is arranged around one claim: **integration should mean
writing three adapters and deleting `src/experiment`.** If it ever means
editing `src/core`, the seam is in the wrong place and that is worth fixing
rather than working around.

## 1. Copy `src/core` and `src/adapters`

They are pure TypeScript. No React, no React Native, no Matrix SDK import, no
`Date.now()`. They should drop into the app unchanged.

Files, in dependency order:

| File | What it owns |
| --- | --- |
| `types.ts` | The envelope model and the shell/content split |
| `clock.ts` | `Clock`, `ManualClock`, duration formatting |
| `roomState.ts` | `RoomStateStore` — state events in, latest-wins |
| `settings.ts` | State events → typed settings, with provenance and warnings |
| `lifecycle.ts` | How alive an envelope is, right now |
| `replyTarget.ts` | The `ReplyTarget` union, chain walk, and render plan |

## 2. Implement the three adapters

### `RoomStateSource`

Hand back a `RoomStateStore` populated from your sync loop's state events.
Resolution deliberately stays in core so that the app and the experiment cannot
drift on what a given room config means.

```ts
class SyncRoomStateSource implements RoomStateSource {
  constructor(private room: YourRoom) {}
  roomId = this.room.id;
  state() {
    const store = new RoomStateStore();
    store.reset(this.room.currentStateEvents().map(toStateEvent));
    return store;
  }
  subscribe(listener) { return this.room.on('state', listener); }
}
```

Cache the store rather than rebuilding it per call if your state set is large;
`resolveRoomSettings` is cheap but `reset` is O(n).

### `TimelineSource`

This is the one that matters. `lookup()` **must** distinguish four outcomes:

```ts
lookup(id: EventId): TimelineLookup {
  const ev = this.store.getEvent(id);
  if (!ev)  return this.store.knownPruned(id)
    ? { status: 'pruned' }     // server dropped it — permanent
    : { status: 'unknown' };   // not local yet — may still arrive
  if (!this.canRead(ev)) return { status: 'forbidden' };
  return { status: 'found', envelope: toEnvelope(ev) };
}
```

Collapsing `unknown` / `pruned` / `forbidden` into a single null is exactly the
bug this template exists to prevent — it is what produces a "message deleted"
placeholder over a message that is merely two seconds from arriving.

`requestBackfill()` is fire-and-forget. Kick off the fetch, then notify through
`subscribe()` when the event lands. The renderer never awaits it: it draws
`pending` and re-renders when told.

### `Clock`

Use `systemClock()`. Keep the indirection even though it looks redundant — it
is what lets you write deterministic tests for expiry, and what keeps
`Date.now()` from creeping back into render paths.

## 3. Map your event shape to `Envelope`

The only real work. Watch three things:

- **`originTs` must be server-stamped.** Retention anchors to it. Local receipt
  time drifts and will expire messages at the wrong moment on a device whose
  clock is off.
- **Shell facts survive content loss.** `redaction` and `decryptionFailure`
  come from the event shell and must be populated even when there is no
  readable content — that is what lets a quote say "deleted by @mod" instead of
  "unavailable".
- **`selfDestructMs` is sender intent**, separate from room retention.
  `expiryOf()` takes the earlier of the two.

## 4. Render

`src/ui` is a reference implementation, not a component library. Take
`ReplyQuote.tsx`'s switch and its `never` check; restyle everything else.

The one structural thing to keep: `EnvelopeRow` reverses the chain before
drawing, so the outermost ancestor renders first and the immediate parent ends
up adjacent to the body quoting it. Draw them in resolution order and the
nesting reads backwards.

## 5. Delete `src/experiment`

Nothing in `core`, `adapters` or `ui` imports from it. The jest suite does, so
either port the scenario fixtures alongside the tests or drop both.

## Things to decide before you ship

These are genuine product calls the template surfaces but does not make:

1. **`expired_parent_behavior` default.** `placeholder` is the safe default and
   what this ships with, but a room full of ephemeral messages will accumulate
   orphaned replies reading "That worked, cheers." with no referent.
   `hide_message` is defensible; it is also the one that can make a user's own
   sent message vanish, which needs its own affordance.
2. **Whether `pending` ever times out.** Right now a backfill that never
   returns leaves a permanent "Loading…". A timeout that degrades to
   `unavailable` is probably right, and is a change to `resolveReplyTarget`
   plus a new deadline input.
3. **Whether the quote respects the *parent's* room settings.** Cross-room
   replies are out of scope here; everything resolves against one room's config.

---

## The wire, added later

`core/envelope.ts` + `core/packing.ts` now carry the reply model to and from a real
room event. What that turned up, in order of how much it would have cost to find
out late:

1. **A reply must not carry a Matrix fallback quote.** It survives the parent's
   revocation. This repo's whole thesis — render the quote from the resolved
   parent — is incompatible with the convention Matrix clients expect, and the
   incompatibility is the correct choice rather than an oversight.
2. **`txnId` has to be persisted with the message.** It is the only handle for
   unsending. Scoping it to the request is a silent, permanent loss of the ability
   to revoke.
3. **`revoked: true` arrives with readable content.** Check it first.
4. **Media beyond ten attachments cannot be revoked with its message.**
5. **The AES key travels inside the envelope.** So a lost room key loses the media
   too, not just the text — and a media reference is worthless outside the envelope
   that carried it. `unpackEnvelope` deliberately keeps key material out of the
   render model; `readFiles` fetches it only where it is needed.

Still open: nothing here has been round-tripped against a live deployment. The
shapes match the spec and the SDK's send path; whether a real `sync` hands back
exactly this is untested.
