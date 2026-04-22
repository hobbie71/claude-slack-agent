# Slack Agent — Manual Setup

The Slack app has to be created by hand in the web UI. Everything else is automated.
Plan on ~15 minutes. At the end you'll have three tokens + one webhook URL to paste into `.env`.

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps>
2. **Create New App** → **From scratch**
3. Name: `Claude Agent` (or whatever)
4. Pick your workspace → **Create App**

## 2. Enable Socket Mode

(Socket Mode = no public URL; the app connects out to Slack over websocket.)

1. Left sidebar → **Socket Mode** → toggle **Enable Socket Mode** ON
2. It will prompt you to create an **App-Level Token**.

   - Name: `socket-mode`
   - Scope: `connections:write`
   - Create → **copy the token** (starts with `xapp-`). This is `SLACK_APP_TOKEN`.

## 3. Bot Token Scopes

Left sidebar → **OAuth & Permissions** → **Bot Token Scopes** → **Add an OAuth Scope** for each:

```
chat:write
chat:write.public
channels:read
channels:history
groups:history
app_mentions:read
im:history
im:read
im:write
users:read
reactions:write
files:read
files:write
```

## 4. Event Subscriptions

Left sidebar → **Event Subscriptions** → toggle **Enable Events** ON.

Under **Subscribe to bot events**, add:

```
app_mention
message.im
```

Save changes.

## 5. Install the app to your workspace

Left sidebar → **Install App** → **Install to Workspace** → **Allow**.

After install, you'll land on a page with the **Bot User OAuth Token** (starts with `xoxb-`).
**Copy it.** This is `SLACK_BOT_TOKEN`.

## 6. Incoming webhook (for scheduled-run completion notifications)

Left sidebar → **Incoming Webhooks** → toggle ON → **Add New Webhook to Workspace** →
pick `#claude-notifications` (create the channel first in Slack if it doesn't exist).

Copy the resulting URL (starts with `https://hooks.slack.com/services/...`).
This is `SLACK_COMPLETION_WEBHOOK`.

## 7. Find your Slack user ID

In the Slack app: click your profile picture (top right) → **Profile** → **⋯ More** → **Copy member ID**.
It starts with `U`. This is `ALLOWED_USER_IDS` (comma-separate if you ever want multiple).

**Only this user ID will be able to command the bot.** Anyone else gets ignored.

## 8. Create channels in Slack

Create these channels (public or private, up to you):

- `#claude-chat` — interactive commands
- `#claude-notifications` — scheduled run summaries
- `#claude-logs` — debug output (optional)

For each one: invite the bot with `/invite @Claude Agent`.

## 9. Paste tokens into `.env`

```bash
cd ~/.claude/slack/bolt-app
cp .env.example .env
open .env   # or use your editor
```

Fill in:

- `SLACK_BOT_TOKEN` (xoxb-...)
- `SLACK_APP_TOKEN` (xapp-...)
- `SLACK_COMPLETION_WEBHOOK` (https://hooks.slack.com/...)
- `ALLOWED_USER_IDS` (U...)

Leave `SCHEDULER_PORT` at the default.

## 10. Install deps and start the bot

```bash
cd ~/.claude/slack/bolt-app
bun install
bun run start
```

You should see `⚡️ Bolt app is running!` in the terminal.

Send `@Claude Agent hello` in `#claude-chat` — you should get a reply.

Once it's working, install the launchd daemon so it runs in the background automatically.

## 11. Install the launchd daemon (after you've verified manual boot works)

```bash
# Stop the foreground instance (Ctrl-C) then:
cp ~/.claude/slack/com.claude.slack-agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.slack-agent.plist

# Verify:
launchctl list | grep claude.slack-agent
tail -f ~/Library/Logs/claude-slack-agent.log
```

To stop / reload:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claude.slack-agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.slack-agent.plist
```

## 12. Optional — let Slack events wake your Mac

```bash
sudo pmset -a tcpkeepalive 1
```

Lets Socket Mode keep the connection alive and wake the Mac when a Slack event arrives. Your laptop still sleeps normally; scheduled jobs catch up on wake.

## Troubleshooting

- **"not_authed" or "invalid_auth"** → token is wrong or missing scope. Re-install app after adding scopes.
- **No reply in Slack** → check terminal. If bot silently ignores you, your user ID isn't in `ALLOWED_USER_IDS`.
- **"dispatch_failed"** → Slack timed out waiting for ack (>3s). Bot is probably hung on a long `claude` call; restart.
- **Bot replies but says "command not found: claude"** → launchd plist (later) needs explicit PATH. For now, the bot inherits your shell's PATH so running via `bun run start` in your terminal works.

## Scheduled runs and iTerm

Scheduled runs are routed through iTerm so macOS TCC attributes them to iTerm (whose binary path is stable) instead of the Claude Code binary (whose path changes on every auto-update). Without this, every Claude Code update would silently revoke Documents/Desktop/network access for scheduled runs.

**One-time setup:**

1. Open iTerm → Settings → Profiles. Duplicate the default profile and name it `Scheduled Agent`.
2. In the `Session` tab of that profile, set **"When command exits" → "Close the window"**. Prevents hidden windows from accumulating after scheduled runs complete.
3. In System Settings → Privacy & Security → Files and Folders, confirm iTerm has access to at least Documents, Desktop, Downloads, and any other folders your scheduled skills touch (e.g. your Obsidian vault).
4. Ensure `caffeinate` is running (see below) so the Mac doesn't sleep through scheduled runs.

**Verifying it works:** run the acceptance test in `docs/superpowers/plans/2026-04-22-slack-agent-reliability-fixes.md` (Task 7 Step 4) after each Claude Code update to confirm scheduled runs still have filesystem access.

## Caffeinate (keep the Mac awake 24/7)

Install the caffeinate LaunchAgent so scheduled runs and Slack messages fire in real time even when the display sleeps:

```bash
cp /Users/javiertamayo/.claude/slack/com.claude.caffeinate.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.caffeinate.plist
```

Verify:

```bash
pmset -g assertions | grep PreventUserIdleSystemSleep
```

Expected: a line attributed to `caffeinate`. If absent, re-run the `bootstrap` command after `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claude.caffeinate.plist`.
