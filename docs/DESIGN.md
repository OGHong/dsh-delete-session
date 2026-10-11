# 设计笔记 · dsh-delete-session

这是**实现细节**，不是使用说明 —— 面向使用者的介绍在 [README](../README.md) /
[README.en.md](../README.en.md)。这里记录的是：为什么按这个顺序删、十四种「静默失败」
各自是怎么被堵上的、目录结构，以及开发与校验方式（写给以后改这个插件的人）。

---
# dsh-delete-session

Delete an archived DeepSeek Harness conversation from its own sidebar menu —
transcript, cached projections, workspace accounting, and all.

## What it adds

One row in a Session's `...` menu: **删除会话 / Delete conversation**. It appears
only while that row is archived, sits after the shipped **取消归档**
(Unarchive) row, and asks for an explicit acknowledgment before anything is
removed.

Confirming deletes the conversation for real:

| trace | where | how it is removed |
|---|---|---|
| archive-set id | `workspace.json` → `global.archivedSessionIds` | `workspaceRegistry.unarchiveSession()` |
| workspace accounting | `workspace.json` → `tables.workspaces[*].sessionIds` | `workspace.detachSession()` |
| session log | `sessions/<projectKey>/<id>/` | `rm -rf`, guarded |
| rewind snapshots | `<dshHome>/rewind-snapshots/<id>/` | `rm -rf`, guarded, when a candidate root holds one |
| projection checkpoint | `storages/session_projcache/sessions/<id>.json` | `table.delete()`, then re-read until it stays gone |
| live registry entry | the running app's memory | the store's own `liveEntryFor` + `detachEntered` |

That last row is not optional, and it is not passive either. `SessionController.list()`
merges the durable index with the **live registry**, so a session still resident
in memory keeps reporting a summary after every file is gone; the sidebar then
draws a row in *Ungrouped* that is no longer archived — so the menu offers no way
to act on it again. That row can be neither opened nor deleted, which is a loop
with no exit short of restarting DSH.

It is also the reason the release runs **before** anything durable is removed.
Releasing a session emits `session/disposed`, and the projection cache answers
that event with an unconditional, fire-and-forget checkpoint — so releasing last
put the projection straight back on disk after it had been deleted. See
[the fourteenth silent failure](#fourteen-ways-this-fails-silently).

Two properties come out of that ordering, and they are the difference between
"the row is gone" and "the deletion was clean":

- **the removal steps report attempts; a closing audit reports facts.** After
  every step, all five traces are re-read once no writer is left. Whatever
  survives is *residue*: it does not un-delete the conversation, but it keeps the
  deletion from being called clean, and the notice names it instead of saying
  "some files".
- **a trace the Host does not own is still the operator's disk.** The rewind
  plugin (`dsh-rewind-plugin`) keeps one snapshot tree per session and prunes it
  by *idle age* — 30 days, and only when its auto-cleanup is on, which it is not
  by default. A conversation deleted today would otherwise keep its snapshots
  indefinitely; the archive entry this was diagnosed against held 6.6 MB of them.

The emptied `<projectKey>` grouping directory is removed too, but only when it is
genuinely empty, so a second conversation in the same workspace is never
disturbed.

This is the per-conversation inverse of `dsh-purge-archived`'s
`/purge-archived`. Both clear the same traces; one acts on a row the
operator pointed at, the other on the whole archive set at once.

## Settings page: archived conversations

**Settings → 归档会话 / Archived** (section id `archived-sessions` — the *shipped*
id, see below — with `order: 45`, so it lands after the shipped sections). The page
is laid out like a product surface rather than a debug list: a title and one-line
description, a tab row whose right end holds the irreversible action (outline, in
the theme's error colour — never a plain button), a search field, and one bordered
card holding the rows or the empty state (a plate with the archive mark over a
two-tone line whose subject takes the brand accent).

**Why the section wears a shipped id.** `settings.section` projects only `id`,
`order` and `label` — there is no icon to pass — and the settings shell picks the
nav glyph from a closed list of ids it knows (`account`, `models`, `agent-presets`,
`plugins`, `archived-sessions`), falling back to its own gear for every other id.
`archived-sessions` is the id that list reserves for exactly this page, so taking it
is what gives the nav row the archive mark instead of a gear, with no DOM patching
of the shell. The trade is deliberate and worth remembering before renaming it: a
private id (this plugin used `dsh-delete-session.archived` before) silently brings
the gear back, and a future DSH that ships its own archived-sessions page would find
this registration sitting in that cell — same id means *replace*, not *appear
beside*. `dsh-market` and `dsh-better-sidebar` take the other route for their own
ids (claim the row after mount and mask a glyph onto it); that machinery is not
needed here, and `selftest.mjs` pins the id so the icon cannot regress by rename.

The search field is sized by one scoped rule rather than a prop, and this is
worth knowing before touching it: the shell's `Input` primitive fixes its wrapper
at **32px** (`.wrap { height: 32px }`) and takes **no** size prop — `style` is
forwarded to the *inner* `<input>` (inside an `inline-flex` wrapper that is sized
by the input's `size` attribute, so it does not even fill the row). `className`
is the only handle on that box, so the field carries `dsh-delete-session-search`
and ships one `height: 36px` / `width: 100%` rule (`!important`, because the
primitive's stylesheet is injected by its own module and document order between
the two is not ours to rely on). 36 is the system's medium control height — the
same as `Button.md` — so the page does not invent a size of its own.

Each row shows the title, when it was last used, its log size, and a warning in
the theme's warn colour when the deletion would refuse it. Row actions appear on
hover and stay put on a ticked row:

| action | what it does |
|---|---|
| **取消归档 / Unarchive** | returns the conversation to the sidebar through the *shipped* workspace controller (`workspaces.unarchiveSession`) — this plugin never edits the archive set itself, and the reversible action asks for no confirmation |
| **删除 / Delete** | the irreversible one, behind the same acknowledgment dialog the sidebar row uses |

Tick boxes (per row and select-all) turn the page into a batch surface: a bar
appears with the count, **取消归档**, **删除选中** and **清除**. Deletion never
happens without the acknowledgment dialog, whatever the entry point — row, bulk
bar, or 全部删除.

Every colour is a shell theme token (`--dsw-alias-state-error-primary`,
`--dsw-alias-label-secondary`, `--dsw-alias-border-l1`, …), so the page follows
light/dark and the app's palette instead of carrying a second hardcoded theme.

**The page keeps itself current.** Archive membership is pushed to every browser
(`workspaces.list` — the same signal that keeps the sidebar's archived view
live), so archiving, restoring or deleting a conversation *from anywhere* — this
page, the sidebar, the row menu, another window — makes the list re-read itself.
Entering the page re-reads it too, which covers what a membership push cannot
report: titles, log sizes and last-used times move while the set stays put.
Refresh remains an escape hatch, not the workflow. The push is coalesced (250 ms)
and only its *content* counts, so an unrelated workspace change — which hands back
a new snapshot carrying the same set — costs no read at all. The subscription is
taken when the page mounts and disposed with it, a pending read included.

The list comes from **the Host**, not from a browser store:

```
GET  /_delete-session/archived     → { ok: true, value: { total, entries: [
                                       { sessionId, title, updatedAt, sizeBytes, running, cwd } ] } }
POST /_delete-session/delete-all   → { ok: true, value: { requested, deleted, refused, failed,
                                       skipped, bytesFreed, residue, clean, removed,
                                       results: [ { sessionId, title, outcome, reason, residue } ] } }
```

Why the Host: the archive set is only authoritative there, a browser holds just
the summaries it happens to have loaded (a conversation archived months ago has
no client-side row at all), and the Host is what decides the deletion anyway — so
what the page lists is exactly what a bulk delete walks. The same route serves
both batch actions: an empty body means "everything archived right now", and a
body with `sessionIds` means "exactly these" — which the Host re-checks against
its archive set, so a row restored in another window between the tick and the
confirm is reported as left alone rather than deleted on the strength of a stale
page. The page can never widen or narrow what "all" means, and it cannot smuggle
in an id: the deletion only ever acts on ids that are *in* the archive set.

Bulk semantics are **skip and report**, never all-or-nothing:

| outcome | when |
|---|---|
| `deleted` | the traces were cleared; `residue` on the result is empty when it was clean |
| `refused` | a turn is running, or running subagents depend on it — nothing was touched |
| `failed` | a step threw; the conversation is left invisible and a re-run finishes it |
| `skipped` | the id was not in the archive set, was malformed, or the run was cancelled |

`clean: false` means at least one conversation was not deleted **or** was deleted
with residue, and the toast says which. Two counters keep the two apart, because
"left in place" and "gone but left bytes behind" are different things to an
operator looking at a full disk:

| counter | meaning |
|---|---|
| `refused` / `skipped` / `failed` | conversations that are **still there** |
| `residue` | conversations that are **gone** but whose audit still found something |

A run that did both reports both. A cancelled run stops immediately (the signal
reaches every step) and reports what it already did.

## Safety

Deletion is irreversible, so the plugin refuses before it removes anything:

- a conversation that is **not archived** is never touched — this action can
  only ever act on rows the archived view is showing;
- a conversation with a **running turn** — an agent mid-step, writing to the
  very log being deleted — or one with **running subagent descendants** is refused,
  whatever the caller asks. A conversation the app merely *holds in memory* is
  **not** refused: that is the normal state of anything you recently used, and
  blocking it made a just-archived conversation impossible to delete without
  restarting the app;
- a session id that is not a plain identifier is refused before it is used to
  build a path, and a log or snapshot directory is removed only when its resolved
  path is strictly inside the expected root and its final segment is exactly the
  name that root uses for that id;
- the route reuses the shipped browser-authentication fence
  (`ctx.connection.admit`), so it is exactly as reachable as `/api` and no more.

A deletion that fails partway still leaves a consistent Host: the session is
unaccounted and unarchived — invisible everywhere — and the leftover bytes are
inert data a later attempt clears. Nothing half-deleted is ever visible, and
nothing half-deleted is called clean either: the closing audit re-reads all five
traces and reports what it found.

## Language

Copy follows **the client's own language setting**, not `navigator.language`:
the dictionaries are registered with the shipped locale registry under the
`dsh-delete-session` namespace, and the components read them through
`locale.bind(NS)` while subscribing to the locale face. Switching the language
in Settings updates the menu row and dialogs immediately, with no reload, and a
browser whose language differs from the chosen one is ignored — which is the
whole point, since those two can disagree.

Both shipped locales carry a dictionary:

| locale | menu row | confirmation |
|---|---|---|
| `zh` | 删除会话 | 永久删除这个会话? |
| `en` | Delete conversation | Delete this conversation permanently? |

A deployment that ships a locale with no dictionary resolves those keys to
themselves rather than failing: registration is per-locale and its failure is
swallowed, because a throw here would fail a client entry, which the renderer
treats as fatal.

## Install

From a checkout, generate `lib/` first (`npm install && npm run build`): the profile
loads `lib/index.js` and `lib/client.js` directly, and those are build output. A
published tarball already carries them.

This package is a **profile bundle**, which is what puts it on the app's
**Settings → Plugins** page. Both halves of that are required, and missing either
one fails quietly:

1. the package declares `dsh.bundle.patch` — without it
   `bundleManifest()` returns `undefined` and the package is not a bundle at all;
2. the profile lists it in `package.json` → `dsh.profile.bundles` — `listBundles()`
   keeps a name only when it is both a declared dependency *and* a bundle, so an
   unselected plain dependency is skipped with no entry and no error.

```json
// the package
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

```json
// the profile's package.json
"dependencies": { "dsh-delete-session": "link:/path/to/plugins/dsh-delete-session" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-delete-session"] } }
```

The page lists it under **已安装 / Installed**, not under **官方 / Official**: that
group is reserved for the plugins DSH itself ships, contributed through the
`plugins.item` slot. A bundle is a bundle whether it came from a registry or a
local `link:`.

Do **not** also add an `- insert:` for the row in the profile's
`cordis.patch.yml` — the bundle's own patch layer inserts it, and a second insert
registers the row twice. To change its configuration, override the declared row by
id instead:

```yaml
- id: delete-session
  name: dsh-delete-session
  config:
    deleteLog: true
```

## Configuration

| field | default | meaning |
|---|---|---|
| `deleteLog` | `true` | Remove each deleted conversation's log directory. Set `false` to keep transcripts while still removing the conversation from the sidebar. |

Override the declared row by id (see [Install](#install)) to change it.

## Why it is built this way

The Host has no session-deletion call at all, and a browser cannot unlink a file,
so the deletion must run on the Host and be reached from the page. Two tempting
mechanisms are deliberately unused, both because a plugin must never be able to
fail the Host composition — the failure mode that crashed this application three
times on 2026-09-29 (`plugins/dsh-purge-archived/INCIDENT.md`):

- **No Typert Remote.** A Remote needs a matching descriptor on both faces, and
  the browser-side descriptor can only come from a *generated* Typert artifact —
  validated at import time, and fatal to the whole Host when malformed. A plain
  JSON route declares no wire schema on either side.
- **No `ctx.connection.rpc.handle()`.** It reads like the intended API, but it
  mounts its route through *Connection's* context
  (`owner.effect(() => owner.webServer.register(route))`), and that context does
  not declare `webServer` — Connection reaches the server through its own
  `ctx.inject(['webServer'], …)` for `/api`. Calling it throws
  `cannot get property "webServer" without inject`, synchronously.

The browser half follows the same rule from the other side: it declares **no
`inject`** and reaches every service through `ctx.get()`, because a client entry
that stays `pending` on a service fails the entire page boot, and it imports only
modules the shell already seeds into the platform module table
(`react`, `react/jsx-runtime`, and the UI primitives), so it bundles no second
copy of anything.

### Fourteen ways this fails silently

Every one of these was found by running the real page, not by reading the code.
Each produces *no* error — the feature simply is not there, and the app looks
perfectly healthy.

1. **`insert` with an `id` is not a label.** In a Cordis patch,
   `- insert: { id: x, … }` appends into the existing *group* entry `x`; when no
   such group exists it warns `patch insert: entry "x" not found` and inserts
   nothing. Adding a top-level row is a bare `- insert:` list, as the bundled
   [`cordis.patch.yml`](cordis.patch.yml) does.
2. **A bare package name must be a declared profile dependency.** A symlink in
   the profile's `node_modules` makes the package's *files* importable
   (`linkedProfileRoots`), but the **name** resolves only when the profile's
   `package.json` lists it — `routeLocalPackage` consults `localPackageNames`. A
   row naming an undeclared package produces no Loader entry at all.
3. **A client half materializes before the services it wants exist.** Reading
   `ctx.get('slots')` during `apply` returns `undefined`, so an eager
   `if (!slots) return` drops the whole feature while the page boots green.
   Registration therefore runs inside `ctx.inject(['slots', 'workspaces'], …)`,
   which fires when the services arrive and disposes with them. The manifest's
   `dsh.client.inject` only orders bundle *arrival*; it does not delay `apply`.
4. **Owner props win the render.** The slot renderer spreads owner props last,
   and this slot's owner supplies its own `t` bound to *its* namespace; copy
   therefore rides the inject face rather than a `t` prop, which arrives as
   `undefined` and throws during render.
5. **Service methods lose their receiver.** `useSyncExternalStore(locale.subscribe,
   locale.getSnapshot, …)` passes the methods themselves, so the locale runtime
   is called with `this === undefined`. Wrap them: `() => locale.getSnapshot()`.
   The row silently disappears rather than erroring.
6. **Adding a service to `ctx.inject` gates the whole registration.** This half
   registers *inside* the deferred callback, so naming a service that a
   composition lacks means the callback never fires and the feature vanishes —
   it does not degrade to "the other two services still work".
7. **A liveness probe can throw for the very session you are cleaning up.**
   `subagents.listDescendants()` reads the session-query index and throws
   `SessionQueryError: session "…" not found` once a conversation's log is gone —
   and a conversation with no log is certainly not running. Letting that escape
   turned "cannot determine descendants" into a hard refusal, so an archive entry
   whose log had already been deleted could never be removed. Each probe is
   therefore isolated and fails *open*: a probe that **reports** activity still
   refuses, but a probe that **cannot answer** is treated as no evidence.
8. **"Resident" is not "working".** The first version refused any conversation
   `sessions.get()` reported, which is the Host's in-memory registry — the normal
   state of anything you have touched in this process. The result was that a
   conversation you had just used and archived could not be deleted at all, with
   the refusal blaming an "open" conversation. Only `Agent.status === 'running'`
   (a turn mid-step) and live subagent descendants block now.
9. **Deleting files cannot evict a session from memory.** The next version
   deleted the archive entry, the accounting slot, the projection and the log —
   and left the session in the live registry, so the Host kept listing it and the
   sidebar showed an undeletable *Ungrouped* row. The deletion now releases the
   registry entry too, through the store's own detach path, and a build without
   that path still deletes while saying that a row may remain.
10. **The browser keeps its own copy of the Session list — and it is not told.**
    This plugin deletes below the controller, so no list frame is ever pushed for
    its deletions; the row would stay on screen after every file was gone, which
    reads as "the deletion did not work" when it did. The first fix called
    `sessions.refreshList()` — a name that does not exist on the client face
    (the real one is `ClientSessions.refresh()`), so the call was a silent no-op
    and the symptom survived. Every mutation now asks for a baseline re-read, the
    selftest counts that it happens, and it asserts the *call* rather than the
    word: the file's own comment explaining the old name would satisfy a
    substring test. A Host that could not release a session reports it as a note,
    so that case now surfaces as a partial result with the reason, instead of a
    green "deleted".

11. **A service read at injection time can stay `undefined` for the life of the
    page.** `ctx.get()` answers `undefined` for a provider that has not activated
    yet — indistinguishable from a misspelled key — so capturing `sessions` when
    this half was injected meant the (now correctly named) list refresh could no-op
    for exactly the same symptom the fix was for. It is looked up per call now, and
    the selftest asserts both halves of that: the name, and that the lookup happens
    at call time.

12. **The eviction is itself a writer, and it fires after the deletion.** The
    shipped order deleted the projection and then released the in-memory session.
    But releasing emits `session/disposed`, and `SessionProjectionCache` answers
    that event with `flushSoft(session, 'detach')` — an unconditional,
    fire-and-forget durable checkpoint. The row went back on disk *after* the step
    that removed it had reported success, so the deletion answered
    `deleted: true, projectionDropped: true, problems: []` while leaving the file
    behind. Measured on a real profile: 45 orphaned projection rows, 4.6 MB, every
    one of them reported as clean. The release now runs first, the drop waits out
    the checkpoint it triggers and re-reads before believing itself, and a closing
    audit re-reads every trace so no future step can lie the same way. The
    selftest fake reproduces the checkpoint (a silent fake cannot fail this way)
    and the case was confirmed to fail against the shipped order before the fix
    was kept.

    The same audit is what surfaced the fifth trace: `dsh-rewind-plugin` keeps
    `rewind-snapshots/<id>/` outside everything the Host owns, and prunes it by
    idle age rather than by existence — 6.6 MB for one archived conversation,
    2.6 MB already orphaned on the same profile.

13. **A durable catalog is not a liveness signal, and the API names do not say
    so.** The subagent check called `subagents.listDescendants()`. That walks the
    parent's persisted **`subagentCatalog` projection** — the history of every
    child the conversation *ever* spawned — so it answers "who did this
    conversation delegate to", never "who is running now". Counting its length
    meant **any conversation that ever used a subagent could never be deleted
    again**: the refusal read `4 running subagents depend on this conversation`
    about four children whose last log write was more than a day earlier, while
    the archived row itself had been idle for hours.

    The liveness source is the **live agent registry**, and the rule is now the
    subagent runtime's own (`runningDescendants` in `dsh-subagent`): an agent
    whose Session header names its parent and carries the `subagent` origin, at
    any depth, with `status === 'running'`. A fork shares the lineage field
    without the origin and never holds its source. The selftest fake keeps
    serving the catalog precisely so the deletion can be asserted to ignore it.

    This one generalizes: `listDescendants` sounds live, and the type this plugin
    declared it with said "every live descendant of one session". Both were
    wrong. When a probe decides whether something is *happening*, read the source
    that only exists while it happens — a registry, not a history.

14. **A clean deletion can still leave the row on screen, because only a
    *resident* session is ever announced.** The browser drops a session row on
    exactly one signal, the `api-session/removed` push, and the Host emits that
    from `session/disposed` **and from nothing else** — so it fires only when a
    session the Host was holding in memory is released. A cold conversation,
    which is the normal state of anything archived and the state of every
    conversation after a restart, is therefore deleted in complete silence: log,
    projection, snapshots, archive entry and accounting slot all gone, `clean:
    true`, `residue: []`, and the row still sitting in the sidebar under
    *Ungrouped*. Diagnosed on a real one — a 10 MB conversation whose deletion
    every trace confirmed, still listed, and confirmed *absent* from the Host's
    own `session.list` while the page kept rendering it.

    The deletion now emits `api-session/removed` itself whenever no disposal
    could have carried it, and says so in a note when the Host cannot emit at
    all. It is the documented, presentation-only event: declared for relay by
    `dsh-api-remotes`, listed in the Host's own API catalog, answered by one
    browser handler that drops the row, and heard by nothing inside the Host.

    Two lessons, both about this plugin's blind spot rather than about DSH. The
    first is that **deleting the data is not the same as deleting the row**:
    three separate caches (the live registry, the projection domain, the
    browser's list) can each keep a conversation visible after its files are
    gone, and the durable traces are the only ones a filesystem check can see.
    The second is that a browser-side refresh is not a substitute for a Host
    signal: the row does disappear when the deletion runs *through the page*,
    because that path re-reads the list — which is exactly why deleting through
    the HTTP route, as a script or another tool would, looked like a failure.

## Layout

| file | role |
|---|---|
| [`src/core.ts`](src/core.ts) | The deletion itself: tracing, guards, per-step report. Transport-free. |
| [`src/index.ts`](src/index.ts) | Host half: the `deleteSession` service and the authenticated route. |
| [`src/client.ts`](src/client.ts) | Browser half: the menu row, the confirmation, and the outcome notice. |
| [`src/types.d.ts`](src/types.d.ts) | The host boundary as local structural types. Type-only: emits nothing. |
| `lib/*.js` | Build output of `npm run build`, and what the profile actually loads. |
| [`selftest.mjs`](selftest.mjs) | 290 checks over the deletion, the archived list and batch, the routes, and the browser half — rendered and driven, not just parsed. |

## Development

`src/` is the only source of truth; `lib/` is generated and never edited by hand.

```bash
npm install         # typescript + @types/node (devDependencies only)
npm run typecheck   # tsc, strict + noUncheckedIndexedAccess, emits nothing
npm run build       # src/*.ts -> lib/*.js (the paths in exports/ and the profile never move)
npm test            # node selftest.mjs
npm run verify      # all three, in that order
```

Two rules this package follows, both from the DSH plugin contract:

- **Nothing from `@deepseek-ai/*` is imported at runtime.** The Host and browser
  contracts this half uses are declared as local structural types in
  [`src/types.d.ts`](src/types.d.ts), so the plugin type-checks without the host
  packages installed and can never bind a second copy of cordis (which is what
  breaks `exec.token` comparison and `instanceof`). There is no bundler at all,
  so nothing can be inlined by accident.
- **The published tarball carries only what is loaded** (`files` → `lib`,
  `cordis.patch.yml`, README, LICENSE). `src/`, `tsconfig*.json`,
  `selftest.mjs`, `node_modules/` and `.dsh-dev/` are outside the whitelist;
  `npm pack --dry-run` is the check.

## Verification

```
npm run verify
```

Besides the 290 checks, two levels beyond the unit suite:

- **Host, over HTTP.** A seeded archived conversation lost its log directory, its
  archive-set id and its accounting slot while a sibling conversation was
  untouched; the Host restarted cleanly afterwards and the state stayed deleted.
  The unauthenticated request answered 401, an unknown endpoint 404, a malformed
  body 400, and a non-archived id a refusal that removed nothing.
- **Browser, through the real UI.** The page was driven in headless Chromium
  against a real Host: the archived view listed the conversation, its `...` menu
  showed `删除会话` after `取消归档`, selecting it raised the acknowledgment
  dialog, and confirming removed the conversation from the sidebar *and* from
  disk, with no page errors. The other bugs above were found at this level.

A regression case is only kept once it has been shown to fail against the code it
replaces. The disposal-checkpoint case was run against the shipped step order —
the projection resurrected itself and the closing audit caught it — and the
selftest's fake Host models that checkpoint for exactly this reason: a fake that
quietly absorbs `session/disposed` cannot fail this way, which is how the bug
survived 250 green checks.
