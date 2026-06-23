# apple-mcp (Faces fork)

An MCP server that lets an agent work with five native macOS apps:

| Tool        | Operations |
|-------------|------------|
| `contacts`  | look up phone numbers / names (phones **and** emails) |
| `messages`  | send, read, schedule, list unread (iMessage, via `chat.db` + AppleScript) |
| `notes`     | list, search, create |
| `reminders` | list, search, open, create, list-by-id |
| `calendar`  | list, search, open, create |

This is **Faces'** fork of the (now-archived) [`supermemoryai/apple-mcp`](https://github.com/supermemoryai/apple-mcp).
Faced bundles it and runs it under its own Node runtime. It is a substantial rewrite — not a config tweak:

- **JXA, not AppleScript-string-building.** Every app is driven through `@jxa/run`, which returns real
  JS objects (the upstream modules treated AppleScript's *string* return as an array, so list/search
  silently returned nothing — and several functions were outright stubs). All user input is passed as
  **arguments** to the JXA script, never spliced into source, so there is no script-injection surface.
- **Honest permission errors** (denied ≠ empty ≠ broke). A TCC denial throws a typed `PermissionError`
  that the dispatcher surfaces with `isError: true` — it never masquerades as "you have no data."
- **Correct international phone handling** via `libphonenumber-js` (no hardcoded `+1`); iMessage
  **email handles** are matched as emails, not phones.
- **`sqlite3` via `execFile`** (argv, no shell) for Messages history — no shell-injection surface.
- **Per-app filtering** (see below) so the host can expose exactly the apps the user enabled.
- Builds to a single self-contained `dist/index.js` with **esbuild** (Node, no Bun).

`mail`, `maps`, and `web-search` from upstream were removed — see [`ROADMAP.md`](./ROADMAP.md).

## Configuration (env)

- `APPLE_MCP_ENABLED_APPS` — comma-separated tool names to expose, e.g.
  `messages,contacts,notes,reminders,calendar`. Gates **both** the advertised tool list and the call
  dispatch. Unset ⇒ all tools; empty ⇒ none.
- `APPLE_REGION` — ISO-3166-1 alpha-2 region (e.g. `US`, `IT`, `GB`) used to parse **bare** local
  phone numbers. Numbers already in `+CC…` form ignore it. Defaults to `US`.

## Permissions (macOS TCC)

The app embedding this server is the responsible process, so **its** `Info.plist` must carry the
usage strings and the user grants access to **it**:

- Contacts / Notes / Reminders / Calendar / sending Messages → **Automation** (`NSAppleEventsUsageDescription`).
- Reading Messages history (`~/Library/Messages/chat.db`) → **Full Disk Access**.

## Build

```sh
npm install      # also builds via the `prepare` script
npm run build    # esbuild → dist/index.js (self-contained)
npm start        # node dist/index.js
npm run typecheck
```

Licensed MIT (see [`LICENSE`](./LICENSE)); fork retains upstream attribution.
