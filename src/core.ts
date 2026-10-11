/**
 * The deletion itself, independent of any transport.
 *
 * Archiving in DSH only adds a session id to the registry-global
 * `global.archivedSessionIds` set of the `workspace` domain and deliberately
 * leaves the workspace accounting slot alone, so unarchiving can restore the
 * session to its original position. Deleting has to undo all five traces an
 * archived session leaves behind:
 *
 *   1. its workspace accounting slots (`tables.workspaces[*].sessionIds`), which
 *      archiving intentionally preserved;
 *   2. its id in the archive set, through the registry's own serialized,
 *      durable-then-cache write path (`unarchiveSession`), because
 *      `WorkspaceRegistry` caches its state in memory: editing the domain
 *      behind its back would let the next `archiveSession` rebuild the archive
 *      set from the stale copy;
 *   3. its log directory under the JSONL root, which is the transcript itself;
 *   4. its snapshot directory under the rewind plugin's root, which that plugin
 *      prunes by idle age rather than by existence, so a conversation deleted
 *      today would keep its snapshots for as long as its cleanup is off;
 *   5. its persisted projection checkpoint, so no listing or search projection
 *      can resurrect a row for a session that is gone.
 *
 * The Host exposes no session-deletion call at all — `SessionPersistence` is
 * append-only by contract, `SessionProjectionCache` has no eviction, and the
 * JSONL backend has no removal — so steps 1 and 2 go through the public
 * registry and steps 3-5 through the filesystem and the open storage domain.
 *
 * Two ordering rules are what make the result actually clean, and both were
 * learned from residue found on a real profile:
 *
 *   - **The in-memory session is released before anything durable is removed.**
 *     The release is not a passive bookkeeping step: it emits
 *     `session/disposed`, and the projection cache answers that event with an
 *     unconditional durable checkpoint. Releasing last — after the projection
 *     had been deleted — put the checkpoint straight back on disk, which is
 *     what left 45 orphaned projection rows on the profile this was diagnosed
 *     against.
 *   - **The removal steps report attempts; a closing audit reports facts.**
 *     Every step below is best effort, and the residue check at the end re-reads
 *     all five traces after the last writer has stopped, because a
 *     fire-and-forget write (the disposal checkpoint above) can land after the
 *     delete that was supposed to remove its row. Only the audit may call a
 *     deletion clean.
 *
 * A partial failure leaves the session invisible (unaccounted and unarchived)
 * with inert bytes on disk, which a re-run finishes clearing.
 * @module dsh-delete-session/core
 */
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { Dirent } from 'node:fs'

import type {
	Agent,
	ArchivedEntry,
	ArchivedOutcome,
	ArchivedDeleteSummary,
	DeleteArchivedOptions,
	DeleteOptions,
	DeleteReport,
	HostServices,
	ListArchivedOptions,
	ServiceContext,
	StorageTable,
	WorkspaceEntity,
	WorkspaceRegistry
} from './types.js'

/** Domain opened by `dsh-workspace`; holds the archive set and workspace records. */
export const WORKSPACE_DOMAIN = 'workspace'
/** Domain opened by `dsh-session-projection-cache`; one checkpoint per session. */
export const PROJECTION_DOMAIN = 'session_projcache'
/** Directory `dsh-rewind-plugin` keeps one snapshot tree per session under. */
export const REWIND_DIR = 'rewind-snapshots'
/**
 * Environment override the rewind plugin honours for its snapshot root.
 *
 * Read here rather than assumed, because a deployment that moves the root would
 * otherwise leave every conversation's snapshots behind while this plugin
 * reported the deletion clean.
 */
export const REWIND_ROOT_ENV = 'DSH_REWIND_SNAPSHOT_DIR'
/** Environment override for the harness home, as the Host resolves it. */
export const HARNESS_HOME_ENV = 'DSH_HOME'
/** The default harness home directory name under the OS home. */
export const HARNESS_HOME_DIR = '.dsh'
/** How many times the projection drop re-deletes before it calls a row stubborn. */
export const PROJECTION_DROP_ATTEMPTS = 3
/**
 * Bounded settle window for the disposal checkpoint.
 *
 * `SessionProjectionCache.installWritePath()` answers `session/disposed` with
 * `flushSoft(…, 'detach')`, a fire-and-forget durable write, so the row must be
 * given a moment to land before it is deleted — otherwise the delete wins the
 * race and the checkpoint re-creates the row immediately afterwards. Paid only
 * when the eviction actually announced a disposal.
 */
export const PROJECTION_SETTLE_MS = 40
/**
 * The Host event that tells every connected browser a row left the list.
 *
 * Documented in the Host's own API catalog as "A Session left the live Host
 * registry", declared for relay by `dsh-api-remotes`, and answered on the
 * browser by exactly one handler, which drops that row. Nothing inside the Host
 * listens to it, so emitting it is a presentation signal and nothing else.
 */
export const SESSION_REMOVED_EVENT = 'api-session/removed'
/** The residue line for an archive id that survived, which un-does the deletion itself. */
const RESIDUE_ARCHIVE = 'its id is still in the archive set'

/** One-line rendering of an unknown thrown value. */
export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Read one service without declaring it.
 *
 * The Host plugin declares only `connection` and `webServer`, so a service it
 * merely consumes at call time must be read through `ctx.get()`; touching
 * `ctx.workspaceRegistry` directly trips Cordis's "cannot get property … without
 * inject" guard instead of degrading. A missing registry is a real deployment
 * error here — the archive set cannot be edited at all — so it is reported as
 * one rather than silently skipped.
 * @param ctx - Host context.
 * @param key - Service key.
 * @param subject - What the caller needs it for, for the error message.
 * @returns The service.
 * @throws {Error} when the service is unavailable.
 */
export function requireService<K extends keyof HostServices>(ctx: ServiceContext, key: K, subject: string): HostServices[K] {
	const service = ctx.get(key)
	if (service === undefined) throw new Error(`${subject} needs the '${key}' service, which this Host does not provide`)
	return service
}

/**
 * Whether a session id is a plain non-empty string.
 *
 * The id crosses the wire from the browser, so it is validated before it is
 * used to build a path: `rm` against a computed directory must never run on a
 * value that could traverse out of the session root.
 * @param value - Candidate id.
 * @returns Whether the value can be used as a session id.
 */
export function isSessionId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('/') && !value.includes('\\') && !value.includes('\0') && value !== '.' && value !== '..'
}

/**
 * The answer of one liveness probe.
 *
 * `ok` is false only when the probe itself threw. A probe that *reports*
 * activity refuses the deletion; a probe that cannot answer at all is no
 * evidence of activity.
 */
interface Probe<T> {
	readonly ok: boolean
	readonly value: T | undefined
}

/**
 * Whether this session is *working*, and must not be deleted.
 *
 * "Resident" and "working" are different states, and only the second is a
 * reason to refuse:
 *
 *   - a session merely held in the Host's in-memory registry — which is what
 *     `sessions.get()` tests — is the normal state of a conversation the running
 *     app has touched. Refusing those made the feature useless for the common
 *     case: a conversation you just used and then archived could never be
 *     deleted without restarting the app.
 *   - an agent that is actually `running` is mid-turn and writing to the log
 *     being deleted; that is refused. `Agent.status` is `'idle' | 'running'`, and
 *     an idle resident agent is not writing anything.
 *
 * Each probe is isolated and fails *open*: a probe that *reports* activity still
 * refuses, but a probe that cannot answer is treated as no evidence of activity.
 * That is what keeps a broken index or a partly composed deployment from turning
 * "cannot determine" into a refusal that nothing can clear.
 * @param ctx - Host context.
 * @param sessionId - Session being considered.
 * @returns A human-readable reason to refuse, or undefined when deletion may proceed.
 */
export async function liveBlocker(ctx: ServiceContext, sessionId: string): Promise<string | undefined> {
	const probe = async <T>(run: () => T | Promise<T>): Promise<Probe<T>> => {
		try {
			return { ok: true, value: await run() }
		} catch {
			return { ok: false, value: undefined }
		}
	}

	const agent = await probe(() => ctx.get('agents')?.get(sessionId))
	if (agent.ok && agent.value?.status === 'running') return 'a turn is running in this conversation'

	const descendants = await probe(() => runningDescendants(ctx, sessionId))
	if (descendants.ok && (descendants.value?.length ?? 0) > 0) {
		// The guard above is what proves a value arrived, `noUncheckedIndexedAccess`
		// does not: `value` is typed as possibly absent, as it is for every probe.
		const count = descendants.value!.length
		return `${String(count)} running subagent${count === 1 ? '' : 's'} depend on this conversation`
	}
	return undefined
}

/**
 * The subagent descendants of one conversation that are actually running.
 *
 * Two APIs answer questions that look alike and are not, and picking the wrong
 * one made whole conversations undeletable:
 *
 *   - `subagents.listDescendants()` walks the parent's **durable
 *     `subagentCatalog` projection** — the history of every child the
 *     conversation ever spawned. A child that finished a day ago is still in it,
 *     so counting its length refuses the deletion forever. Measured on the
 *     profile this was diagnosed against: four children whose last log write was
 *     more than a day old, and the archived row still answered `running: true`,
 *     with the refusal blaming "4 live subagents".
 *   - a **live agent** is the only thing that can be running, because a turn
 *     needs one. So the registry is the liveness source, and the definition is
 *     the subagent runtime's own (`runningDescendants` in `dsh-subagent`): an
 *     agent whose Session header names its parent and carries the subagent
 *     origin, at any depth, with `status === 'running'`. A fork shares the
 *     lineage field without the origin and is an independent conversation, so it
 *     never holds its source.
 *
 * Reading lineage as data also means a header chain that loops is visited once
 * rather than walked forever.
 * @param ctx - Host context.
 * @param rootSessionId - The conversation being considered.
 * @returns The running descendants, in traversal order.
 */
export function runningDescendants(ctx: ServiceContext, rootSessionId: string): Agent[] {
	const childrenOf = new Map<string, Agent[]>()
	for (const agent of ctx.get('agents')?.list?.() ?? []) {
		const header = agent.session?.header
		const parentSession = header?.parentSession
		if (parentSession === undefined || header?.origin !== 'subagent') continue
		const siblings = childrenOf.get(parentSession) ?? []
		siblings.push(agent)
		childrenOf.set(parentSession, siblings)
	}

	const running: Agent[] = []
	const pending = [rootSessionId]
	const visited = new Set<string>()
	while (pending.length > 0) {
		const parentId = pending.shift()
		if (parentId === undefined || visited.has(parentId)) continue
		visited.add(parentId)
		for (const child of childrenOf.get(parentId) ?? []) {
			if (child.status === 'running') running.push(child)
			const childId = child.session?.header?.id ?? child.id
			if (childId !== undefined) pending.push(childId)
		}
	}
	return running
}

/**
 * Whether the running app still holds this session in memory.
 *
 * Deleting files cannot evict an in-memory session, so this is the state that
 * produces a leftover row; see {@link evictResident}. It is also what decides
 * whether the browser has to be told anything: releasing a resident session
 * emits `session/disposed`, and the Host pushes {@link SESSION_REMOVED_EVENT}
 * from that event alone.
 * @param ctx - Host context.
 * @param sessionId - Session being considered.
 * @returns Whether the Host has the session resident.
 */
export function isResident(ctx: ServiceContext, sessionId: string): boolean {
	try {
		return ctx.get('sessions')?.get(sessionId) !== undefined
	} catch {
		return false
	}
}

/**
 * Tell every connected browser that one row left the list.
 *
 * The Host pushes `api-session/removed` from `session/disposed` and from nothing
 * else, and only a **resident** session is ever disposed. A cold conversation —
 * which is the normal state of anything archived, and the state of every session
 * after a restart — therefore has its files deleted without a single word to the
 * browser, and the row stays on screen until the next reconnect re-reads the
 * list. That reads as "the deletion did not work" while every trace is already
 * gone; it is how an otherwise clean deletion of a 10 MB conversation left a
 * phantom row under *Ungrouped* in the sidebar.
 *
 * The event is the documented, presentation-only one (see
 * {@link SESSION_REMOVED_EVENT}), and it is emitted here only when no disposal
 * could have carried it — never for a session the Host still holds, whose row is
 * real and would simply return on the next read.
 * @param ctx - Host context.
 * @param sessionId - The session that was deleted.
 * @returns Whether the event could be emitted at all.
 */
export function emitSessionRemoved(ctx: ServiceContext, sessionId: string): boolean {
	if (typeof ctx.emit !== 'function') return false
	try {
		ctx.emit(SESSION_REMOVED_EVENT, sessionId)
		return true
	} catch {
		return false
	}
}

/**
 * Release a resident session from the Host's live registry.
 *
 * This is the step that actually makes a deleted conversation leave the sidebar.
 * `SessionController.list()` merges the durable index with the **live registry**,
 * so a session still resident in memory keeps reporting a summary even after its
 * log, projection and archive entry are gone. The client renders that summary,
 * the row is no longer archived, and the menu therefore offers no way to act on
 * it again — a row that can be neither opened nor deleted.
 *
 * The store exposes no `release()`/`detach()` of its own: `enter()` returns the
 * one single-shot detach capability, and it belongs to whoever created the
 * session (the agent-loop factory), whose own teardown handle is not public. The
 * supported equivalent is therefore the store's own detach path —
 * `liveEntryFor()` then `detachEntered()` — which is exactly what that disposer
 * calls: it removes the store entry, drops the attachment, and emits
 * `session/disposed` once, so every observer sees a normal teardown.
 *
 * Both are guarded and optional, and this never throws: eviction is a
 * presentation fix, so failing it must degrade to "a stale row may remain"
 * rather than to a failed deletion. Callers must already have established that
 * the session is idle with no live descendants.
 * @param ctx - Host context.
 * @param sessionId - The session to release.
 * @returns `released`, `unsupported`, or `failed`.
 */
export function evictResident(ctx: ServiceContext, sessionId: string): 'released' | 'unsupported' | 'failed' {
	try {
		const sessions = ctx.get('sessions')
		const session = sessions?.get?.(sessionId)
		if (session === undefined) return 'released'
		if (typeof sessions?.liveEntryFor !== 'function' || typeof sessions.detachEntered !== 'function') return 'unsupported'
		const entry = sessions.liveEntryFor(session)
		if (entry === undefined) return 'released'
		sessions.detachEntered(entry)
		return sessions.get(sessionId) === undefined ? 'released' : 'failed'
	} catch {
		return 'failed'
	}
}

/**
 * Every workspace that durably accounts for `sessionId`.
 *
 * The public `Workspace.sessionIds` getter filters against the live header
 * index, which hides exactly the residue deletion targets: a record still naming
 * a session whose header no longer resolves. The durable table is read instead
 * so those stale slots are cleared too, falling back to the public projection
 * only when the domain is not open.
 * @param ctx - Host context.
 * @param sessionId - The session to locate.
 * @returns The owning workspace entities.
 */
export function accountingWorkspaces(ctx: ServiceContext, sessionId: string): WorkspaceEntity[] {
	const registry = requireService(ctx, 'workspaceRegistry', 'reading the workspace accounting')
	const table = ctx.get('storageDomain')?.get(WORKSPACE_DOMAIN)?.table('workspaces')
	const owning: string[] = []
	if (table) {
		for (const [workspaceId, record] of table.entries()) {
			if (record.sessionIds.includes(sessionId)) owning.push(workspaceId)
		}
	} else {
		for (const workspace of registry.list()) {
			if (workspace.sessionIds.includes(sessionId)) owning.push(workspace.id)
		}
	}
	const entities: WorkspaceEntity[] = []
	for (const workspaceId of owning) {
		const workspace = registry.get(workspaceId)
		if (workspace) entities.push(workspace)
	}
	return entities
}

/**
 * Remove one session from every durable trace the Host owns: its workspace
 * accounting slots and its archive-set id.
 *
 * Detach runs first. If the process dies between the two calls the session is
 * unaccounted but still archived — invisible either way, and a re-run finishes
 * the job. The reverse order would leave an unarchived session with an intact
 * log, which reappears in the sidebar as a normal conversation.
 * @param ctx - Host context.
 * @param sessionId - The archived session being deleted.
 * @returns How many workspace slots were released.
 */
export async function unregisterSession(ctx: ServiceContext, sessionId: string): Promise<number> {
	const workspaces = accountingWorkspaces(ctx, sessionId)
	for (const workspace of workspaces) await workspace.detachSession(sessionId)
	await requireService(ctx, 'workspaceRegistry', 'editing the archive set').unarchiveSession(sessionId)
	return workspaces.length
}

/**
 * The JSONL session root, or undefined when the configured persistence backend
 * does not expose one (a different backend, or a future rename).
 * @param ctx - Host context.
 * @returns An absolute root directory, or undefined.
 */
export function sessionRoot(ctx: ServiceContext): string | undefined {
	const configured = ctx.get('sessionPersistence')?.config?.root
	if (typeof configured !== 'string' || configured.length === 0) return undefined
	return resolve(configured)
}

/**
 * Expand the tilde prefixes a configured path may carry, against the OS home.
 *
 * The Host's own resolver accepts `~`, `~/`, and `~\`; a configured path that
 * resolves differently here than there would send the rewind cleanup to a root
 * that never holds anything, which fails silently — so the same three prefixes
 * are expanded the same way.
 * @param path - A configured path.
 * @returns The expanded path, or the value unchanged when no prefix is present.
 */
function expandTilde(path: string): string {
	if (path === '~') return homedir()
	if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
	return path
}

/**
 * The harness home, resolved the way `@deepseek-ai/dsh-home-paths` resolves it.
 *
 * The plugin deliberately imports nothing from `@deepseek-ai/*` at runtime, so
 * the two-line precedence is restated here instead: `$DSH_HOME` when it carries
 * anything but whitespace, else `~/.dsh`. A blank override must not resolve the
 * home to the working directory, which is why the trim is part of the rule and
 * not a nicety.
 * @param env - Environment mapping to read; the process environment by default.
 * @returns An absolute harness home.
 */
export function harnessHome(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[HARNESS_HOME_ENV]
	if (configured !== undefined && configured.trim().length > 0) return resolve(expandTilde(configured))
	return join(homedir(), HARNESS_HOME_DIR)
}

/**
 * Every root that could hold this deployment's rewind snapshots, most specific
 * first.
 *
 * Three candidates, because the rewind plugin's root is configurable and this
 * plugin cannot read another plugin's config: its documented environment
 * override, the harness home it defaults to, and the sibling of the JSONL root
 * — which is where the home sits for the shipped layout and stays right even
 * when a composition hands the session backend a different root.
 *
 * A deployment that moved the snapshots somewhere none of these describe is
 * simply not found: nothing is removed, and nothing is claimed.
 * @param ctx - Host context.
 * @param env - Environment mapping to read; the process environment by default.
 * @returns Distinct absolute candidate roots.
 */
export function rewindRoots(ctx: ServiceContext, env: NodeJS.ProcessEnv = process.env): string[] {
	const candidates: string[] = []
	const configured = env[REWIND_ROOT_ENV]
	if (configured !== undefined && configured.trim().length > 0) candidates.push(resolve(expandTilde(configured)))
	candidates.push(join(harnessHome(env), REWIND_DIR))
	const root = sessionRoot(ctx)
	if (root !== undefined) candidates.push(join(resolve(root, '..'), REWIND_DIR))
	const roots: string[] = []
	for (const candidate of candidates) if (!roots.includes(candidate)) roots.push(candidate)
	return roots
}

/**
 * The directory name the rewind plugin stores one session's snapshots under.
 *
 * That plugin sanitizes the id before it becomes a path segment
 * (`[^a-zA-Z0-9._-] → _`, and the two dot names collapse to `session`), so the
 * name is mirrored here rather than assumed: deriving it differently would make
 * the cleanup look for a directory that was never written.
 * @param sessionId - The session id.
 * @returns The on-disk directory name for that session's snapshots.
 */
export function snapshotDirName(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
	return safe === '..' || safe === '.' ? 'session' : safe
}

/**
 * Locate one session's rewind snapshot directory.
 *
 * `readdir` is the existence test on purpose: it succeeds only for a directory
 * this process can enumerate, so a regular file that happens to carry the name
 * — or a directory it cannot read — is not mistaken for a snapshot tree that
 * can be deleted.
 * @param roots - Candidate roots, most specific first.
 * @param sessionId - The session to find.
 * @returns The owning root and the directory, or undefined when no root holds one.
 */
export async function locateRewindDir(roots: readonly string[], sessionId: string): Promise<{ root: string; dir: string } | undefined> {
	const name = snapshotDirName(sessionId)
	for (const root of roots) {
		const dir = join(root, name)
		try {
			await readdir(dir)
			return { root, dir }
		} catch {
			/* Not this root: no readable snapshot directory for this session here. */
		}
	}
	return undefined
}

/**
 * Locate one session's log directory.
 *
 * The backend groups logs as `<root>/<projectKey(cwd)>/<sessionId>/`, and
 * `projectKey` is a private encoding that changes between formats. Rather than
 * re-derive it and drift, the project directories are scanned once and matched
 * on the session id, which is unique on its own.
 * @param root - The JSONL session root.
 * @param sessionId - The session to find.
 * @returns The absolute log directory, or undefined.
 */
export async function locateLogDir(root: string, sessionId: string): Promise<string | undefined> {
	let projects: Dirent[]
	try {
		projects = await readdir(root, { withFileTypes: true })
	} catch {
		return undefined
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue
		const candidate = join(root, project.name, sessionId)
		let sessions: Dirent[]
		try {
			sessions = await readdir(join(root, project.name), { withFileTypes: true })
		} catch {
			continue
		}
		if (sessions.some((entry) => entry.isDirectory() && entry.name === sessionId)) return candidate
	}
	return undefined
}

/**
 * Guard before an unlink: the candidate must resolve strictly inside the root
 * and its final segment must be the exact name we expect to remove.
 *
 * The final-segment test is what makes an interior traversal safe while a
 * mismatched target is not: `readdir` discovers what is there, and this decides
 * whether what is there is the directory the caller asked about.
 * @param root - The containing root.
 * @param name - The expected directory name.
 * @param target - The discovered directory.
 * @returns Whether removal is safe.
 */
export function isRemovableChild(root: string, name: string, target: string): boolean {
	const rootPath = resolve(root)
	const resolved = resolve(target)
	if (resolved === rootPath) return false
	const inside = relative(rootPath, resolved)
	if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) return false
	const parts = resolved.split(sep)
	return parts[parts.length - 1] === name
}

/**
 * Guard before an unlink: the candidate must resolve strictly inside the root
 * and its final segment must be the exact session id we were asked to remove.
 * @param root - The JSONL session root.
 * @param sessionId - The session being deleted.
 * @param logDir - The discovered directory.
 * @returns Whether removal is safe.
 */
export function isRemovableLogDir(root: string, sessionId: string, logDir: string): boolean {
	return isRemovableChild(root, sessionId, logDir)
}

/**
 * Remove one session's log directory and, when it was the last session in its
 * project grouping, the now-empty grouping directory too.
 *
 * The grouping key is derived from the session's `cwd`, so leaving an empty
 * directory behind is inert but permanent cruft — one entry per workspace that
 * ever had a conversation. It is only removed when it is genuinely empty, so a
 * concurrent session in the same project is never disturbed.
 * @param root - The JSONL session root.
 * @param sessionId - The session being deleted.
 * @param logDir - The discovered session directory.
 * @returns Resolution after removal.
 */
async function removeLogDir(root: string, sessionId: string, logDir: string): Promise<void> {
	await rm(logDir, { recursive: true, force: true })
	const parent = resolve(logDir, '..')
	const rootPath = resolve(root)
	if (parent === rootPath || !isRemovableLogDir(rootPath, lastSegment(logDir), logDir)) return
	try {
		const remaining = await readdir(parent)
		if (remaining.length === 0) await rm(parent, { recursive: true, force: true })
	} catch {
		/* Not empty, or not removable: the session itself is already gone. */
	}
}

/**
 * The final path segment, for labelling a directory.
 * @param path - Any path.
 * @returns Its last segment.
 */
function lastSegment(path: string): string {
	const parts = String(path).split(sep)
	return parts[parts.length - 1] ?? String(path)
}

/**
 * Remove the rewind plugin's snapshot directory for one session.
 *
 * `dsh-rewind-plugin` keeps a per-session snapshot tree outside every trace the
 * Host owns, and it prunes that tree by *idle age* — 30 days, and only once its
 * auto-cleanup is switched on, which is off by default. A conversation deleted
 * today would therefore keep its snapshots indefinitely: the archive entry this
 * plugin was diagnosed against held 6.6 MB of them.
 *
 * The rewind plugin exposes no service, so this cannot ask it to forget the
 * session; the directory is removed directly, under the same guard the log
 * directory gets. Its in-memory bookkeeping is left alone on purpose — a
 * deleted session never records another entry, so the stale key is inert, while
 * a wrong path would be unrecoverable.
 * @param ctx - Host context.
 * @param sessionId - The session whose snapshots are removed.
 * @param roots - Candidate rewind roots; resolved from the Host when omitted.
 * @returns `removed`, `absent` (no root holds one), or `refused` (a root does,
 *   but the path failed the guard).
 */
export async function removeRewindDir(ctx: ServiceContext, sessionId: string, roots?: readonly string[]): Promise<'removed' | 'absent' | 'refused'> {
	const found = await locateRewindDir(roots ?? rewindRoots(ctx), sessionId)
	if (found === undefined) return 'absent'
	if (!isRemovableChild(found.root, snapshotDirName(sessionId), found.dir)) return 'refused'
	await rm(found.dir, { recursive: true, force: true })
	return 'removed'
}

/**
 * Yield for one bounded moment.
 * @param ms - Milliseconds to wait.
 * @returns Resolution after the wait.
 */
function delay(ms: number): Promise<void> {
	return new Promise((settle) => {
		setTimeout(settle, ms)
	})
}

/**
 * Whether one storage table still holds a row for `id`.
 *
 * `entries()` is the only read the domain's table contract declares, and every
 * implementation this runs against holds its rows in memory, so the linear scan
 * is the honest way to ask a question the contract does not answer directly.
 * @param table - The open table.
 * @param id - The row key.
 * @returns Whether the row is present.
 */
function tableHas<Row>(table: StorageTable<Row>, id: string): boolean {
	for (const [key] of table.entries()) if (key === id) return true
	return false
}

/**
 * Drop one session's cached projection checkpoint, and prove it stayed gone.
 *
 * The projection cache answers `session/disposed` — the very event the eviction
 * emits — with a fire-and-forget durable checkpoint, so a lone `delete` races
 * the write it just triggered: the row goes, the pending checkpoint lands, and
 * the file the deletion reported as dropped is back on disk. That race is not
 * hypothetical; it is what left 45 orphaned projection rows (4.6 MB) on the
 * profile this was diagnosed against, every one of them reported as a clean
 * deletion.
 *
 * The settle window is paid only when an eviction actually announced a
 * disposal, since that is the only thing that can schedule a checkpoint. A row
 * is never called dropped until a read comes back empty.
 * @param ctx - Host context.
 * @param sessionId - The session whose checkpoint is dropped.
 * @param options - `settleMs` waits out a pending disposal checkpoint first.
 * @returns `dropped`, `unavailable` (no projection domain is open), or
 *   `present` (the row survived every attempt).
 */
export async function dropProjection(ctx: ServiceContext, sessionId: string, options: { settleMs?: number } = {}): Promise<'dropped' | 'unavailable' | 'present'> {
	const table = ctx.get('storageDomain')?.get(PROJECTION_DOMAIN)?.table('sessions')
	if (table === undefined) return 'unavailable'
	const settle = options.settleMs ?? 0
	const attempts = settle > 0 ? PROJECTION_DROP_ATTEMPTS : 1
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		// The wait precedes each delete: the point is to let a write that has
		// already been scheduled land, so that this delete removes it too.
		const wait = attempt === 0 ? settle : settle * attempt
		if (wait > 0) await delay(wait)
		await table.delete(sessionId)
		if (!tableHas(table, sessionId)) return 'dropped'
	}
	return 'present'
}

/**
 * Delete one archived session completely.
 *
 * The archive set is the authority on whether a session is deletable: a session
 * that is not archived is never touched, so this can only ever act on rows the
 * archived view is showing. An archive entry whose log is already gone is not an
 * error — clearing that residue is exactly what this is for.
 * @param ctx - Host context.
 * @param sessionId - The session to delete.
 * @param options - `signal` cancels discovery, `deleteLog` skips the last step.
 * @returns A per-step report of what was actually removed.
 */
export async function deleteSession(ctx: ServiceContext, sessionId: unknown, options: DeleteOptions = {}): Promise<DeleteReport> {
	const signal = options.signal
	const report: DeleteReport = {
		sessionId,
		deleted: false,
		archived: false,
		wasStored: false,
		workspacesReleased: 0,
		archiveCleared: false,
		logRemoved: false,
		rewindRemoved: false,
		projectionDropped: false,
		evicted: false,
		problems: [],
		notes: [],
		residue: []
	}

	if (!isSessionId(sessionId)) {
		report.problems.push('refused: the session id is not a plain identifier')
		return report
	}
	let registry: WorkspaceRegistry
	try {
		registry = requireService(ctx, 'workspaceRegistry', 'deleting a conversation')
	} catch (error) {
		report.problems.push(`refused: ${message(error)}`)
		return report
	}
	if (typeof registry.unarchiveSession !== 'function') {
		report.problems.push("refused: this Host's workspace registry cannot edit the archive set, so nothing can be removed")
		return report
	}
	if (!registry.archivedSessionIds.includes(sessionId)) {
		report.problems.push('refused: this conversation is not archived, and only archived conversations can be deleted here')
		return report
	}
	report.archived = true

	const blocker = await liveBlocker(ctx, sessionId)
	if (blocker !== undefined) {
		report.problems.push(`refused: ${blocker}`)
		return report
	}
	if (signal?.aborted) {
		report.problems.push('cancelled before anything was removed')
		return report
	}

	const snapshot = await ctx.get('sessionPersistence')?.stat(sessionId, { signal })
	report.wasStored = snapshot !== undefined

	// Allowed, but worth saying: the app's own read models can keep a row for a
	// conversation whose files are gone until they next refresh.
	const resident = isResident(ctx, sessionId)

	try {
		report.workspacesReleased = await unregisterSession(ctx, sessionId)
		report.archiveCleared = true
	} catch (error) {
		report.problems.push(`could not clear the archive and workspace records (${message(error)})`)
		return report
	}

	// Release the in-memory session before anything durable is removed. This is
	// not bookkeeping: the release emits `session/disposed`, and every live
	// observer answers that with a write. Releasing last — the order this plugin
	// shipped with — put the projection checkpoint back on disk *after* it had
	// been deleted, which is exactly the residue the closing audit below exists
	// to catch. The log is safe either way: the store removes its entry before it
	// announces the disposal, so the checkpoint's own log flush is skipped.
	if (resident) {
		const eviction = evictResident(ctx, sessionId)
		report.evicted = eviction === 'released'
		if (eviction === 'unsupported') {
			report.notes.push('the app still had this conversation in memory and this build offers no way to release it, so a row may remain until DSH restarts')
		} else if (eviction === 'failed') {
			report.notes.push('the app still had this conversation in memory and releasing it failed, so a row may remain until DSH restarts')
		}
	} else if (!emitSessionRemoved(ctx, sessionId)) {
		// A cold session leaves no disposal behind, so nothing would ever tell the
		// browser its row is gone. Say so when the event cannot be emitted either,
		// rather than let a clean deletion read as a failed one.
		report.notes.push('this Host cannot announce a removed conversation, so its row clears on the next reconnect rather than now')
	}

	if (options.deleteLog === false) {
		report.notes.push('the conversation log was kept by configuration')
	} else {
		const root = sessionRoot(ctx)
		if (root === undefined) {
			report.notes.push('the conversation log stays on disk: this session backend exposes no root directory')
		} else {
			const logDir = await locateLogDir(root, sessionId)
			if (logDir === undefined) {
				report.notes.push('no conversation log was found on disk')
			} else if (!isRemovableLogDir(root, sessionId, logDir)) {
				report.problems.push(`refused to remove '${logDir}': it is outside the expected session layout`)
			} else {
				try {
					await removeLogDir(root, sessionId, logDir)
					report.logRemoved = true
				} catch (error) {
					report.problems.push(`could not delete the conversation log (${message(error)})`)
				}
			}
		}
	}

	try {
		report.rewindRemoved = (await removeRewindDir(ctx, sessionId)) === 'removed'
	} catch (error) {
		report.problems.push(`could not delete the rewind snapshots (${message(error)})`)
	}

	// The projection goes last, and it is verified: the checkpoint the eviction
	// triggered is fire-and-forget, so it can land after the first delete.
	try {
		const projection = await dropProjection(ctx, sessionId, { settleMs: report.evicted ? PROJECTION_SETTLE_MS : 0 })
		report.projectionDropped = projection === 'dropped'
		if (projection === 'unavailable') report.notes.push('no projection cache is open, so none was dropped')
	} catch (error) {
		report.problems.push(`could not drop the cached projection (${message(error)})`)
	}

	// Facts, not attempts: every trace is re-read now that no writer is left.
	// Whatever survives is residue, and residue is what makes this not clean —
	// reporting the steps alone is how a deletion that left 4.6 MB behind still
	// answered `deleted: true, clean: true`.
	try {
		report.residue = await findResidue(ctx, sessionId, { deleteLog: options.deleteLog !== false })
	} catch (error) {
		// An audit that could not run is not an audit that found nothing, and the
		// one thing this report may never do is call unverified work clean.
		report.problems.push(`could not verify what the deletion left behind (${message(error)})`)
	}
	report.archiveCleared = !report.residue.some((line) => line === RESIDUE_ARCHIVE)
	for (const line of report.residue) report.problems.push(`left behind: ${line}`)

	report.deleted = report.archiveCleared
	return report
}

/**
 * Re-read every trace one deleted session can occupy, and name what survived.
 *
 * This is the only thing in this module allowed to call a deletion clean. The
 * removal steps report what they attempted, in the order they attempted it,
 * which cannot see either failure that actually happens in practice: a
 * fire-and-forget write landing after the row it belongs to was deleted, and a
 * trace this plugin never knew about in the first place.
 *
 * A log kept by configuration is not residue — it was kept on purpose — so the
 * caller's `deleteLog` is what decides whether a surviving log is reported.
 * @param ctx - Host context.
 * @param sessionId - The session that was deleted.
 * @param options - `deleteLog` says whether a surviving log was intentional.
 * @returns One human-readable line per trace still present, in trace order.
 */
async function findResidue(ctx: ServiceContext, sessionId: string, options: { deleteLog: boolean }): Promise<string[]> {
	const residue: string[] = []

	if (ctx.get('workspaceRegistry')?.archivedSessionIds.includes(sessionId) === true) residue.push(RESIDUE_ARCHIVE)

	try {
		const slots = accountingWorkspaces(ctx, sessionId).length
		if (slots > 0) residue.push(`it is still accounted for by ${String(slots)} workspace record${slots === 1 ? '' : 's'}`)
	} catch {
		/* No registry to read: the archive line above already covers that deployment. */
	}

	if (options.deleteLog) {
		const root = sessionRoot(ctx)
		if (root !== undefined && (await locateLogDir(root, sessionId)) !== undefined) residue.push('its conversation log is still on disk')
	}

	try {
		const found = await locateRewindDir(rewindRoots(ctx), sessionId)
		if (found !== undefined) residue.push(`the rewind plugin still keeps snapshots for it at '${found.dir}'`)
	} catch {
		/* An unreadable candidate root is not evidence of a snapshot tree. */
	}

	try {
		const table = ctx.get('storageDomain')?.get(PROJECTION_DOMAIN)?.table('sessions')
		if (table !== undefined && tableHas(table, sessionId)) residue.push('its cached projection is still stored')
	} catch {
		/* A domain that cannot be read cannot be claimed clean either; the caller's
		   projection step has already reported that case as a note. */
	}

	return residue
}

/* -------------------------------------------------------------------------- */
/* the archived view                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The fields the archived view shows, as far as the Host could answer for them.
 *
 * Each field carries the value that degrades honestly rather than a failure: an
 * unknown title is empty, an unknown time is `0`, and an unknown size is `-1`
 * (never `0`, which would claim a conversation is empty). No session is hidden
 * and no deletion is refused because metadata was unavailable.
 */
interface SessionFacts {
	title: string
	updatedAt: number
	sizeBytes: number
	cwd: string
}

/** The facts of a session no service could describe. */
const UNKNOWN_FACTS: Readonly<SessionFacts> = { title: '', updatedAt: 0, sizeBytes: -1, cwd: '' }

/** One entry of a batch request, kept as received so validation sees the real value. */
interface RequestedItem {
	/** The value as the transport delivered it. */
	readonly value: unknown
	/** The string this entry is reported under. */
	readonly label: string
}

/**
 * The archived session ids the registry currently names.
 *
 * The registry's own set is the only authority read here, so the view and the
 * deletion can never disagree about what is archived. Ids that are not plain
 * identifiers are left out: they can be neither opened nor deleted, so a row
 * for one would be a button that cannot work. Duplicates are dropped because a
 * repeated row would otherwise be listed — and later deleted — twice.
 * @param registry - The workspace registry.
 * @returns The deletable archived ids, in registry order.
 */
function archivedIds(registry: WorkspaceRegistry): string[] {
	const ids: string[] = []
	const seen = new Set<string>()
	for (const value of registry.archivedSessionIds) {
		if (!isSessionId(value) || seen.has(value)) continue
		seen.add(value)
		ids.push(value)
	}
	return ids
}

/**
 * Read the titles of many sessions through one log-backed batch.
 *
 * `readTitleSnapshots` isolates per-session failures, so a single unreadable log
 * costs one title rather than the whole view. A Host without the service, or one
 * whose read fails, simply yields no titles: the listing must still show the
 * sessions themselves, because a session with no readable title is exactly the
 * kind a user goes to this page to remove.
 * @param ctx - Host context.
 * @param sessionIds - The sessions to read titles for.
 * @param signal - Cancellation.
 * @returns The titles that could be read, keyed by session id.
 */
async function readTitles(ctx: ServiceContext, sessionIds: readonly string[], signal?: AbortSignal): Promise<Map<string, string>> {
	const titles = new Map<string, string>()
	const query = ctx.get('sessionQuery')
	if (sessionIds.length === 0 || isAborted(signal)) return titles
	if (typeof query?.readTitleSnapshots !== 'function') return titles
	try {
		const observations = await query.readTitleSnapshots(sessionIds, signal)
		for (const observation of observations ?? []) {
			if (observation.status !== 'fulfilled') continue
			const title = observation.value.title?.title
			if (typeof title === 'string' && title.length > 0) titles.set(observation.sessionId, title)
		}
	} catch {
		/* No titles at all is a degraded view; no sessions at all would not be. */
	}
	return titles
}

/**
 * Read the last-activity stamp the shipped session list itself shows.
 *
 * Neither of the other two sources has a "last updated" number: a persistence
 * snapshot carries `header.createdAt` and `sizeBytes`, and a session-query
 * record is only `{ header, live, persisted }`. The Host service behind the
 * sidebar, `sessionController`, does carry one — its own
 * `max(header.createdAt, sessionListMetadata.lastPromptAt)` — so reading it
 * keeps this page's timestamps consistent with the list the user already sees
 * instead of deriving a second clock that would disagree with it.
 * @param ctx - Host context.
 * @param signal - Cancellation.
 * @returns The activity stamps and working directories that could be read.
 */
async function readActivity(ctx: ServiceContext, signal?: AbortSignal): Promise<Map<string, { updatedAt: number; cwd: string }>> {
	const activity = new Map<string, { updatedAt: number; cwd: string }>()
	const controller = ctx.get('sessionController')
	if (typeof controller?.list !== 'function' || isAborted(signal)) return activity
	try {
		const value = await controller.list({}, signal)
		for (const item of value?.items ?? []) {
			if (!isSessionId(item?.sessionId)) continue
			const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
			activity.set(item.sessionId, { updatedAt, cwd: typeof item.cwd === 'string' ? item.cwd : '' })
		}
	} catch {
		/* An unavailable activity clock costs a timestamp, never a row. */
	}
	return activity
}

/**
 * Read the physical size of every stored session.
 *
 * One `list()` covers the whole batch on purpose: the size this view shows
 * before a deletion and the bytes a deletion reports as freed must come from
 * the same observation, or the two numbers could disagree. An absent
 * `sizeBytes` stays `-1`, so a backend that does not report sizes never turns
 * into a claim that a conversation occupies nothing.
 * @param ctx - Host context.
 * @param signal - Cancellation.
 * @returns The sizes and working directories that could be read.
 */
async function readSizes(ctx: ServiceContext, signal?: AbortSignal): Promise<Map<string, { sizeBytes: number; cwd: string }>> {
	const sizes = new Map<string, { sizeBytes: number; cwd: string }>()
	const persistence = ctx.get('sessionPersistence')
	if (typeof persistence?.list !== 'function' || isAborted(signal)) return sizes
	try {
		const snapshots = await persistence.list({ signal })
		for (const snapshot of snapshots ?? []) {
			const header = snapshot?.header
			if (!isSessionId(header?.id)) continue
			const size = snapshot?.sizeBytes
			sizes.set(header.id, {
				sizeBytes: typeof size === 'number' && Number.isFinite(size) ? size : -1,
				cwd: typeof header.cwd === 'string' ? header.cwd : ''
			})
		}
	} catch {
		/* A backend that cannot list keeps its sessions; it only loses the size column. */
	}
	return sizes
}

/**
 * Collect everything the Host can say about one batch of sessions.
 *
 * The sources are read independently and each failure costs only its own
 * fields, so a session with no facts at all is still listed and still
 * deletable.
 * @param ctx - Host context.
 * @param sessionIds - The sessions to describe.
 * @param signal - Cancellation.
 * @returns Facts keyed by session id, every field already degraded.
 */
async function readFacts(ctx: ServiceContext, sessionIds: readonly string[], signal?: AbortSignal): Promise<Map<string, SessionFacts>> {
	const titles = await readTitles(ctx, sessionIds, signal)
	const activity = await readActivity(ctx, signal)
	const sizes = await readSizes(ctx, signal)
	const facts = new Map<string, SessionFacts>()
	for (const sessionId of sessionIds) {
		const moment = activity.get(sessionId)
		const stored = sizes.get(sessionId)
		facts.set(sessionId, {
			title: titles.get(sessionId) ?? '',
			updatedAt: moment?.updatedAt ?? 0,
			sizeBytes: stored?.sizeBytes ?? -1,
			cwd: moment?.cwd || stored?.cwd || ''
		})
	}
	return facts
}

/**
 * Whether the caller has already withdrawn one batch.
 *
 * Read through a helper because the compiler narrows `signal.aborted` from an
 * earlier check and cannot know that an `await` in between may have flipped it.
 * @param signal - Cancellation, when the caller passed one.
 * @returns Whether the signal is already aborted.
 */
function isAborted(signal?: AbortSignal): boolean {
	return signal?.aborted === true
}

/**
 * Whether this session has work in flight that a deletion would refuse on.
 *
 * This is {@link liveBlocker}'s own rule — a running turn, or running subagents
 * that depend on the conversation — asked as a boolean, so the view marks
 * exactly the rows a one-click delete cannot remove. A probe that cannot answer
 * counts as "not running", the deletion's own fail-open rule: an unreadable
 * registry must never make a conversation look permanently locked.
 * @param ctx - Host context.
 * @param sessionId - The session to probe.
 * @returns Whether a deletion would be refused for liveness right now.
 */
async function isBusy(ctx: ServiceContext, sessionId: string): Promise<boolean> {
	try {
		return (await liveBlocker(ctx, sessionId)) !== undefined
	} catch {
		return false
	}
}

/**
 * Order the view by last activity, newest first, and then by id.
 *
 * The id tiebreak is what makes the order deterministic: a Host that cannot
 * report timestamps at all (every `updatedAt` is `0`) still gets a stable list
 * instead of one that reshuffles between reads.
 * @param left - One entry.
 * @param right - Another entry.
 * @returns The comparator result.
 */
function compareArchived(left: ArchivedEntry, right: ArchivedEntry): number {
	if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
	return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
}

/**
 * List every archived conversation, newest first.
 *
 * The archive set is the authority on what this returns — the same set
 * `deleteSession` refuses against — so every row here is a row that can be
 * deleted, and a session that is merely old (not archived) never appears.
 *
 * Only a missing workspace registry is fatal. Titles, timestamps, sizes and
 * liveness all degrade, because a management view that hides a session whose
 * log is unreadable is precisely the view that cannot clean it up.
 * @param ctx - Host context.
 * @param options - `signal` cancels the listing.
 * @returns The archived entries, ordered by `updatedAt` descending and then by id.
 * @throws {Error} when the Host provides no workspace registry, or the signal is aborted.
 */
export async function listArchived(ctx: ServiceContext, options: ListArchivedOptions = {}): Promise<ArchivedEntry[]> {
	const signal = options.signal
	signal?.throwIfAborted()
	const registry = requireService(ctx, 'workspaceRegistry', 'listing the archived conversations')
	const ids = archivedIds(registry)
	const facts = await readFacts(ctx, ids, signal)
	const entries: ArchivedEntry[] = []
	for (const sessionId of ids) {
		// A cancelled listing throws instead of answering with the prefix it
		// managed to read: a partial archive view would silently under-report
		// what is there, which is the one thing this page must never do.
		signal?.throwIfAborted()
		const known = facts.get(sessionId) ?? UNKNOWN_FACTS
		entries.push({
			sessionId,
			title: known.title,
			updatedAt: known.updatedAt,
			sizeBytes: known.sizeBytes,
			running: await isBusy(ctx, sessionId),
			cwd: known.cwd
		})
	}
	return entries.sort(compareArchived)
}

/**
 * Normalize one request into the entries a batch will report on.
 *
 * Entries are deduplicated by the label they are reported under — a repeated id
 * is one conversation, and processing it twice would report the second pass as
 * "no longer archived", which reads like a failure. Non-string entries are kept
 * rather than dropped so that a request for five entries never answers with
 * three results; the raw value is what {@link isSessionId} sees, so a number can
 * never become the string that happens to name a session.
 * @param sessionIds - The ids as the transport delivered them.
 * @returns Distinct entries, in request order.
 */
function requestedItems(sessionIds: readonly unknown[]): RequestedItem[] {
	const items: RequestedItem[] = []
	const seen = new Set<string>()
	for (const value of sessionIds) {
		const label = typeof value === 'string' ? value : String(value)
		if (seen.has(label)) continue
		seen.add(label)
		items.push({ value, label })
	}
	return items
}

/**
 * Delete archived conversations in one batch.
 *
 * The archive set is snapshotted once, before the first deletion, and an id
 * outside it is reported as `not-archived` and left completely alone: that is
 * the security invariant of this whole plugin — only an id the registry itself
 * calls archived may be removed — held for a batch exactly as `deleteSession`
 * holds it for a single call, so a body from the browser can never widen the
 * set of conversations this code can touch.
 *
 * One entry failing never stops the batch: a refusal (a running turn, live
 * subagents, a session that is no longer archived, a registry that cannot
 * write) is recorded and the next entry is processed. Deletions also run one at
 * a time on purpose — the registry serializes its own writes, so issuing them
 * concurrently would only make the write order, and therefore a partial
 * failure, unpredictable.
 *
 * When the signal aborts, the entries already deleted stay deleted and every
 * entry not yet processed is recorded as `skipped`, which is what a caller
 * needs to explain a batch the user cancelled halfway.
 * @param ctx - Host context.
 * @param options - `signal` cancels the batch, `deleteLog` keeps transcripts,
 *   `sessionIds` narrows it to a subset (omitted means every archived conversation).
 * @returns The batch summary, including one result per requested entry.
 * @throws {Error} when the Host provides no workspace registry.
 */
export async function deleteArchived(ctx: ServiceContext, options: DeleteArchivedOptions = {}): Promise<ArchivedDeleteSummary> {
	const signal = options.signal
	const registry = requireService(ctx, 'workspaceRegistry', 'deleting archived conversations')
	const archived = new Set(archivedIds(registry))
	const items =
		options.sessionIds === undefined
			? [...archived].map((sessionId): RequestedItem => ({ value: sessionId, label: sessionId }))
			: requestedItems(options.sessionIds)
	const summary: ArchivedDeleteSummary = {
		requested: items.length,
		deleted: 0,
		refused: 0,
		failed: 0,
		skipped: 0,
		bytesFreed: 0,
		residue: 0,
		removed: { workspacesReleased: 0, projectionDropped: 0, logsRemoved: 0, rewindRemoved: 0 },
		results: []
	}

	// Titles come from the very logs this batch is about to remove, so they are
	// read once up front: afterwards there would be nothing left to read them from.
	const titles = await readTitles(
		ctx,
		items.flatMap((item) => (isSessionId(item.value) ? [item.value] : [])),
		signal
	)
	// Sizes come from one observation, so the bytes reported as freed are the
	// same bytes the listing showed before the deletion.
	const sizes = await readSizes(ctx, signal)

	/**
	 * Record one outcome, keeping the counters in step with the results.
	 *
	 * `bytesFreed` counts a size only when the log was actually removed: a
	 * transcript kept by configuration (`deleteLog: false`) or one that was
	 * already gone frees nothing, so counting it would report space that is
	 * still occupied as reclaimed.
	 *
	 * A deleted entry that carries residue keeps the `deleted` outcome — the
	 * conversation is gone from every list — but its residue becomes the result's
	 * reason and is counted separately, so a batch can no longer answer `clean`
	 * while it left bytes behind.
	 * @param sessionId - The entry's id.
	 * @param outcome - What happened to it.
	 * @param reason - The human-readable reason, empty for `deleted`.
	 * @param report - The deletion report, when a deletion was attempted.
	 */
	const record = (sessionId: string, outcome: ArchivedOutcome, reason: string, report?: DeleteReport): void => {
		const residue = report?.residue ?? []
		summary.results.push({
			sessionId,
			title: titles.get(sessionId) ?? '',
			outcome,
			reason: reason.length > 0 ? reason : residue.join('; '),
			residue
		})
		if (outcome === 'deleted') summary.deleted += 1
		else if (outcome === 'refused') summary.refused += 1
		else if (outcome === 'failed') summary.failed += 1
		else if (outcome === 'skipped') summary.skipped += 1
		// `not-archived` has no counter of its own: nothing was asked of that
		// conversation, so it is a result rather than a shortfall.
		if (report === undefined || !report.deleted) return
		if (residue.length > 0) summary.residue += 1
		summary.removed.workspacesReleased += report.workspacesReleased
		if (report.projectionDropped) summary.removed.projectionDropped += 1
		if (report.rewindRemoved) summary.removed.rewindRemoved += 1
		if (!report.logRemoved) return
		summary.removed.logsRemoved += 1
		const freed = sizes.get(sessionId)?.sizeBytes ?? -1
		if (freed > 0) summary.bytesFreed += freed
	}

	for (const item of items) {
		// Checked before every entry, so an abort stops the batch at a record
		// boundary: everything already deleted stays deleted, and everything from
		// here on is reported as skipped rather than silently missing.
		if (isAborted(signal)) {
			record(item.label, 'skipped', 'the batch was cancelled before this conversation was processed')
			continue
		}
		if (!isSessionId(item.value)) {
			record(item.label, 'skipped', 'not a plain session identifier, so it was ignored')
			continue
		}
		const sessionId = item.value
		if (!archived.has(sessionId)) {
			record(sessionId, 'not-archived', 'this conversation is not in the archive set, so it was left alone')
			continue
		}
		let report: DeleteReport
		try {
			report = await deleteSession(ctx, sessionId, { signal, deleteLog: options.deleteLog })
		} catch (error) {
			if (isAborted(signal)) record(sessionId, 'skipped', 'the batch was cancelled while this conversation was being deleted')
			else record(sessionId, 'failed', `the deletion failed: ${message(error)}`)
			continue
		}
		if (report.deleted) {
			record(sessionId, 'deleted', '', report)
			continue
		}
		if (isAborted(signal)) {
			record(sessionId, 'skipped', 'the batch was cancelled while this conversation was being deleted')
			continue
		}
		record(sessionId, 'refused', report.problems[0] ?? 'the conversation could not be deleted', report)
	}
	return summary
}
