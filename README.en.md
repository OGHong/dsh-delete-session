**English** | [中文](README.md)

# dsh-delete-session

**Actually delete an archived DeepSeek Harness conversation from its sidebar menu** — transcript,
cached projections, workspace accounting and rewind snapshots included.

## What it adds

- **A "Delete conversation" row in a session's `...` menu**: it only shows up while that session is
  archived, sits after the shipped "Unarchive" row, and asks for an explicit acknowledgment before
  anything is removed;
- **Settings → Archived conversations**: a page listing every archived session with a search field,
  whose right end holds the irreversible action (outlined, in the theme's error colour — never a
  plain button).

Confirming removes all of these traces, and reports any residue by name instead of calling it
"some files":

| Trace | Where |
|---|---|
| archive-set id | `workspace.json` → `global.archivedSessionIds` |
| workspace accounting | `workspace.json` → `tables.workspaces[*].sessionIds` |
| session log | `sessions/<projectKey>/<id>/` |
| rewind snapshots | `<dshHome>/rewind-snapshots/<id>/` |
| projection cache | `storages/session_projcache/sessions/<id>.json` |
| live registry entry | the running app's memory |

The emptied `<projectKey>` grouping directory is removed too — but only when it is genuinely empty,
so a second conversation in the same workspace is never disturbed.

## Requirements

| | |
|---|---|
| OS | macOS / Linux / Windows (pure Node, no platform APIs) |
| Node | 22.6+ (what `engines` declares) |
| DeepSeek Harness | **0.2.0-rc.2 or newer (0.2.x)** — declared in `peerDependencies`; DSH refuses to load it on an incompatible version |
| Dependencies | none at runtime; one peer, `@deepseek-ai/cordis` |

## Install

```bash
git clone https://github.com/OGHong/dsh-delete-session && cd dsh-delete-session
sh scripts/install.sh
```

The script does two things: `npm install && npm run build` (`lib/` is build output and is not in
the repo), and **wires the plugin into your profile** — a `link:` dependency, an entry in
`dsh.profile.bundles`, and the `node_modules` symlink (backing up `package.json` first; a second
run changes nothing).

See what it would do first: `sh scripts/install.sh --dry-run`. Other flag: `--profile=web`.

**Then restart DeepSeek Harness once** — plugin manifests are scanned at startup and a hot reload
will not pick them up.

## Configuration

Override by id in your profile's `cordis.patch.yml`:

```yaml
- id: delete-session
  config:
    deleteLog: false     # default true: remove the transcript on disk as well
```

## Safety

- the row **only appears for archived sessions**: archiving means "I do not want to see it in the
  sidebar", deleting is a different decision, and the two stay separate;
- deleting asks for an explicit acknowledgment, it is not a single click;
- every step is guarded (only the one directory under `<dshHome>` is touched), and the running
  session is **released before** anything durable is removed — the other order writes the
  projection cache straight back to disk;
- a closing audit re-reads every trace and names whatever survived, rather than calling a partial
  deletion clean.

## Implementation notes

Why the order is what it is, the fourteen silent failures it closes, the layout and how to run the
checks all live in **[docs/DESIGN.md](docs/DESIGN.md)** (Chinese).

```bash
npm run verify     # typecheck + build + 292 self-test assertions
```

## License

MIT
