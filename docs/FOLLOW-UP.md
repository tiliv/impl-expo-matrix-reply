# Follow-up

Reviewed against the original intent while planning the remaining sandboxes.
This repo does what it set out to do; two things are missing and one boundary
is worth restating.

## 1. The quote is not tappable — and it should be

The stated intent for a reply quote is: *a single-line look is fine, because it
is tappable and it takes you to the message.* `ReplyQuote.tsx` renders the
quote with `numberOfLines` and no `Pressable`. So the affordance the one-line
constraint was justifying does not exist yet.

Adding it is not just an `onPress`. The interesting part is what a tap does for
each `ReplyTarget` variant, and the union already forces the question:

| Target | Tap should |
| --- | --- |
| `available` | Scroll to the parent and highlight it |
| `pending` | Nothing, or nudge the backfill — it must not feel dead |
| `expired` / `redacted` / `unavailable` | Explain, in place. Not a dead tap and not an error |
| `undecryptable` | Offer whatever key-recovery affordance exists, if any |
| `forbidden` | Say it is a rule, not a failure |
| `cycle` / `depth_exceeded` | Scroll to the nearest resolvable ancestor |

So: `planReplyTap(target): TapOutcome`, sitting next to `planReplyRender`,
tested the same way — resolution says what is true, presentation says what the
room wants drawn, and now interaction says what a tap means. Same split, third
axis.

The scroll-to-and-highlight mechanic itself needs a `TimelineController` on the
adapter seam (`scrollTo(eventId)`), because the renderer cannot own it.

## 2. Reply depth is resolved; reply *composition* is not modelled

This sandbox renders replies. Nothing here produces one. That is correct scope —
`impl-expo-message-composer` owns the draft — but the handoff should be named:
the composer holds a `replyToEventId` and packs it, and `packReply()` in this
repo is already the function that does it. When the composer is built, it
imports that shape rather than reinventing it, and the two `packing.ts` files
should share fixtures.

## 3. Reactions are a different pointer to the same problem

`impl-expo-react-emoji` has the same "the thing you are pointing at may be
gone" shape one layer down. It should reuse this repo's vocabulary —
`pending` / `expired` / `redacted` / `unavailable` / `forbidden` — rather than
inventing parallel names for the same states. If the two drift, the app ends up
with two different words for "we do not have it yet" in adjacent components.

## Not changing

- The no-fallback-quote decision. It is right and the reasoning in
  `packing.ts` is the best statement of it in the ecosystem.
- Deriving `forbidden` by explicit arrangement rather than from the viewer's
  join point. `impl-expo-chat-room` is where join points and history visibility
  get modelled properly; when it exists, this repo can consume that result
  instead of arranging it, and the union does not change either way.
