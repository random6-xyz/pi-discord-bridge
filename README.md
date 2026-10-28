# pi-discord-bridge

A Pi extension that bridges a Pi session to Discord. Each Pi session gets its own thread under a parent channel, so you can send instructions from Discord and receive results there.

- **Session-scoped threads** — one parent channel can host many Pi sessions.
- **Immediate input** — while Pi is busy, messages are injected with `steer` right after the current turn.
- **Tools** — `discord_send` for reports and notifications, `discord_ask` for questions that wait for a reply.
- **Slash commands** — run `/session`, `/model`, `/compact`, `/discord-bridge`, and more from Discord.
- **No automatic forwarding** — nothing is sent unless a tool is called explicitly.

## Requirements

- Pi (`@earendil-works/pi-coding-agent`)
- A Discord bot token with the **Message Content Intent**
- Parent channel permissions: View Channel, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads (recommended)
- Development/testing: Node.js 24 or newer (`node --test`)

## Install

### As a Pi package (recommended)

```bash
pi install git:github.com/<github-user>/pi-discord-bridge

# update
pi update --extensions
```

### Clone into the extensions directory

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/<github-user>/pi-discord-bridge \
  ~/.pi/agent/extensions/pi-discord-bridge
```

### Connect the bridge

```bash
export DISCORD_BOT_TOKEN="..."

cp discord-bridge.example.json ~/.pi/agent/discord-bridge.json
# Fill in discord.channelId and discord.allowedUserIds.
```

In Pi, reload and enable the bridge:

```text
/reload
/discord-bridge on
```

Each machine should use its own parent channel. The same bot token can be reused across servers, and every Pi process opens one gateway connection.

## Discord bot setup

1. Discord Developer Portal → Bot → enable **Message Content Intent**.
2. Invite the bot to the server and grant the parent channel permissions listed above.
3. The gateway uses the `GUILDS`, `GUILD_MESSAGES`, and `MESSAGE_CONTENT` intents.

## Configuration

The default config path is `~/.pi/agent/discord-bridge.json`. Override it with `PI_CODING_AGENT_DIR` or `PI_DISCORD_BRIDGE_CONFIG`. Start from `discord-bridge.example.json` in this repository.

```json
{
  "discord": {
    "enabled": false,
    "mode": "thread",
    "channelId": "123456789012345678",
    "allowedUserIds": ["111111111111111111"],
    "askTimeoutMs": 900000,
    "threadAutoArchiveMinutes": 10080,
    "mentionOnAsk": false
  },
  "reporting": { "autoReport": false },
  "input": { "queueWhenBusy": true, "delivery": "steer" }
}
```

| Key | Default | Description |
| --- | --- | --- |
| `discord.enabled` | `false` | Whether the bridge is enabled. `/discord-bridge on\|off` persists this value. |
| `discord.mode` | `"thread"` | `"thread"`: create a thread per session (recommended). `"channel"`: one session uses one channel directly. |
| `discord.channelId` | required | Parent channel ID. In `channel` mode this is the conversation channel. |
| `discord.threadName` | session/folder name | Base name for session threads. |
| `discord.threadAutoArchiveMinutes` | `10080` | Thread auto-archive time. One of `60`, `1440`, `4320`, `10080`. |
| `discord.allowedUserIds` | required | Discord user IDs allowed to send messages, answers, and commands. |
| `discord.askTimeoutMs` | `900000` | Default `discord_ask` timeout in ms. Capped at 24 hours. |
| `discord.mentionOnAsk` | `false` | Mention the first allowed user when asking a question. |
| `reporting.autoReport` | `false` | Not supported in v0.1. Always `false`. |
| `input.queueWhenBusy` | `true` | When `false`, reject input while Pi is busy. |
| `input.delivery` | `"steer"` | `"steer"`: inject right after the current turn. `"followUp"`: process after the run finishes. |

The bot token is never stored in the config file. Use an environment variable:

```bash
export DISCORD_BOT_TOKEN="..."
```

Environment overrides:

| Variable | Description |
| --- | --- |
| `DISCORD_BOT_TOKEN` / `PI_DISCORD_BOT_TOKEN` | Bot token (required) |
| `DISCORD_CHANNEL_ID` | Parent channel ID |
| `DISCORD_MODE` | `thread` or `channel` |
| `DISCORD_THREAD_NAME` | Base thread name |
| `DISCORD_THREAD_AUTO_ARCHIVE_MINUTES` | Thread auto-archive time |
| `DISCORD_ALLOWED_USER_IDS` | Comma-separated user IDs |
| `DISCORD_QUEUE_WHEN_BUSY` | `true`/`false` |
| `DISCORD_DELIVERY` | `steer`/`followUp` |
| `DISCORD_ASK_TIMEOUT_MS` | Question timeout |
| `DISCORD_MENTION_ON_ASK` | `true`/`false` |
| `PI_DISCORD_BRIDGE_CONFIG` | Alternate config file path |
| `PI_DISCORD_BRIDGE_ALLOW_HEADLESS` | `1` also starts the bridge in one-shot modes |
| `PI_DISCORD_BRIDGE_DEBUG` | `1` logs gateway details to stderr |

## Usage

### Pi commands

| Command | Description |
| --- | --- |
| `/discord-bridge status` | Connection state, parent channel, session thread, pending question, last error |
| `/discord-bridge on` / `off` | Enable/disable the bridge (persisted to the config file) |
| `/discord-bridge reconnect` | Reconnect the gateway. In thread mode the thread is re-checked too |
| `/discord-bridge delete` | Delete the current session thread and its messages, then disconnect |
| `/discord-bridge test` | Send a test message to the session thread |
| `/discord-bridge send <message>` | Send a message from the Pi UI to the session thread |
| `/discord-bridge help` | Show command help |

`off` keeps the thread. Running `on` again reuses it. `delete` removes the current session thread and all of its messages, persists `enabled: false`, requires the **Manage Threads** permission, and asks for confirmation. It cannot be run from Discord; use the local terminal.

### Discord slash commands

Discord messages that start with `/` are treated as commands when the name is recognized. They run without the `[Discord:user]` prefix and reply in Discord. Text that is not a command, such as `/tmp/file is broken`, is forwarded to Pi like any other message.

| Command | Description |
| --- | --- |
| `/help` | List available commands |
| `/session` | Session name/ID, cwd, model, thinking level, context usage, thread link |
| `/name <name>` | Rename the session |
| `/compact [instructions]` | Compact the context manually (aborts in-flight work) |
| `/model [provider/id]` | Show or change the model. Reports when credentials are missing |
| `/thinking [level]` | Show or change the thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `/stop`, `/abort` | Abort the current work |
| `/discord-bridge <command>` | Bridge status/control. `delete` is local-only |

Extension commands (`pi.registerCommand`), prompt templates, and skill commands (`/skill:name`) also run. Their output is shown in the local Pi terminal; Discord only receives an execution acknowledgement.

Pi built-ins that require the local terminal are refused from Discord: `settings`, `tree`, `scoped-models`, `export`, `import`, `share`, `bug`, `copy`, `changelog`, `hotkeys`, `fork`, `clone`, `trust`, `login`, `logout`, `new`, `resume`, `reload`, `quit`. Unknown commands are also rejected instead of being forwarded to the model.

### Tools

| Tool | Purpose |
| --- | --- |
| `discord_send` | Send a report or notification. Use only when explicitly requested. |
| `discord_ask` | Ask a question and wait for a reply. Only one question can be pending. |

```text
discord_send({ message: "Tests passed. Should I deploy?" })
discord_ask({ question: "Run the database migration?" })
```

`discord_ask` rules:

- The question is posted in the session thread; reply to it or post a regular message.
- The default timeout is 15 minutes. Timeouts, aborts, and bridge shutdowns end the tool with an error.
- While a question is pending, incoming messages are treated as the answer, not as new instructions. Recognized slash commands still execute as commands.

## How it works

Each machine uses one parent channel, and every Pi session gets a thread under it.

```text
#server-a                       ← parent channel for server A
  ├─ api [1a2b3c4d]             ← Pi session 1
  ├─ web [5e6f7a8b]             ← Pi session 2
  └─ batch [9c0d1e2f]           ← Pi session 3

#server-b                       ← parent channel for server B
  └─ worker [3f4a5b6c]          ← Pi session on server B
```

- Messages in the parent channel are ignored; only the current session thread is handled. Bot, webhook, and non-allowed user messages are ignored too.
- Thread names are derived from the Pi session name, project folder, and part of the session ID.
- Resuming a session reuses its thread; forked or `/new` sessions create a new thread.
- Auto-archived threads are reopened before sending. If a stored thread was deleted, the bridge looks for one with the same name and creates a new one when needed.
- The session/thread binding is stored as a custom entry in the Pi session.
- Busy input is delivered with `steer`, right after the current turn. If a run is starting or compaction is in progress, delivery is held briefly and retried.
- Two Pi processes cannot open the same session at once; a lock prevents it. The lock is per session in thread mode and per channel in channel mode.
- Attachments and images are not forwarded in v0.1.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| 401 | `DISCORD_BOT_TOKEN` is a bot token |
| 403 | Channel/thread permissions (View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Manage Threads) |
| 404 | `channelId` and whether the bot has joined the server |
| Messages ignored | `discord.allowedUserIds`, and whether the message is in the current session thread |
| Not connecting | `enabled`, the `discord-bridge.json` path, and `/discord-bridge status`. One-shot modes (`print`/`json`) are disabled by default |
| Lock error | Another Pi process is already using the same session |

Set `PI_DISCORD_BRIDGE_DEBUG=1` for detailed logs. Initial connection failures are retried automatically.

## Out of scope (v0.1)

Multi-channel routing hubs, live terminal streaming, file attachments, voice, web dashboards, scheduled reports, and session-replacement/TUI-picker built-ins (`/new`, `/reload`, `/resume`, and similar) are not supported.

## Development

```text
index.ts          entry (tools, commands, event wiring)
src/bridge.ts     session/thread binding, message delivery, command handling
src/commands.ts   slash command parsing and metadata
src/config.ts     config loading/saving
src/gateway.ts    Discord gateway (WebSocket)
src/rest.ts       Discord REST
src/lock.ts       session/channel lock
src/text.ts       message splitting and summaries
tests/            node:test suites
```

```bash
npm test          # node --test tests/*.test.ts
```

## License

[Apache License 2.0](LICENSE)
