# impl-expo-matrix-reply

A contained, runnable experiment for **reply envelopes that subrender the thing
they are replying to**, where the thing being replied to might not be there any
more.

Expo SDK 57, dev client. Nothing in here talks to a homeserver — the transport
is faked so the *policy* does not have to be.

```bash
npm install
npx expo run:ios      # or run:android — dev client, not Expo Go
npm test              # core logic, no device needed
npm run typecheck
```

## What this template is actually about

Drawing a quote block is easy. The hard part is that the parent envelope has
about eight distinct ways of not being available, and a UI that only handles
"found" and "not found" ships placeholders that lie — telling the user a
message was *deleted* when it is merely still loading, or showing nothing at
all for a message that really was deleted.

So the centrepiece is a union in `src/core/replyTarget.ts`:

| `ReplyTarget.kind` | Means | Reads as |
| --- | --- | --- |
| `available` | We have it and may show it | The quote |
| `pending` | Not local yet, backfill allowed | "Loading…", neutral |
| `expired` | We hold the shell, retention took the content | "…has expired" |
| `redacted` | Someone deleted it on purpose | "…was deleted" |
| `undecryptable` | No megolm session; we never read it | "Cannot decrypt" |
| `unavailable` | Server dropped it, or backfill is off | "…no longer available" |
| `forbidden` | `history_visibility` says no | "You do not have access" |
| `cycle` | Malformed self/loop reference | Stops the walk |
| `depth_exceeded` | Real parent, room says stop drawing | "Earlier messages not shown" |

The renderer switches on this union with a `never` check at the bottom, so
adding a ninth case stops the build until someone decides how it looks.

Resolution and presentation are deliberately separate: `resolveReplyTarget`
says *what is true*, `planReplyRender` says *what the room wants drawn about
it*. The same `expired` target renders three different ways depending on
`expired_parent_behavior`, and that mapping is unit-tested without building a
single timeline.

## Room settings are not mocked

This was the explicit design constraint. There is no fake settings object
anywhere, and no `if (__DEV__)` bypass.

Settings arrive the way they will in production: as **room state events** in a
`RoomStateStore`, resolved by `resolveRoomSettings()` into typed values. The
control panel's job is to *send state events*. It cannot set a setting any
other way. So the resolution path you exercise on a device is the same code the
real room will drive — swapping the store for one fed by your sync loop changes
the transport and nothing else.

Two properties fall out of that and are worth keeping:

- **Provenance.** Every resolved value records whether it came from a state
  event (and which one, and who sent it) or fell back to a default. The panel
  prints it under each control. This is how you catch the bug where a setting
  silently reverted rather than applied.
- **Hostile input is survivable.** A room sending `render_depth: 99` or
  `quote_preview_chars: "lots"` must not break the timeline. Bad values clamp
  or fall back and raise a warning; they never throw. There is a scenario
  ("Room sends nonsense config") that does exactly this.

Recognised state events:

| Type | Fields | Notes |
| --- | --- | --- |
| `m.room.retention` | `max_lifetime` | Real MSC2228. **Seconds** on the wire, ms internally — the one place the unit changes |
| `m.room.history_visibility` | `history_visibility` | Real Matrix |
| `app.envelope.reply` | `render_depth`, `quote_preview_chars`, `expired_parent_behavior`, `warn_before_ms`, `backfill_missing_parents` | Ours: no Matrix event describes how to draw a quote |

## Expiry is observable

Time is an input, never an ambient fact. Nothing outside `Clock` calls
`Date.now()`, so the TIME tab can push the clock forward an hour, or run it at
20× and let you watch a quote decay into a tombstone in real time.

One rule worth carrying over: when a room's retention policy and a sender's own
self-destruct disagree, **the earlier expiry wins**. Privacy settings compose by
tightening. A generous room must never extend the life of a message its sender
marked short-lived. `expiryOf()` is where that lives.

## Scenarios

The SCENARIO tab lists twelve arrangements. Each states the question it asks
and what you should see if the implementation is right, next to the live
render. The same `arrange()` functions drive the jest suite — when a scenario's
written expectation and its test disagree, one of them is a bug, and that is
the useful property.

Start with *Parent expires while you watch*: load it, hit play, and watch the
quote cross the line.

## Layout

```
src/core/        pure TS — no React, no RN, no Matrix SDK. This is what you lift.
src/adapters/    the three interfaces core needs from the outside world
src/ui/          reference renderer
src/experiment/  in-memory world, scenarios, control panel — deleted on integration
```

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for wiring this into the real
app.

## Known edges

- `history_visibility` is resolved and displayed, but the experiment decides
  `forbidden` by explicit arrangement rather than by deriving it from the
  viewer's join point. Real clients derive it; the union does not change.
- Edits are modelled only as an `edited` flag on the quote. If you need edit
  history in quotes, that is a new `ReplyTarget` variant, not a tweak.
- No pagination: the timeline is a plain list. Backfill is simulated with a
  timer so the `pending` state is visible for ~2s.

---

## The wire boundary

`src/core/envelope.ts` (byte-identical across the `impl-expo-*` repos) and
`src/core/packing.ts` are what connect this experiment to the shape the Noodles API
actually moves. Derived from `noodles-model/openapi` and `noodles-sdk`, not invented.

**Two envelopes, and only one of them is specified.** The server stores room
content as `additionalProperties: {}` — the spec calls it *"opaque to server"* — so
the inner plaintext event is entirely a client concern. The only example anywhere
in the ecosystem is `olm-demo/App.tsx`: `{ msgtype: 'm.text', body }`. Anything
richer than a text line has no precedent, which makes the choices in `packing.ts`
decisions rather than transcriptions.

**Three facts that bite:**

- **`txnId` is the unsend handle, not a retry token.** The server derives `eventId`
  from `(txnId, senderUserId)`, and `POST /rooms/{id}/messages/revoke` takes
  `txnId` — not `eventId`. A client that generates one, sends, and forgets it can
  never unsend that message. `packReply` returns it alongside the content so it
  cannot be dropped by accident.
- **Revocation is media-aware and capped at ten.**
  `RevokeRoomMessageRequest.mediaIds` is `maxItems: 10`. Past ten, unsending takes
  the text and leaves the files downloadable. `revocationPlan()` reports what is
  not covered rather than truncating silently.
- **`revoked` must be checked before content is read.** The server marks revoked
  events rather than erasing them, so readable text arrives with `revoked: true`.
  Decoding first and checking after renders an unsent message — the single most
  important ordering in `decodeWire`.

**No Matrix reply fallback, deliberately.** Matrix replies embed the parent's text
in the child's own `body` prefixed with `> `, so unaware clients show something.
We cannot: that copy survives the parent's revocation and its retention window,
which defeats the entire point of rendering the quote from the resolved parent.
Cost: a client that does not understand `app.envelope.relates_to` shows our reply
as a bare message. Acceptable — there is one client.
