# Closing and end_call

**Purpose.** Detect that Erica has said goodbye before hanging up, and stop
her asking "anything else?" more than once per call — as SERVER state, not
prose the model might ignore.

**Key code** — `src/realtime/twilioStream.ts`:
- `handleEndCall` — thin wrapper around the shared `endCallNow(reason)`
  hangup core (drain + REST + bargeInEpoch abort).
- `liveHasCurrentFarewell` — private farewell-detection regex; gates a
  hangup so end_call can't fire before Erica's own goodbye audio is heard.
- `isMoreHelpOfferText` — exported standalone function; detects "anything/
  something else", "help with anything", etc. in Erica's OWN output text
  (joined rolling buffer, so a split like "anything" + " else" across two
  audio fragments still matches).
- `moreHelpOffered` — private field, sticky for the call once
  `isMoreHelpOfferText` matches; no mid-call reset (every call segment gets
  a fresh `TwilioRealtimeCall` instance, including transfer-failback).
- `applyMoreHelpOfferNote` — called from the ONE central place,
  `registerTrackedTool` (every tool registration goes through it): if
  `moreHelpOffered` is true and the result isn't an `ending:true` result, it
  sets `moreHelpAlreadyOffered:true` and appends "you already asked; do not
  ask again, close instead" to the tool's `note`.
- `registerTrackedTool` — counts `toolCallsInFlight`; wraps every handler.

**Guarded by:**
- `twilioStream.goodbyeGrace.test.ts` — end_call vs. in-progress goodbye
  audio.
- `twilioStream.liveIntegration.test.ts` — `isMoreHelpOfferText` unit cases
  + `applyMoreHelpOfferNote` wiring (offer split across fragments, `ending:true`
  results left untouched).
- `twilioStream.spam.test.ts` — `end_call(reason:'spam')` → blocklist outcome.
- `twilioStream.silenceWatchdog.test.ts` — silence check-in/hangup timers.
- The twice-daily call-review routine (`.claude/commands/call-review.md`,
  "Closing (register item 14 + mirror)" bullet) — catches BOTH a repeated
  offer AND the mirror defect (completed action, no offer, no goodbye,
  silence) since neither is fully preventable server-side on audio-native Live.

**Traps:**
- The Live path never sees caller transcript text (`OPENAI_INPUT_TRANSCRIPTION`
  defaults `off`) — the server can detect ERICA's offer from her own output,
  but cannot compute "caller is done" from what the caller said. Prose stays
  for that judgment call; only the "never twice" mechanic is server state.
- Success notes on the three visit tools used to say an unconditional "...then
  ask once if they need anything else" — contradicted a caller saying
  "great, thanks, bye" in the same breath. Reworded 2026-09-16 to "...unless
  they have already said they are done."
- `leave_message_for_owner`'s success note already branches on "clearly
  done" separately — do not fold it into the generic offer-counter fix.
- A farewell outranks the offer — check `liveHasCurrentFarewell` before
  treating a pending offer as unresolved.

**Verify:**
```bash
npx vitest run src/tests/twilioStream.goodbyeGrace.test.ts src/tests/twilioStream.liveIntegration.test.ts src/tests/twilioStream.spam.test.ts
node --env-file=.env --import tsx scripts/render-live-prompts.ts   # confirm BACKEND_TOOL_USE offer-counter wording
```

**Do not:**
- Add a second place that appends the "already offered" note — go through
  `registerTrackedTool`/`applyMoreHelpOfferNote`, the ONE central place.
- Reset `moreHelpOffered` mid-call — a fresh call segment already gets a new
  instance; a manual reset would let the offer repeat.
- Trust prose alone to stop a double "anything else?" — verify server state.
