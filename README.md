# Claude Slack Agent

A local Slack interface for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Message the bot from your phone, Claude Code runs on your Mac with full access to your files, skills, and tools, and posts the result back to Slack.

This is **not** a cloud service. Everything runs locally on your machine. Your computer must be on (or asleep with `tcpkeepalive` enabled) for the bot to respond.

## What it does

- **Phone-as-CLI** -- DM the bot or @mention it in a channel. It spawns `claude -p` locally, streams the result back to Slack.
- **Thread = session** -- Replies in the same thread resume the same Claude session with full context. New thread = fresh session.
- **Channel-aware** -- Register channels as `interactive`, `notifications`, `logs`, or `project` (with a working directory). The bot routes messages and adjusts behavior accordingly.
- **Scheduled skills** -- Tell the bot "schedule claude-sync every weekday at 9am" and it creates a `launchd` plist. Missed runs fire on wake. Completion summaries post to your notifications channel via webhook.
- **Self-documenting** -- Invite the bot to a new channel and it introduces itself, then asks you to register the channel type.
- **Budget cap** -- Daily USD limit prevents runaway loops. Configurable in `budget.json`.
- **User allowlist** -- Only Slack user IDs in `ALLOWED_USER_IDS` can command the bot. Everyone else is silently ignored.

## Requirements

- macOS (uses `launchd` for the daemon and scheduled jobs)
- [Bun](https://bun.sh) (JavaScript runtime)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated (`claude` on your PATH)
- A Slack workspace where you can create apps

## Quick start

```bash
# 1. Clone into your Claude Code config directory
git clone https://github.com/YOUR_USER/claude-slack-agent.git ~/.claude/slack

# 2. Create the Slack app (manual, ~15 min)
#    Follow SETUP.md steps 1-8 to create the app, get tokens, and create channels.

# 3. Configure
cd ~/.claude/slack/bolt-app
cp .env.example .env
# Edit .env with your tokens and Slack user ID

# 4. Install and run
bun install
bun run start
```

Send `@Claude Agent hello` in your chat channel. You should get a reply.

## Running as a background daemon

Once the bot works in the foreground, install the `launchd` daemon so it runs automatically:

```bash
# Generate the plist with your paths (edit com.claude.slack-agent.plist first —
# make sure the bun path and HOME match your system)
cp ~/.claude/slack/com.claude.slack-agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.slack-agent.plist
```

The bot now starts on login, restarts on crash, and runs in the background. Logs go to `~/Library/Logs/claude-slack-agent.log`.

To restart:
```bash
launchctl kickstart -k gui/$(id -u)/com.claude.slack-agent
```

To stop:
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claude.slack-agent.plist
```

## Optional: wake-on-Slack

Let your Mac wake from sleep when a Slack event arrives:

```bash
sudo pmset -a tcpkeepalive 1
```

Scheduled jobs that fire while the Mac is asleep will run on wake thanks to `launchd`'s `StartCalendarInterval` catch-up behavior.

## Project structure

```
~/.claude/slack/
├── bolt-app/                 # The Slack bot (Bun + @slack/bolt, Socket Mode)
│   ├── index.ts              # Entry point — event handlers, message routing
│   ├── lib/
│   │   ├── runner.ts         # Spawns `claude -p` safely (no shell)
│   │   ├── auth.ts           # User ID allowlist
│   │   ├── mutex.ts          # Per-thread request serialization
│   │   ├── sessions.ts       # Thread-to-session mapping for --resume
│   │   ├── channels.ts       # Channel registry (type, cwd, allowlist)
│   │   ├── chunking.ts       # Splits long output for Slack's message limit
│   │   ├── budget.ts         # Daily USD cap
│   │   ├── attachments.ts    # Downloads Slack file uploads to /tmp
│   │   └── scheduler.ts      # launchd plist generator + localhost HTTP API
│   ├── .env.example          # Token template
│   └── package.json
├── bin/
│   └── run-scheduled.sh      # Wrapper for scheduled runs (posts to webhook)
├── channels.json             # Channel registry (created at runtime)
├── sessions.json             # Thread → session ID map (created at runtime)
├── budget.json               # Daily spend tracking (created at runtime)
├── schedules/                # Generated launchd plists (one per scheduled skill)
├── logs/                     # Scheduled run stdout/stderr
├── SETUP.md                  # Step-by-step Slack app creation guide
├── SLACK_INSTRUCTIONS.md     # Behavior instructions Claude reads per invocation
└── com.claude.slack-agent.plist  # launchd daemon config (edit paths before use)
```

## How it works

1. **Slack event** arrives via Socket Mode (websocket, no public URL needed).
2. **Auth check** — if the sender's Slack user ID isn't in the allowlist, the message is dropped.
3. **Budget check** — if the daily cap is exceeded, a warning is posted and the message is skipped.
4. **Per-thread mutex** — messages in the same thread are serialized; different threads run in parallel.
5. **`claude -p`** is spawned with the message as the prompt. The child process inherits your local auth, skills, and CLAUDE.md. `--permission-mode bypassPermissions` lets it act freely (the bot's own auth layer is the gate).
6. **Result** is posted back to the Slack thread. Long output is chunked or uploaded as a file.
7. **Session ID** is saved so replies in the same thread resume the same Claude session (`--resume`).

## Scheduling

Tell the bot something like:

> Schedule claude-sync every weekday at 6pm

It creates a `launchd` plist with `StartCalendarInterval` and registers it. The scheduled run invokes `claude --bare -p "/<skill>"` via `bin/run-scheduled.sh`, which posts a summary to your `#notifications` channel when done.

Manage schedules via natural language:

- "Show my schedules"
- "Remove the claude-sync schedule"
- "Kill all schedules"

## Channel types

| Type | Behavior |
|------|----------|
| `interactive` | Bidirectional chat. Bot replies in threads. |
| `notifications` | One-way. Scheduled task results post here. |
| `logs` | Debug output. Bot @mentions you only on failures. |
| `project` | Like interactive, but scoped to a `cwd`. |

Register a channel by inviting the bot and telling it: "This is a project channel for ~/code/my-app".

## Security model

- **User allowlist** — only your Slack user ID(s) can trigger the bot. All other messages are silently dropped.
- **No shell interpolation** — user messages are passed to `claude` via `spawn()` args array, never through a shell.
- **Budget cap** — daily USD limit prevents runaway loops (configurable in `budget.json`).
- **Localhost-only scheduler** — the HTTP endpoint for managing schedules binds to `127.0.0.1` only.
- **Socket Mode** — no public URL, no webhook endpoint. The bot connects *out* to Slack.

## Availability

| Scenario | Bot responds? | Scheduled jobs? |
|----------|--------------|-----------------|
| Mac awake | Yes | Yes |
| Mac asleep, plugged in | Yes (wakes via tcpkeepalive) | Fire on wake |
| Mac asleep, battery | Unreliable | Fire on wake |
| Mac powered off | No | Missed |
| After reboot + login | Yes (auto-starts) | Yes |

## Known limitations

- **iTerm must be running when a schedule fires.** Scheduled runs are routed through iTerm (via `bin/launch-via-iterm.sh`) so that macOS TCC attributes filesystem access to iTerm's stable binary path rather than Claude Code's per-version path — this is what makes permissions survive Claude auto-updates. The side effect: if iTerm is quit, or the Mac is booted but you haven't logged in yet, the `osascript` handoff fails silently, the wrapper exits 0, and no Slack notification is sent (launchd sees success because it never reached `run-scheduled.sh`). Keep iTerm running, or accept that schedules firing in those windows will silently no-op. Running `caffeinate` keeps the Mac awake but doesn't keep iTerm open.
- **`linkedin-job-apply` plist pins an nvm-versioned node path.** `schedules/com.claude.sched.linkedin-job-apply.plist` has `/Users/.../.nvm/versions/node/v22.12.0/bin` hardcoded in its `PATH`. If nvm's default node version changes, that path goes stale. The skill itself drives Chrome rather than using node directly, so this rarely bites — but if you see "command not found" errors from that schedule after an nvm upgrade, this is why. Regenerating the schedule via `POST /schedule` writes a plist without the nvm prefix.
- **Claude Code updates reset TCC every time.** The iTerm routing makes this harmless for schedules, but if you run `claude` directly from a *non-iTerm* context (a plain Terminal, a different launcher, a CI-like wrapper), macOS will prompt for filesystem access again after each Claude update. Only iTerm-spawned runs inherit the stable TCC attribution.

## License

MIT
