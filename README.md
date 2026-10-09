# Oh My Pi Web

A local web UI for [Oh My Pi (omp)](https://github.com/canmi/oh-my-pi), targeting omp 18.8.x. Listens on `127.0.0.1` only.

A Bun gateway spawns one `omp --mode rpc-ui` child process per opened session and streams protocol frames over WebSocket; a Vite + React client renders the conversation. No component library — hand-written CSS with light/dark themes.

## Features

| Area | What you get |
| --- | --- |
| Sidebar | Sessions grouped by project, searchable; a visibility filter (all / hand-picked / recently active); per-session menu with rename, HTML export, archive, fork |
| Home | Project and model pickers (remembered across sessions); the omp process starts only when the first message is sent |
| Chat | Streaming replies, collapsible thinking, compact tool rows with inline errors, per-turn "processed · time" summary, file-change cards with diffs, fork from any turn, image attachments (paste, drag, picker), slash-command menu, `@` file completion |
| Interaction | Approval / select / input / editor / multi-question `ask` cards; reconnect card when the session process exits |
| Right panel | Info (todos, context usage, session), subagents (live progress, transcript, steer, stop), files (tree + preview), changes (git status + diff) |
| Settings | General (theme, fonts, column width, notifications, Enter behavior), providers (add/edit/remove OpenAI-compatible endpoints, hide models), archived sessions (restore, permanent delete), about |

Sessions get an automatic title after the first exchange (one extra model call, `OMP_WEB_AUTO_TITLE=0` to disable).

## Getting started

```sh
bun install
bun run build
bun run scripts/serve.ts            # http://127.0.0.1:30190 — your real ~/.omp/agent
bun run scripts/serve.ts --test     # http://127.0.0.1:30191 — isolated test profile
```

`bun run scripts/serve.ts --test` seeds an isolated profile (`.data/omp-agent`) with an example provider and model — edit `models.yml` there (or in Settings → 模型供应商) and point it at your own endpoint. The API key can be an environment variable name.

For convenience, put a shim somewhere on `PATH` that runs `bun run scripts/launch.ts`: `ompweb` opens the page if the server is already running, otherwise builds the frontend when stale, starts the gateway in the foreground, and opens the browser. `ompweb --restart` stops a running server first (needed after `server/` changes); `--test` and `--no-open` are also supported.

## Checks

```sh
bunx tsc --noEmit -p tsconfig.json   # types
bun test                             # unit tests (pure view-model logic)
bun run build                        # production bundle
```

## Layout

| Path | Purpose |
| --- | --- |
| `server/main.ts` | HTTP `/api/*` + WebSocket `/ws`: session index, rename, export, archive, delete, about, reveal |
| `server/omp-process.ts` | One `omp --mode rpc-ui` child: JSONL framing, v2 chunk reassembly, request/response correlation |
| `server/session-hub.ts` | Live sessions: message mirror + in-flight replay, dialogs, command list, subagents, rename, rekey |
| `server/session-index.ts` | Head/tail parsing of OMP session files for the sidebar index |
| `server/archive.ts` | Web-only archive list (`<dataDir>/archived.json`; hides, never touches files) |
| `server/files.ts` | File tree, previews, git status and diff for the right panel (confined to the project dir) |
| `server/providers.ts` | Surgical `models.yml` editing for the provider settings page (block rewrite + backup) |
| `shared/rpc-wire.ts` | Wire types copied from omp 18.8.6 sources (regenerate when upgrading omp) |
| `shared/subagents.ts` | Subagent lifecycle/progress frame folding, shared by gateway and browser |
| `web/src/lib/session-store.ts` | Framework-free session state; streams merge per frame |
| `web/src/lib/app-store.ts` | Routing, preferences, session index, archive, settings, notices |
| `web/src/lib/turns.ts` | Messages → turns / steps / tool labels / file changes / durations |
| `web/src/components/` | Sidebar, home, chat, composer, model menu, approvals, right panel (`AgentsPanel`), settings (`SettingsDialog`) |

## Data locations

| Path | Contents |
| --- | --- |
| `~/.omp/agent` (test: `.data/omp-agent`) | OMP's own config and sessions; the web app only reads and writes session names, and only permanent delete removes a session file |
| `.data/web` (test: `.data/web-test`) | Project pins, archive list, exported HTML |

## License

MIT
