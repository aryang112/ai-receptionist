# Deploy and ops

**Purpose.** How to ship this repo to production safely, verify the ship actually landed, and what an agent must never flip without Aryan's say-so.

**Key facts (not code):**
- Deploy from the LIVE worktree ONLY: `cd ~/Documents/Dev/ai-receptionist-live-2026-09-12` (branch `codex/gpt-live-taste-test`) then `railway up --service erica --detach`. `railway up` must be the FIRST token of the command to match the `Bash(railway up:*)` allow rule — `cd … && railway up` is refused. When the cwd can't be the worktree directly, use `railway up --project <id> --environment production --service <id> --detach --path-as-root <dir>`, where `<dir>` is a `git archive <commit> | tar -x -C <dir>` snapshot (keeps untracked files like `outputs/` out of the upload). `~/Documents/Dev/ai-receptionist` (main) was `railway unlink`ed 2026-09-16 specifically so it can no longer ship old `main` by accident — do not re-link it.
- Verify with `railway deployment list` (expect a new SUCCESS row) AND `GET /admin/voice-test` → `engine: "live"`. **A booted container proves nothing** — old `main` boots fine too, it just has no GPT-Live and no fixes.
- Boot-log lines to expect (from `src/index.ts`, `src/services/phorest.client.ts`): `"Server up"`, `"Service catalog warmed"`, `"Client phone index loaded"`.
- Admin/QA routes: `/admin` (dashboard), `/admin/api/calls`, `/admin/api/stats`, `/admin/api/transcript/:callSid`, `/admin/api/recording/:callSid` (all `ADMIN_TOKEN`-gated); `/admin/voice-test` (GET status, POST `/variant` to switch engine — only meaningful when `PHOREST_WRITE_MODE=simulate`).
- Call-review routine: `.claude/commands/call-review.md`, twice-daily QA sweep over real call recordings/transcripts.

**Env vars that must NEVER be flipped without Aryan:** `PHOREST_WRITE_MODE` (real calendar writes), `OWNER_TRANSFER_MODE` (rings Richa's real phone), `OWNER_SMS_MODE`, `TRANSFER_WINDOW_END` (currently a temporary `23:00`/`real` taste-test config — see `transfer-and-messages.md`), `SMS_OPEN_TO_ALL`, `SMS_SEND_MODE`, `SMS_ALLOWED_NUMBERS` (see `sms-concierge.md`), and the Twilio number's `SmsUrl`/`voice_url` webhooks.

**Guarded by:** no test file (this is an ops procedure) — verify by running the commands below against the actual deployed service, not by reading code.

**Traps:**
- 2026-09-15: `railway up` from the wrong worktree shipped old `main` and rolled production back three days; the boot log looked perfect the whole time. This is why the verify step is a route unique to the live build, not a health check.
- GitHub `main` can go stale for weeks while prod runs from a local worktree (2026-09-08/GitHub main sync lesson) — push main after every deploy record, and before delegating to any cloud/Codex agent that might build on a stale `main`. Port foreign branches as `src/` diffs; never merge.
- `state.md` may have been written into the WRONG worktree's copy during a session (documented 2026-09-15 as a "WORKTREE SPLIT" — both copies were reconciled by hand). Check which worktree you're actually in before trusting `state.md` is current.
- A backlog item (not yet done as of 2026-09-16): expose a build identity (commit sha) on `/admin/voice-test` — until then, engine+mode fields are the only proof of what's actually running.
- Never `set -a; source .env` in a shell to run a probe — it mangled `PHOREST_API_SECRET` (a shell-special character) into a wrong value and produced a phantom Phorest 401. Read secrets via node's dotenv instead: `node -e "require('dotenv').config({quiet:true}); ..."`.

**Verify:**
```bash
cd ~/Documents/Dev/ai-receptionist-live-2026-09-12
git status && git branch --show-current   # confirm worktree + branch BEFORE any deploy
railway up --service erica --detach
railway deployment list                    # expect new SUCCESS row
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/admin/voice-test   # expect engine:"live"
```

**Do not:**
- Run `railway up` from `~/Documents/Dev/ai-receptionist` (main) — it is unlinked on purpose.
- Call a boot log "verified" without also checking `/admin/voice-test`.
- Flip `PHOREST_WRITE_MODE`, `OWNER_TRANSFER_MODE`, `OWNER_SMS_MODE`, `TRANSFER_WINDOW_END`, `SMS_OPEN_TO_ALL`, `SMS_SEND_MODE`, `SMS_ALLOWED_NUMBERS`, or the number's `SmsUrl`/`voice_url` without Aryan's explicit go-ahead.
