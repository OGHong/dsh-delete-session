**English** | [中文](README.md)

# dsh-delete-session

**Actually delete a DeepSeek Harness conversation from its sidebar menu** — archived or not —
transcript, cached projections, workspace accounting and rewind snapshots included.

## What it adds

- **A "Delete conversation" row in every session's `...` menu** — archived or not, no archive step
  required first. It sits after the shipped "Archive"/"Unarchive" row (on 0.2.2 that takes a
  declarative context-menu action — see below), and asks for an explicit acknowledgement before
  anything is removed;
- **Settings → Archived conversations**: a page listing every archived session with a search field,
  whose right end holds the irreversible action (outlined, in the theme's error colour — never a
  plain button).

Deletion is no longer hidden behind archiving: archiving is "do not show it to me", deletion is
"it is gone", and they are different decisions. The menu offers deletion directly because the row
you are actually looking at is the one you most often want gone.

## Where that row sits since 0.2.2

0.2.2 moved Session menus onto the context-menu system, and the popup has a fixed three-part order:

```
declarative actions (items) → component rows (contextMenu.content) → footer actions (afterContent)
```

The shipped 归档会话 / Archive action is a footer action at order 600, and the "register a React row"
mechanism this package used on 0.2.1 belongs to the middle part — a component row renders before
every footer action no matter what order it asks for. On 0.2.2 the row therefore appeared *before*
Archive, the opposite of what this document promises.

It is now registered as a declarative action: `afterContent: true` with `order: 700`, which lands it
after Archive. A composition without the `contextMenus` service (an older DSH, or a profile that
drops the context-menu package) still gets the original component row — the plugin waits for that
service, uses the declarative action when it arrives, and renders the component row empty — so
either composition shows exactly one row.

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
| DeepSeek Harness | **0.2.2-rc.3 or newer (0.2.x)** — declared in `engines.dsh` and `peerDependencies`; DSH refuses to load it on an incompatible version |
| Dependencies | none at runtime; the peers are `@deepseek-ai/cordis ~4.1` (DSH ships cordis 4.1.0 since 0.2.2) and DSH's own client packages — all platform-provided, never bundled |

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

- the row **appears on every session**. What guards it now is the Host: a conversation with a
  running turn, or with running subagent descendants, is refused with the reason stated; so is an id
  the Host cannot name at all — not in the archive set, the live registry, the session backend, any
  workspace record, or on disk as a log directory — so the route never answers `deleted: true` about
  a row that does not exist;
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
npm run verify     # typecheck + build + 355 self-test assertions
```

## License

MIT
