/**
 * Self-test for `dsh-delete-session`.
 *
 * The Host half is exercised against a fake Host that reproduces the semantics
 * the deletion depends on:
 *
 *   - `WorkspaceRegistry` keeps its archive set in an in-memory cache and
 *     refreshes it only through `unarchiveSession`, so a deletion that wrote the
 *     domain behind the registry's back would let the next `archiveSession`
 *     rebuild the archive set from the stale copy and resurrect the id;
 *   - a workspace record can still name a session whose header no longer
 *     resolves, which the public `Workspace.sessionIds` getter hides and the
 *     durable table does not.
 *
 * The browser half is checked as an artifact: it must register under the package
 * name the Host graph expects, require only shell-seeded modules, and parse.
 *
 * Run: node selftest.mjs
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteArchived, deleteSession, harnessHome, isRemovableChild, isRemovableLogDir, isSessionId, listArchived, locateLogDir, message, rewindRoots, snapshotDirName } from './lib/core.js'
import { apply } from './lib/index.js'

/* -------------------------------------------------------------------------- */
/* tiny test harness                                                           */
/* -------------------------------------------------------------------------- */

let passed = 0
const failures = []

function check(name, condition, detail) {
	if (condition) {
		passed += 1
		console.log(`  ok   ${name}`)
	} else {
		failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
		console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
	}
}

function equal(name, actual, expected) {
	const same = JSON.stringify(actual) === JSON.stringify(expected)
	check(name, same, same ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function section(title) {
	console.log(`\n${title}`)
}

/**
 * Find one rendered control by the text it carries.
 *
 * The jsx stub returns `{ type, props, key }`, so a rendered tree is walkable —
 * which is what lets the browser-half checks drive a control the way a click
 * would instead of only asserting that a registration exists. A control matches
 * by its visible label or its accessible name, and must carry a handler.
 * @param node - A rendered node, an array of them, or a leaf.
 * @param label - The text the control renders.
 * @returns The control, or undefined.
 */
function findControl(node, label) {
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findControl(child, label)
			if (hit !== undefined) return hit
		}
		return undefined
	}
	if (node === null || typeof node !== 'object') return undefined
	const props = node.props
	if (props !== null && typeof props === 'object') {
		const named = props.children === label || props['aria-label'] === label || props.label === label
		if (named && (typeof props.onClick === 'function' || typeof props.onChange === 'function')) return node
		const hit = findControl(props.children, label)
		if (hit !== undefined) return hit
	}
	return undefined
}

/* -------------------------------------------------------------------------- */
/* fake Host                                                                   */
/* -------------------------------------------------------------------------- */

/** Mirrors `dsh-storage-domain`'s table: an in-memory map behind a write chain. */
class FakeTable {
	constructor(records = {}) {
		this.records = new Map(Object.entries(records))
		this.chain = Promise.resolve()
	}
	get(key) {
		return this.records.get(key)
	}
	entries() {
		return this.records.entries()
	}
	has(key) {
		return this.records.has(key)
	}
	enqueue(operation) {
		const next = this.chain.then(operation, operation)
		this.chain = next.then(
			() => undefined,
			() => undefined
		)
		return next
	}
	put(key, value) {
		return this.enqueue(() => {
			this.records.set(key, value)
		})
	}
	delete(key) {
		return this.enqueue(() => this.records.delete(key))
	}
}

/** One workspace record with the two mutations the deletion uses. */
class FakeWorkspace {
	constructor(table, id) {
		this.table = table
		this.id = id
	}
	get record() {
		return this.table.get(this.id)
	}
	/** The public getter hides sessions whose header no longer resolves. */
	get sessionIds() {
		return (this.record?.sessionIds ?? []).filter((id) => !this.hidden?.has(id))
	}
	async detachSession(sessionId) {
		const record = this.record
		if (record === undefined || !record.sessionIds.includes(sessionId)) return
		await this.table.put(this.id, { ...record, sessionIds: record.sessionIds.filter((id) => id !== sessionId) })
	}
}

/**
 * The registry fake that matters: `unarchiveSession` is the *only* way the
 * archive set changes, and it refreshes the same cache a later `archiveSession`
 * would read.
 */
class FakeWorkspaceRegistry {
	constructor(table, archived) {
		this.table = table
		this.cache = new Set(archived)
		this.unarchiveCalls = []
	}
	get archivedSessionIds() {
		return [...this.cache]
	}
	list() {
		return [...this.table.entries()].map(([id]) => this.get(id)).filter(Boolean)
	}
	get(id) {
		if (!this.table.has(id)) return undefined
		const workspace = new FakeWorkspace(this.table, id)
		workspace.hidden = this.hidden
		return workspace
	}
	async unarchiveSession(sessionId) {
		this.unarchiveCalls.push(sessionId)
		this.cache.delete(sessionId)
	}
	/** Mirrors the resurrection hazard: it rebuilds from the cache. */
	async archiveSession(sessionId) {
		this.cache.add(sessionId)
	}
}

/**
 * A fake Host context.
 *
 * Every service is exposed through `get()` rather than as a property, because
 * that is the only access the deletion is allowed to use: the Host plugin
 * declares `connection` and `webServer` and nothing else, so reaching
 * `ctx.workspaceRegistry` directly would trip Cordis's inject guard in a real
 * Host. `omit` lets one case remove a service entirely.
 */
function fakeHost({ workspaces, archived, projection, root, live = {}, stored = new Set(), sizes, query, controller, omit = [] }) {
	const tables = { workspaces: new FakeTable(workspaces) }
	const domains = { workspace: { table: (name) => tables[name] } }
	if (projection !== undefined) {
		tables.sessions = new FakeTable(projection)
		domains.session_projcache = { table: (name) => tables[name] }
	}
	const registry = new FakeWorkspaceRegistry(tables.workspaces, archived)
	const persistence = {
		config: root === undefined ? {} : { root },
		stat: async (id) => (stored.has(id) ? { sessionId: id, header: { createdAt: Date.now(), cwd: '/tmp' }, sizeBytes: 10 } : undefined),
		// The batch observation the archived view reads: one snapshot per session
		// the case declares a size for. A session with no declared size is one the
		// backend cannot size, which must degrade to -1 rather than to 0.
		list: async () =>
			Object.entries(sizes ?? {}).map(([id, sizeBytes]) => ({
				header: { id, createdAt: 1_700_000_000_000, cwd: '/tmp/project' },
				sizeBytes
			}))
	}
	// The live-registry surface: `get` reports residency, and `liveEntryFor` /
	// `detachEntered` are the store's own detach path the eviction uses.
	const residentIds = new Set(live.sessions ?? [])
	// Every announced disposal reaches whoever listens for it, exactly as the
	// real store's `detachEntered` does after it has already removed its entry.
	// This is the seam the deletion has to survive: the projection cache answers
	// `session/disposed` with an unconditional, fire-and-forget checkpoint, so a
	// fake that stays silent here cannot reproduce the residue at all.
	const disposalListeners = []
	const residentSessions = {
		get: (id) => (residentIds.has(id) ? { id } : undefined),
		liveEntryFor: (session) => (residentIds.has(session.id) ? { id: session.id } : undefined),
		detachEntered: (entry) => {
			if (live.evictThrows === true) throw new Error('detach refused')
			residentIds.delete(entry.id)
			for (const listener of disposalListeners) listener({ id: entry.id })
		}
	}
	const services = {
		workspaceRegistry: registry,
		sessionPersistence: persistence,
		sessions: residentSessions,
		storageDomain: { get: (name) => domains[name] },
		agents: {
			get: (id) => {
				if (live.agents?.includes(id)) return { id, status: 'running' }
				if (live.residentAgents?.includes(id)) return { id, status: 'idle' }
				return undefined
			},
			// The live registry, and the *only* liveness source: a finished child
			// is simply not in it. `liveAgents` names the agents that are live
			// right now, each with the Session header lineage is read from.
			list: () => {
				if (live.agentsThrow === true) throw new Error('the agent registry is unavailable')
				return (live.liveAgents ?? []).map((agent) => ({
					id: agent.id,
					status: agent.status,
					session: { header: { id: agent.id, parentSession: agent.parentSession, origin: agent.origin ?? 'subagent' } }
				}))
			}
		},
		// The durable subagent catalog, served exactly as the real Host serves it.
		// It is here to be *ignored* by the liveness rule: it lists every child a
		// conversation ever spawned, finished ones included, so a deletion that
		// believed it could never remove a conversation that ever used a subagent.
		subagents:
			live.catalog === undefined
				? undefined
				: {
						listDescendants: async () => live.catalog.map((id) => ({ sessionId: id }))
					},
		// The log-backed title index. `readTitleSnapshots` isolates failures per
		// session in the real Host; the fake mirrors that, and `throws` stands for
		// a whole-corpus failure such as a missing index.
		sessionQuery:
			query === undefined
				? undefined
				: {
						readTitleSnapshots: async (sessionIds, signal) => {
							signal?.throwIfAborted()
							if (query.throws === true) throw new Error('the title index is unavailable')
							return sessionIds.map((sessionId) => {
								const title = query.titles?.[sessionId]
								return title === undefined
									? { sessionId, status: 'rejected', reason: new Error('no title event') }
									: { sessionId, status: 'fulfilled', value: { session: { id: sessionId, createdAt: 0 }, title: { title, updatedAt: 1 } } }
							})
						}
					},
		// The Host service behind the shipped session list: the app's own clock.
		sessionController:
			controller === undefined
				? undefined
				: {
						list: async (_request, signal) => {
							signal?.throwIfAborted()
							if (controller.throws === true) throw new Error('the session list is unavailable')
							return { items: controller.items }
						}
					}
	}
	const emitted = []
	return {
		get: (name) => (omit.includes(name) ? undefined : services[name]),
		// Cordis dispatches an emitted event to the emitter's ancestors, which is
		// how the session controller's own pushes reach the browser relay. The
		// fake records them so a case can assert what the browser was told.
		emit: (event, ...args) => {
			if (omit.includes('emit')) return undefined
			emitted.push([event, ...args])
			return undefined
		},
		__emitted: emitted,
		__tables: tables,
		__registry: registry,
		/**
		 * Register one `session/disposed` listener.
		 *
		 * The projection cache is modelled by the case that needs it, because
		 * what it does with the event — a durable write the eviction triggers and
		 * nothing waits for — is the behaviour under test.
		 * @param listener - Called with `{ id }` once per announced disposal.
		 * @returns Nothing.
		 */
		__onDisposed: (listener) => {
			disposalListeners.push(listener)
		}
	}
}

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const SESSION = 'session-41efa976-0000-4000-8000-000000000001'
/** A second archived conversation, used where a row must be distinguishable from the first. */
const THIRD = 'session-9f2c8a10-0000-4000-8000-000000000003'
const OTHER = 'session-34d1e337-0000-4000-8000-000000000002'

/** Lay out one session the way the JSONL backend groups logs. */
async function seedLog(root, sessionId, project = '-Users-someone-Documents-workspace-') {
	const dir = join(root, project, sessionId)
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'transcript\n')
	return dir
}

/* -------------------------------------------------------------------------- */
/* checks                                                                      */
/* -------------------------------------------------------------------------- */

section('identifier validation')
check('a plain id is accepted', isSessionId('session-abc'))
check('an empty id is refused', !isSessionId(''))
check('a traversal segment is refused', !isSessionId('../etc'))
check('an embedded slash is refused', !isSessionId('a/b'))
check('a non-string is refused', !isSessionId(42))

section('log-directory guards')
check('a child of the root is removable', isRemovableLogDir('/root', 'session-a', '/root/project/session-a'))
check('the root itself is not removable', !isRemovableLogDir('/root', 'session-a', '/root'))
check('a path escaping the root is not removable', !isRemovableLogDir('/root', 'session-a', '/root/../session-a'))
// The guard reads the *resolved* path, so an interior traversal that lands back
// inside the root is still a legitimate session directory.
check('an interior traversal that resolves inside is removable', isRemovableLogDir('/root', 'session-a', '/root/project/../session-a'))
check('a mismatched final segment is not removable', !isRemovableLogDir('/root', 'session-a', '/root/project/session-b'))
check('an unrelated root is not removable', !isRemovableLogDir('/root', 'session-a', '/other/session-a'))

section('the rewind store the deletion also has to clear')
{
	// The rewind plugin's own id sanitizer, mirrored: a name derived differently
	// would send the cleanup after a directory that was never written.
	equal('a plain id is its own directory name', snapshotDirName('session-a'), 'session-a')
	equal('a traversal segment cannot survive as a name', snapshotDirName('..'), 'session')
	equal('a separator becomes an underscore', snapshotDirName('a/b'), 'a_b')
	check('the guard refuses a differently named child', !isRemovableChild('/root', 'session-a', '/root/session-b'))
	check('the guard accepts the named child', isRemovableChild('/root', 'session-a', '/root/session-a'))
	check('the guard refuses a child of another root', !isRemovableChild('/root', 'session-a', '/other/session-a'))

	// The harness home, resolved the way the Host resolves it: an override wins,
	// a blank one is unset rather than the working directory, and the default is
	// the OS home's `.dsh`.
	equal('an explicit home wins', harnessHome({ DSH_HOME: '/tmp/home' }), '/tmp/home')
	equal('a blank home falls back to the default', harnessHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
	const roots = rewindRoots({ get: () => undefined }, { DSH_REWIND_SNAPSHOT_DIR: '/tmp/snaps' })
	equal('the rewind override is the first candidate', roots[0], '/tmp/snaps')
	check('the harness home is also a candidate', roots.includes(join(homedir(), '.dsh', 'rewind-snapshots')), roots.join(', '))
	equal('candidates are deduplicated', new Set(roots).size, roots.length)
}

section('deleting an archived conversation')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const logDir = await seedLog(root, SESSION)
		const host = fakeHost({
			workspaces: {
				'ws-1': { sessionIds: [SESSION, OTHER], path: '/Users/someone/Documents/plugins' },
				'ws-2': { sessionIds: [SESSION], path: '/tmp' }
			},
			archived: [SESSION, OTHER],
			projection: { [SESSION]: { asOfSeq: 3 }, [OTHER]: { asOfSeq: 1 } },
			root,
			stored: new Set([SESSION, OTHER])
		})

		const report = await deleteSession(host, SESSION)

		check('the deletion succeeded', report.deleted, report.problems.join('; '))
		check('it reported no problems', report.problems.length === 0, report.problems.join('; '))
		equal('it released both workspace slots', report.workspacesReleased, 2)
		check('it cleared the archive id', report.archiveCleared)
		check('it dropped the cached projection', report.projectionDropped)
		check('it removed the log directory', report.logRemoved)
		check('the log directory is gone', !existsSync(logDir))
		check('the emptied project grouping is gone too', !existsSync(join(root, '-Users-someone-Documents-workspace-')))
		equal('the archive set lost exactly that id', host.__registry.archivedSessionIds, [OTHER])
		equal('it went through the registry, not the domain', host.__registry.unarchiveCalls, [SESSION])
		equal('ws-1 kept the other session', host.__tables.workspaces.get('ws-1').sessionIds, [OTHER])
		equal('ws-2 is empty', host.__tables.workspaces.get('ws-2').sessionIds, [])
		check('the projection row is gone', !host.__tables.sessions.has(SESSION))
		check("another session's projection is untouched", host.__tables.sessions.has(OTHER))

		// The resurrection hazard: a later archive must not rebuild the deleted id
		// from a stale cache.
		await host.__registry.archiveSession(OTHER)
		equal('a later archive does not resurrect the deleted id', host.__registry.archivedSessionIds, [OTHER])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('a stale workspace record is cleared even when the header is gone')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/gone' } },
			archived: [SESSION],
			root,
			stored: new Set()
		})
		// The public getter hides the slot; the durable table still holds it.
		host.__registry.hidden = new Set([SESSION])
		equal('the public projection hides the slot', host.__registry.get('ws-1').sessionIds, [])

		const report = await deleteSession(host, SESSION)

		check('the deletion still succeeded', report.deleted, report.problems.join('; '))
		equal('the durable slot was cleared anyway', report.workspacesReleased, 1)
		check('a missing log is not a problem', report.problems.length === 0, report.problems.join('; '))
		check('it said the log was already gone', report.notes.some((note) => note.includes('no conversation log')), report.notes.join('; '))
		check('it reported the session as not stored', report.wasStored === false)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('refusals')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const logDir = await seedLog(root, SESSION)

		// A Host that provides no workspace registry must refuse loudly and remove
		// nothing, rather than tripping a Cordis inject guard.
		const noRegistry = fakeHost({ workspaces: {}, archived: [SESSION], root, stored: new Set([SESSION]), omit: ['workspaceRegistry'] })
		const noRegistryReport = await deleteSession(noRegistry, SESSION)
		check('a Host without a workspace registry refuses', !noRegistryReport.deleted)
		check('the refusal names the missing service', noRegistryReport.problems[0]?.includes('workspaceRegistry'), noRegistryReport.problems.join('; '))

		const notArchived = fakeHost({ workspaces: {}, archived: [], root, stored: new Set([SESSION]) })
		const refused = await deleteSession(notArchived, SESSION)
		check('an unarchived conversation is refused', !refused.deleted)
		check('the refusal explains why', refused.problems[0]?.includes('not archived'), refused.problems.join('; '))
		check('the refusal removed nothing', existsSync(logDir))

		const running = fakeHost({ workspaces: {}, archived: [SESSION], root, live: { agents: [SESSION] }, stored: new Set([SESSION]) })
		const runningReport = await deleteSession(running, SESSION)
		check('a conversation with a running turn is refused', !runningReport.deleted)
		check('the running refusal explains why', runningReport.problems[0]?.includes('a turn is running'), runningReport.problems.join('; '))
		check('a running refusal leaves the archive set alone', running.__registry.archivedSessionIds.includes(SESSION))
		check('a running refusal leaves the log', existsSync(logDir))

		const descendant = fakeHost({
			workspaces: {},
			archived: [SESSION],
			root,
			live: { liveAgents: [{ id: 'session-child', status: 'running', parentSession: SESSION }] },
			stored: new Set([SESSION])
		})
		const descendantReport = await deleteSession(descendant, SESSION)
		check('a conversation with a running descendant is refused', !descendantReport.deleted)
		check('the descendant refusal names them', descendantReport.problems[0]?.includes('running subagent'), descendantReport.problems.join('; '))

		// The regression this rule exists for. The Host serves a durable
		// `subagentCatalog` for every conversation that ever spawned a child, and
		// counting *it* — instead of the live registry — refuses the deletion
		// forever: on the profile this was diagnosed against, four children whose
		// last log write was more than a day old still answered `running: true`.
		const finished = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			root,
			live: { catalog: ['session-child-1', 'session-child-2', 'session-child-3', 'session-child-4'] },
			stored: new Set([SESSION])
		})
		const finishedReport = await deleteSession(finished, SESSION)
		check('finished subagents do not block the deletion', finishedReport.deleted, finishedReport.problems.join('; '))
		check('and the deletion is clean', finishedReport.problems.length === 0, finishedReport.problems.join('; '))

		// A child that is live but idle is not running either: an idle agent is
		// not writing to anything.
		const idleChild = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			root,
			live: { liveAgents: [{ id: 'session-child', status: 'idle', parentSession: SESSION }] },
			stored: new Set([SESSION])
		})
		check('an idle live child does not block it', (await deleteSession(idleChild, SESSION)).deleted)

		// A child reached through another child: lineage is read at any depth.
		const grandchild = fakeHost({
			workspaces: {},
			archived: [SESSION],
			root,
			live: {
				liveAgents: [
					{ id: 'session-child', status: 'idle', parentSession: SESSION },
					{ id: 'session-grandchild', status: 'running', parentSession: 'session-child' }
				]
			},
			stored: new Set([SESSION])
		})
		check('a running grandchild is found through its parent', !(await deleteSession(grandchild, SESSION)).deleted)

		// A fork shares the lineage field without the origin, so it never holds
		// the conversation it was forked from.
		const fork = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			root,
			live: { liveAgents: [{ id: 'session-fork', status: 'running', parentSession: SESSION, origin: 'fork' }] },
			stored: new Set([SESSION])
		})
		check('a fork is not a descendant', (await deleteSession(fork, SESSION)).deleted)

		const abusive = fakeHost({ workspaces: {}, archived: ['../escape'], root })
		const abusiveReport = await deleteSession(abusive, '../escape')
		check('an abusive id is refused before any filesystem work', !abusiveReport.deleted)

		// Re-seeded on purpose: the cases above that are *allowed* to proceed
		// really did delete this conversation, log included, so the abort case
		// needs its own transcript to have something to preserve.
		await seedLog(root, SESSION)
		const cancelled = new AbortController()
		cancelled.abort()
		const cancelling = fakeHost({ workspaces: {}, archived: [SESSION], root, stored: new Set([SESSION]) })
		const cancelledReport = await deleteSession(cancelling, SESSION, { signal: cancelled.signal })
		check('an aborted call removes nothing', !cancelledReport.deleted)
		check('an aborted call leaves the archive set alone', cancelling.__registry.archivedSessionIds.includes(SESSION))
		check('the log survives an abort', existsSync(logDir))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('an archive entry whose log is already gone is still deletable')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		// A registry that cannot answer is no evidence of activity, and a
		// conversation with no log is certainly not running: a probe that throws
		// must never turn "cannot determine" into a refusal nothing can clear.
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/gone' } },
			archived: [SESSION],
			root,
			live: { agentsThrow: true },
			stored: new Set()
		})
		const report = await deleteSession(host, SESSION)
		check('a throwing liveness probe does not block the deletion', report.deleted, report.problems.join('; '))
		check('it reported no problems', report.problems.length === 0, report.problems.join('; '))
		check('the archive id was cleared', report.archiveCleared)
		equal('the archive set is now empty', host.__registry.archivedSessionIds, [])
		equal('the durable slot was released', host.__tables.workspaces.get('ws-1').sessionIds, [])
		check('the missing log is a note, not a problem', report.notes.some((n) => n.includes('no conversation log')), report.notes.join('; '))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('the browser is told the row left the list')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		// A cold conversation. Releasing a *resident* session is what emits
		// `session/disposed`, and the Host pushes `api-session/removed` from that
		// event alone — so a session nobody holds is deleted in complete silence,
		// and the row it left behind on screen survives until the next reconnect.
		// That is how a fully clean 10 MB deletion still looked like a failure.
		const cold = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			root,
			stored: new Set([SESSION])
		})
		await deleteSession(cold, SESSION)
		equal('a cold deletion announces the removal', cold.__emitted, [['api-session/removed', SESSION]])

		// A resident one is disposed instead, and the disposal already carries the
		// push. Announcing it twice would be noise, not a fix.
		const warm = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			root,
			live: { sessions: [SESSION] },
			stored: new Set([SESSION])
		})
		await deleteSession(warm, SESSION)
		check('a resident deletion leaves the announcement to its disposal', warm.__emitted.length === 0, JSON.stringify(warm.__emitted))

		// A Host that cannot emit says so, instead of letting the caller believe a
		// row it will still see is gone.
		const mute = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			root,
			stored: new Set([SESSION])
		})
		delete mute.emit
		const muteReport = await deleteSession(mute, SESSION)
		check('the deletion still succeeds', muteReport.deleted, muteReport.problems.join('; '))
		check(
			'a Host that cannot announce it says the row clears on reconnect',
			muteReport.notes.some((note) => note.includes('next reconnect')),
			muteReport.notes.join('; ')
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('a resident but idle conversation is deletable')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const logDir = await seedLog(root, SESSION)
		// `sessions.get()` reports the Host's in-memory registry; an idle resident
		// agent is not writing anything, so neither may block the deletion. Only a
		// *running* turn does.
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			projection: { [SESSION]: { asOfSeq: 1 } },
			root,
			live: { sessions: [SESSION], residentAgents: [SESSION] },
			stored: new Set([SESSION])
		})
		const report = await deleteSession(host, SESSION)
		check('a merely resident conversation is still deletable', report.deleted, report.problems.join('; '))
		check('is reported as clean', report.problems.length === 0, report.problems.join('; '))
		check('the log is gone', !existsSync(logDir))
		equal('the archive set is empty', host.__registry.archivedSessionIds, [])
		check('it released the session from the live registry', report.evicted)
		check('the session is no longer resident', host.get('sessions').get(SESSION) === undefined)
		check('it reports no leftover row', report.notes.length === 0, report.notes.join('; '))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('a build without the store detach path still deletes, and says a row may remain')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const host = fakeHost({
			workspaces: {},
			archived: [SESSION],
			root,
			live: { sessions: [SESSION] },
			stored: new Set([SESSION])
		})
		// Strip the optional detach surface: the deletion must still succeed.
		const sessions = host.get('sessions')
		delete sessions.liveEntryFor
		delete sessions.detachEntered
		const report = await deleteSession(host, SESSION)
		check('the deletion still succeeds', report.deleted, report.problems.join('; '))
		check('it does not claim to have evicted', report.evicted === false)
		check('it warns that a row may remain', report.notes.some((n) => n.includes('may remain')), report.notes.join('; '))
		check('the archive entry is still gone', host.__registry.archivedSessionIds.length === 0)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('a failing eviction does not fail the deletion')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const host = fakeHost({
			workspaces: {},
			archived: [SESSION],
			root,
			live: { sessions: [SESSION], evictThrows: true },
			stored: new Set([SESSION])
		})
		const report = await deleteSession(host, SESSION)
		check('the deletion still succeeds', report.deleted, report.problems.join('; '))
		check('no problem is reported for the eviction', report.problems.length === 0, report.problems.join('; '))
		check('it warns that a row may remain', report.notes.some((n) => n.includes('may remain')), report.notes.join('; '))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('the disposal checkpoint cannot resurrect the projection')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			projection: { [SESSION]: { asOfSeq: 1 } },
			root,
			live: { sessions: [SESSION] },
			stored: new Set([SESSION])
		})
		// `SessionProjectionCache.installWritePath()`: the disposal triggers an
		// unconditional, fire-and-forget durable checkpoint. Deleting the
		// projection before the eviction — the order this plugin shipped with —
		// let this write put the row straight back, and the deletion still
		// reported `deleted: true, projectionDropped: true, problems: []`.
		host.__onDisposed((session) => {
			void host.__tables.sessions.put(session.id, { asOfSeq: 9 })
		})
		const report = await deleteSession(host, SESSION)
		check('the deletion still succeeds', report.deleted, report.problems.join('; '))
		check('it drops the projection after the eviction', report.projectionDropped)
		check('the resurrected row is gone', !host.__tables.sessions.has(SESSION))
		check('nothing is reported as left behind', report.residue.length === 0, report.residue.join('; '))
		check('the deletion is clean', report.problems.length === 0, report.problems.join('; '))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('a checkpoint that lands late is still caught')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			projection: { [SESSION]: { asOfSeq: 1 } },
			root,
			live: { sessions: [SESSION] },
			stored: new Set([SESSION])
		})
		// A write scheduled well after the disposal — slower than the first
		// settle window — is what the retry loop exists for: the row has to be
		// deleted again once it has landed.
		host.__onDisposed((session) => {
			setTimeout(() => {
				void host.__tables.sessions.put(session.id, { asOfSeq: 9 })
			}, 60)
		})
		const report = await deleteSession(host, SESSION)
		check('the late checkpoint does not survive', !host.__tables.sessions.has(SESSION))
		check('the deletion is clean', report.problems.length === 0, report.problems.join('; '))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('a row that will not stay deleted is reported as residue')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			projection: { [SESSION]: { asOfSeq: 1 } },
			root,
			stored: new Set([SESSION])
		})
		// A table whose delete is a no-op: the row survives every attempt, which
		// is exactly the case the closing audit has to name instead of answering
		// with a green "deleted".
		host.__tables.sessions.delete = async () => true
		const report = await deleteSession(host, SESSION)
		check('the conversation is still deleted', report.deleted)
		check('the projection is not claimed as dropped', !report.projectionDropped)
		check('the residue names the projection', report.residue.some((line) => line.includes('cached projection')), report.residue.join('; '))
		check(
			'the residue is also a problem, so the deletion is not called clean',
			report.problems.some((problem) => problem.startsWith('left behind:')),
			report.problems.join('; ')
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('the rewind snapshots go with the conversation')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	const rewind = await mkdtemp(join(tmpdir(), 'dsh-rewind-'))
	const previous = process.env.DSH_REWIND_SNAPSHOT_DIR
	process.env.DSH_REWIND_SNAPSHOT_DIR = rewind
	try {
		const logDir = await seedLog(root, SESSION)
		// One session's snapshot tree, laid out the way the rewind plugin writes
		// it: an anchor group holding the captured files.
		const snapDir = join(rewind, SESSION, '18')
		await mkdir(snapDir, { recursive: true })
		await writeFile(join(snapDir, 'file.json'), '{"version":1}')
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			projection: { [SESSION]: { asOfSeq: 1 } },
			root,
			stored: new Set([SESSION])
		})
		const report = await deleteSession(host, SESSION)
		check('the deletion succeeds', report.deleted, report.problems.join('; '))
		check('it reports removing the rewind snapshots', report.rewindRemoved)
		check('the snapshot directory is gone', !existsSync(join(rewind, SESSION)))
		check('the log is gone too', !existsSync(logDir))
		check('nothing is left behind', report.residue.length === 0, report.residue.join('; '))

		// A snapshot tree the deletion cannot find is not a tree it may claim to
		// have removed: another session's is untouched, and a second run over the
		// same id simply finds nothing.
		const sibling = join(rewind, OTHER, '4')
		await mkdir(sibling, { recursive: true })
		const again = await deleteSession(
			fakeHost({ workspaces: {}, archived: [OTHER], projection: {}, root, stored: new Set([OTHER]) }),
			OTHER
		)
		check('another conversation’s snapshots are removed by its own deletion', again.rewindRemoved)
		check('and that tree is gone', !existsSync(join(rewind, OTHER)))
	} finally {
		if (previous === undefined) delete process.env.DSH_REWIND_SNAPSHOT_DIR
		else process.env.DSH_REWIND_SNAPSHOT_DIR = previous
		await rm(root, { recursive: true, force: true })
		await rm(rewind, { recursive: true, force: true })
	}
}

section('partial outcomes are reported, not thrown')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const logDir = await seedLog(root, SESSION)
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION], path: '/x' } },
			archived: [SESSION],
			projection: { [SESSION]: { asOfSeq: 1 } },
			root,
			stored: new Set([SESSION])
		})
		// The projection table refuses, which must not stop the log removal.
		host.__tables.sessions.delete = async () => {
			throw new Error('locked')
		}
		const report = await deleteSession(host, SESSION)
		check('the conversation is still reported as deleted', report.deleted)
		check('the projection failure is reported', report.problems.some((problem) => problem.includes('cached projection')), report.problems.join('; '))
		check('the log was still removed', report.logRemoved)
		check('the log is gone', !existsSync(logDir))

		// A backend with no root: the log cannot be located, and that is a note.
		const noRoot = fakeHost({ workspaces: {}, archived: [SESSION], stored: new Set([SESSION]) })
		const noRootReport = await deleteSession(noRoot, SESSION)
		check('a backend without a root still deletes the registry state', noRootReport.deleted)
		check('the missing root is a note, not a problem', noRootReport.problems.length === 0 && noRootReport.notes.some((n) => n.includes('no root directory')), [...noRootReport.problems, ...noRootReport.notes].join('; '))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('log discovery')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const wanted = await seedLog(root, SESSION, 'project-a')
		await seedLog(root, OTHER, 'project-b')
		const found = await locateLogDir(root, SESSION)
		equal('discovery finds the id under any project key', found, wanted)
		check('discovery returns undefined for an unknown id', (await locateLogDir(root, 'session-nope')) === undefined)
		check('discovery tolerates a missing root', (await locateLogDir(join(root, 'nope'), SESSION)) === undefined)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('the message helper never throws on an unknown throw')
check('an Error renders its message', message(new Error('boom')) === 'boom')
check('a string renders itself', message('boom') === 'boom')
check('undefined renders safely', typeof message(undefined) === 'string')

section('the browser half is a loadable, self-contained bundle')
{
	const source = await (await import('node:fs/promises')).readFile(new URL('./lib/client.js', import.meta.url), 'utf8')

	// Load it exactly as the module system does: one `load()` call carrying a
	// factory, which the loader invokes with its own `require`.
	let registration
	globalThis.window = {
		__ModuleLoader__: {
			load: (entry) => {
				registration = entry
			}
		}
	}
	try {
		await import(new URL('./lib/client.js', import.meta.url).href)
	} finally {
		delete globalThis.window
	}

	check('the bundle registers one module', registration !== undefined)
	equal('it registers under the package name the Host graph expects', registration?.id, 'dsh-delete-session')
	check('it exposes a factory', typeof registration?.factory === 'function')

	const requested = []
	let reactFace = null
	const stub = (name) => {
		requested.push(name)
		if (name === 'react') {
			const cleanups = []
			let effectRan = false
			reactFace = {
				useState: () => [undefined, () => {}],
				useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
				// Real React runs a mount effect once; running it once here is what
				// makes "subscribe on mount, dispose on unmount" observable at all.
				useEffect: (fn) => {
					if (effectRan) return
					effectRan = true
					const cleanup = fn()
					if (typeof cleanup === 'function') cleanups.push(cleanup)
				},
				effectCleanups: cleanups
			}
			return reactFace
		}
		if (name === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) }
		if (name === '@deepseek-ai/dsh-client-ui-primitives') {
			return {
				MenuItemButton: () => null,
				RiskConfirmation: (props) => ({ type: 'RiskConfirmation', props }),
				Toast: (props) => ({ type: 'Toast', props }),
				Button: (props) => ({ type: 'Button', props }),
				Checkbox: (props) => ({ type: 'Checkbox', props }),
				Input: (props) => ({ type: 'Input', props }),
				IconTrashOutlineRegular: () => null,
				IconWarningOutlineRegular: () => null
			}
		}
		throw new Error(`unexpected module request: ${name}`)
	}

	let exports
	try {
		exports = registration.factory(stub)
	} catch (error) {
		check('the factory runs with only the seeded modules', false, message(error))
	}
	check('the factory returned exports', exports !== undefined)
	check('it exports apply()', typeof exports?.apply === 'function')
	equal(
		'it requires only shell-seeded modules',
		[...new Set(requested)].sort(),
		['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime']
	)
	check('it declares no hard inject, so it cannot park the boot', !source.includes('exports.inject'))

	// A Host that provides nothing must leave the half inert, not throwing: the
	// renderer treats any client entry that does not reach `active` as fatal.
	//
	// `ctx.inject` is the whole point of the shape: this half registers from a
	// deferred injection, because a client entry materializes before the services
	// it wants have activated. Reading `ctx.get('slots')` eagerly returns
	// undefined and silently drops the feature — the exact bug this test now
	// pins, by asserting the deferred callback is what registers.
	const registered = []
	const inertCallbacks = []
	const inert = {
		get: () => undefined,
		inject: (names, callback) => {
			inertCallbacks.push(names)
			callback({ get: () => undefined })
			return () => {}
		}
	}
	try {
		exports.apply(inert)
		check('apply() is inert on a Host with no slots service', true)
	} catch (error) {
		check('apply() is inert on a Host with no slots service', false, message(error))
	}
	equal('it defers on exactly the services it needs', inertCallbacks, [['slots', 'workspaces', 'locale']])
	check('an unavailable service registers nothing instead of throwing', registered.length === 0)

	// A Host that provides the services it needs must register all four entries.
	const fakeSlots = {
		inject: (key, callback) => {
			callback()
			return () => {}
		},
		register: (options, component) => {
			// The whole declaration is kept, not just the identity: a later check
			// drives each registration's own inject face, which is where the section
			// gets its list and its actions from.
			registered.push({ ...options, key: options.name, component })
			return () => {}
		}
	}
	// Every restore the page asks for lands here: the page must use the shipped
	// controller's own call, never edit the archive set itself.
	//
	// The archive set is also the client's own pushed projection, so the fake keeps
	// subscribers and lets a check play "someone archived a conversation".
	const restored = []
	let archivedIds = [SESSION]
	const archiveSubscribers = new Set()
	const workspaces = {
		list: {
			getSnapshot: () => ({ archivedSessionIds: archivedIds, items: [] }),
			subscribe: (listener) => {
				archiveSubscribers.add(listener)
				return () => archiveSubscribers.delete(listener)
			}
		},
		unarchiveSession: async (sessionId) => {
			restored.push(sessionId)
		}
	}
	/** Play one pushed membership change, the way the workspace stream would. */
	const pushArchive = (ids) => {
		archivedIds = ids
		for (const listener of [...archiveSubscribers]) listener()
	}
	// Stand-in for the client's locale registry: `bind` returns a key resolver and
	// the snapshot pair is the uSES face the components subscribe through.
	const localeSnapshot = { active: 'en', locales: [], revision: 1 }
	const fakeLocale = {
		registered: [],
		register(ns, locale, dict) {
			this.registered.push([ns, locale, dict])
			return () => {}
		},
		bind: (ns) => (key) => `${ns}.${key}`,
		// 真实 locale 服务返回的是**稳定引用**（内容变了才换对象），而 useSyncExternalStore
		// 用身份判断"变了没有"：假件若每次新建对象，就等于让"快照身份不稳 → 无限重渲染"
		// 这类问题在测试里永远不可能被发现。这里跟真实现对齐。
		getSnapshot: () => localeSnapshot,
		subscribe: () => () => {}
	}
	// `ClientSessions.refresh()` is the client's own "re-read the Host baseline".
	// The counter is what pins that a mutation asks for it at all.
	let refreshed = 0
	const services = {
		slots: fakeSlots,
		workspaces,
		sessions: {
			refresh: async () => {
				refreshed += 1
			}
		},
		locale: fakeLocale
	}
	const full = {
		get: (name) => services[name],
		inject: (names, callback) => {
			callback({ get: (name) => services[name] })
			return () => {}
		}
	}
	try {
		exports.apply(full)
	} catch (error) {
		check('apply() registers on a complete Host', false, message(error))
	}
	equal('it registered one dictionary per shipped locale', fakeLocale.registered.map(([ns, locale]) => `${ns}:${locale}`).sort(), ['dsh-delete-session:en', 'dsh-delete-session:zh'])
	check('every dictionary defines the same keys', new Set(fakeLocale.registered.map(([, , dict]) => Object.keys(dict).sort().join(','))).size === 1)
	equal('it registered the menu row, both overlays, and the settings section', registered.map((entry) => entry.id).sort(), [
		'archived-sessions',
		'dsh-delete-session.confirm',
		'dsh-delete-session.delete',
		'dsh-delete-session.notice'
	])
	check('the menu row lands in the session menu slot', registered.some((entry) => entry.key === 'sidebar.workspaces.session.menu.item'))
	check('the menu row sorts after the shipped archive row (400)', registered.find((entry) => entry.id.endsWith('.delete')) !== undefined)
	check('every registration carries a component', registered.every((entry) => typeof entry.component === 'function'))

	/* ---- the section id is what carries the nav glyph -------------------- */

	// `settings.section` projects only id/order/label, and the shell picks the nav
	// glyph from a closed list of ids it knows — every other id gets its own gear.
	// `archived-sessions` is the id that list reserves for this page, so taking the
	// shipped id (instead of one of this package's own) IS the icon mechanism; a
	// rename back to a private id would silently bring the gear back.
	check(
		'the section takes the shipped id whose nav glyph is the archive mark',
		registered.some((entry) => entry.key === 'settings.section' && entry.id === 'archived-sessions')
	)
	check(
		'it does not register a private section id the shell would draw a gear on',
		!registered.some((entry) => entry.key === 'settings.section' && String(entry.id).startsWith('dsh-delete-session.'))
	)

	/* ---------------------------------------------------------------------- */
	/* the archived-conversation settings page                                 */
	/* ---------------------------------------------------------------------- */

	// Everything below drives the real registration through its own inject face:
	// the section gets its list and its actions there, so this is the same path
	// the renderer takes, with the Host's answer stubbed at `fetch`.
	const archivedSection = registered.find((entry) => entry.key === 'settings.section')
	check('the manager is a settings section of its own', archivedSection?.key === 'settings.section')
	equal('it sits after the shipped sections (order 45)', archivedSection?.order, 45)
	check(
		'its nav label is a thunk, so the row follows the language switch',
		typeof archivedSection?.label === 'function' && typeof archivedSection.label() === 'string'
	)

	const calls = []
	const listed = [
		{ sessionId: SESSION, title: 'archived one', updatedAt: 1730000000000, sizeBytes: 2048, running: false, cwd: '/w' },
		{ sessionId: THIRD, title: '', updatedAt: 0, sizeBytes: -1, running: true, cwd: '' }
	]
	let singleAnswer = { ok: true, value: { sessionId: SESSION, deleted: true, clean: true, notes: [], problems: [] } }
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
		const target = String(url)
		const body = target.endsWith('/archived')
			? { ok: true, value: { total: listed.length, entries: listed } }
			: target.endsWith('/delete')
				? singleAnswer
				: { ok: true, value: { requested: 2, deleted: 1, refused: 1, failed: 0, skipped: 0, clean: false } }
		return { status: 200, ok: true, text: async () => JSON.stringify(body) }
	}

	const sectionInjected = archivedSection.inject()
	const firstFrame = archivedSection.component(sectionInjected)
	check(
		'the page asks the Host for the list on its first render, not at page boot',
		calls.length === 1 && calls[0].method === 'GET' && calls[0].url.endsWith('/_delete-session/archived')
	)
	check('it shows the loading copy while that read is in flight', JSON.stringify(firstFrame).includes('loading'))

	await new Promise((resolve) => setTimeout(resolve, 0))
	const tree = JSON.stringify(archivedSection.component(sectionInjected))
	check('it lists every archived conversation under its own title', tree.includes('archived one'))
	check('a conversation with no readable title falls back to its distinctive id segment', tree.includes(THIRD.replace(/^session-/, '').slice(0, 8)))
	check('a row whose turn is running is marked as one the deletion will refuse', tree.includes('rowRunning'))
	check('the page offers a per-row delete and one bulk action', tree.includes('rowDelete') && tree.includes('deleteAll'))
	check('the total comes from the Host count', tree.includes('total'))

	// Bulk deletion: the dialog says how many conversations it is about to walk,
	// and confirming posts the empty body that means "whatever the archive set
	// holds now" — the page never chooses the set.
	const confirmInjected = registered.find((entry) => entry.id === 'dsh-delete-session.confirm').inject()
	// The fake locale resolves a key to `<namespace>.<key>`, so a control's label is
	// the namespaced text — the same thing a real locale hands back.
	findControl(archivedSection.component(sectionInjected), 'dsh-delete-session.deleteAll')?.props?.onClick?.()
	equal('the bulk action raises a pending request carrying the count', confirmInjected.usePending((value) => value), {
		kind: 'all',
		count: listed.length
	})
	const dialog = registered.find((entry) => entry.id === 'dsh-delete-session.confirm').component(confirmInjected)
	check(
		'the bulk dialog names the count and keeps the acknowledgment gate',
		String(dialog.props.title).includes('confirmAllTitle') &&
			String(dialog.props.confirmLabel).includes('confirmAllLabel') &&
			String(dialog.props.acknowledgeLabel).includes('acknowledge')
	)
	await dialog.props.onConfirm()
	await new Promise((resolve) => setTimeout(resolve, 0))

	const bulk = calls.find((call) => call.method === 'POST')
	check('confirming posts the bulk route', bulk !== undefined && bulk.url.endsWith('/_delete-session/delete-all'))
	check('the bulk body is empty, so the page cannot choose what "all" means', bulk?.body === '{}')
	const notice = registered.find((entry) => entry.id === 'dsh-delete-session.notice').inject().useNotice((value) => value)
	check(
		'a batch with a refused row is reported as partial, with the counts',
		notice?.tone === 'partial' && String(notice.text).includes('bulkPartial')
	)
	check(
		'the list is re-read afterwards, so deleted rows stop showing',
		calls.filter((call) => call.url.endsWith('/archived')).length === 2
	)
	// The row that has to disappear lives in the *browser's* Session list, which
	// this plugin's deletion never travels through — so it must ask for a re-read.
	check('the browser Session list is asked to re-read after a deletion', refreshed > 0)
	// Call-shaped on purpose: the file's own comment explains the old, wrong name,
	// so a bare substring test would match the explanation instead of a call.
	check(
		'that re-read calls the API the client actually has (ClientSessions.refresh)',
		/['"]sessions['"]\s*\)\s*\?*\.\s*refresh\s*\?\.\s*\(/.test(source) && !/refreshList\s*\?*\.\s*\(/.test(source)
	)
	// …and it must look the service up at call time: `ctx.get` answers `undefined`
	// for a provider that has not activated yet, and a value captured during
	// injection would stay `undefined` forever — the same silent no-op again.
	check(
		'that re-read resolves the sessions service per call, not once at injection',
		/scoped\.get\('sessions'\)\s*\?*\.\s*refresh/.test(source) && !/const sessions = scoped\.get/.test(source)
	)

	// A deletion the Host could not finish silently — a Session it could not
	// release, so a row may remain until DSH restarts — arrives as a note. It must
	// not be reported as a clean success.
	singleAnswer = {
		ok: true,
		value: { sessionId: SESSION, deleted: true, clean: true, notes: ['the app still had this conversation in memory'], problems: [] }
	}
	await confirmInjected.confirmDelete(SESSION)
	await new Promise((resolve) => setTimeout(resolve, 0))
	const residueNotice = registered.find((entry) => entry.id === 'dsh-delete-session.notice').inject().useNotice((value) => value)
	check(
		'a Host-reported residue is surfaced instead of reading as success',
		residueNotice?.tone === 'partial' && String(residueNotice.text).includes('still had this conversation')
	)
	// `key` is a reserved prop: inside the props object React drops it silently, and
	// the Toast's lifetime timer only depends on `holdMs`, so a reused instance would
	// cut the next outcome short. It must arrive as the runtime's third argument.
	const noticeEntry = registered.find((entry) => entry.id === 'dsh-delete-session.notice')
	const toast = noticeEntry.component(noticeEntry.inject())
	check('the toast is keyed per notice through the jsx runtime, not a prop', toast?.key === String(residueNotice.id) && toast?.props?.key === undefined)

	/* ---- the batch surface: search, restore, multi-select --------------- */

	// The page carries the reference layout: a title, a one-line description, a tab
	// whose right end holds the irreversible action, a search field, and one card.
	const page = JSON.stringify(archivedSection.component(sectionInjected))
	check('the page leads with a title and a description', page.includes('sectionTitle') && page.includes('sectionIntro'))
	check('the tab row carries the destructive action', page.includes('tabLabel') && page.includes('dsh-delete-session.deleteAll'))
	check('the toolbar carries the search field', page.includes('dsh-delete-session.searchPlaceholder'))
	// The field has to fill the row: `Input` keeps its own wrapper and forwards
	// props to the inner <input>, so the flex container has to be ours.
	check('the search field gets a flex container of its own', page.includes('"flex":1') && page.includes('"minWidth":0'))
	// 搜索框高度：primitive 的盒子写死 32px 且没有 size prop，`style` 又只透传给内部 input，
	// 所以只能靠一个作用在自己 className 上的规则 —— 这三条断言就是那次「太矮」的回归闸门。
	check('the search field carries the class the height rule targets', page.includes('dsh-delete-session-search'))
	check('the height rule ships with the field and asks for the medium control height',
		page.includes('.dsh-delete-session-search{height:36px') && page.includes('dsh-delete-session-search{height:36px !important'))
	check('the rows live in one card', page.includes('"borderRadius":"12px"'))

	// Search narrows the rendered rows locally: the Host list decides membership,
	// the query is only a view over it.
	sectionInjected.setQuery('archived one')
	const searched = JSON.stringify(archivedSection.component(sectionInjected))
	check(
		'search narrows the list to matching conversations',
		searched.includes('archived one') && !searched.includes(THIRD.replace(/^session-/, '').slice(0, 8))
	)
	check('a search with no hits says so instead of showing an empty card', (() => {
		sectionInjected.setQuery('nothing matches this')
		const miss = JSON.stringify(archivedSection.component(sectionInjected))
		sectionInjected.setQuery('')
		return miss.includes('noMatches')
	})())

	// Restoring is the shipped controller's own action, so the page calls it rather
	// than editing the archive set — and never asks for confirmation to undo.
	const rowUnarchive = findControl(archivedSection.component(sectionInjected), 'dsh-delete-session.rowUnarchive')
	check('a row offers the reversible action', rowUnarchive !== undefined)
	await rowUnarchive?.props?.onClick?.()
	await new Promise((resolve) => setTimeout(resolve, 0))
	equal('restoring goes through the shipped workspace service', restored, [SESSION])
	const restoreNotice = registered.find((entry) => entry.id === 'dsh-delete-session.notice').inject().useNotice((value) => value)
	check('the restore is reported as done', restoreNotice?.tone === 'done' && String(restoreNotice.text).includes('unarchived'))
	const afterRestore = refreshed
	check('restoring also asks the Session list to re-read', afterRestore >= 2)

	// Ticking turns the page into a batch surface, and the destructive control is
	// marked with the theme's own error colour rather than a literal one.
	findControl(archivedSection.component(sectionInjected), 'dsh-delete-session.selectAll')?.props?.onChange?.(true)
	const batchTree = JSON.stringify(archivedSection.component(sectionInjected))
	check('select-all raises the batch bar with its count', batchTree.includes('selectedCount') && batchTree.includes('deleteSelected'))
	check('the batch bar offers the reversible action too', batchTree.includes('unarchiveSelected'))
	check('a ticked row keeps its own actions visible', batchTree.includes('"visibility":"visible"'))
	const dangerControl = findControl(archivedSection.component(sectionInjected), 'dsh-delete-session.deleteSelected')
	check(
		'the destructive control takes the theme error colour',
		String(dangerControl?.props?.style?.color).includes('state-error-primary')
	)

	dangerControl?.props?.onClick?.()
	const selectedRequest = confirmInjected.usePending((value) => value)
	equal('the batch request names exactly the ticked conversations', [...(selectedRequest?.sessionIds ?? [])].sort(), [SESSION, THIRD].sort())
	const selectedDialog = registered.find((entry) => entry.id === 'dsh-delete-session.confirm').component(confirmInjected)
	check('the batch dialog names the count and its own label', String(selectedDialog.props.title).includes('confirmSelectedTitle') && String(selectedDialog.props.confirmLabel).includes('confirmSelectedLabel'))
	await selectedDialog.props.onConfirm()
	await new Promise((resolve) => setTimeout(resolve, 0))
	const tickedPost = calls.filter((call) => call.method === 'POST').at(-1)
	check('confirming posts the ticked ids', String(tickedPost?.body).includes('sessionIds') && String(tickedPost?.body).includes(SESSION))
	check('the selection is cleared once the batch settles', archivedSection.inject().useSelection((value) => value.size) === 0)

	/* ---- staying current without a manual refresh ------------------------ */

	const reads = () => calls.filter((call) => call.url.endsWith('/archived')).length

	// Someone archives a conversation in the sidebar: the membership push must make
	// this page re-read itself, which is what removes the manual 刷新 step.
	const beforePush = reads()
	pushArchive([SESSION, THIRD])
	await new Promise((resolve) => setTimeout(resolve, 350))
	check('a pushed archive change re-reads the list on its own', reads() > beforePush)

	// Unrelated workspace churn hands back a new snapshot carrying the same
	// membership; re-reading on that would be pure noise.
	const beforeNoise = reads()
	pushArchive([SESSION, THIRD])
	await new Promise((resolve) => setTimeout(resolve, 350))
	check('a workspace change that leaves the membership alone costs no read', reads() === beforeNoise)

	// Unmounting disposes the subscription with the effect, so a closed page stops
	// reading (and a pending debounce is cancelled).
	for (const cleanup of reactFace?.effectCleanups ?? []) cleanup()
	const beforeDisposed = reads()
	pushArchive([SESSION])
	await new Promise((resolve) => setTimeout(resolve, 350))
	check('the page stops re-reading once it unmounts', reads() === beforeDisposed)

	// A composition whose workspace service offers no restore call shows no restore
	// control at all — a dead button would be worse than its absence.
	registered.length = 0
	const bareServices = { ...services, workspaces: { list: workspaces.list } }
	const bareContext = {
		get: (name) => bareServices[name],
		inject: (names, callback) => {
			callback({ get: (name) => bareServices[name] })
			return () => {}
		}
	}
	exports.apply(bareContext)
	const bare = registered.find((entry) => entry.key === 'settings.section')
	const bareInjected = bare.inject()
	bare.component(bareInjected)
	await new Promise((resolve) => setTimeout(resolve, 0))
	const bareTree = JSON.stringify(bare.component(bareInjected))
	check('such a composition still lists its rows', bareTree.includes('dsh-delete-session.rowDelete'))
	check('without the restore call the page offers no restore control', !bareTree.includes('dsh-delete-session.rowUnarchive'))
	// The control is hidden there, but the action itself must still refuse honestly:
	// counting an optional call that never happened would report a restore that did
	// not occur.
	await bareInjected.unarchive([SESSION])
	await new Promise((resolve) => setTimeout(resolve, 0))
	const bareNotice = registered.find((entry) => entry.id === 'dsh-delete-session.notice').inject().useNotice((value) => value)
	check(
		'the restore action refuses instead of counting a call it never made',
		bareNotice?.tone === 'failed' && !String(bareNotice.text).includes('unarchived')
	)

	// The empty state is the reference page's shape: a plate, a two-tone line, a hint.
	listed.length = 0
	sectionInjected.reload()
	await new Promise((resolve) => setTimeout(resolve, 0))
	const emptyPage = JSON.stringify(archivedSection.component(sectionInjected))
	check(
		'an empty archive renders the plate and the two-tone line, not a bare sentence',
		emptyPage.includes('emptyLead') &&
			emptyPage.includes('emptySubject') &&
			emptyPage.includes('emptyHint') &&
			emptyPage.includes('"width":"56px"')
	)

}

/* -------------------------------------------------------------------------- */
/* archived conversation management                                            */
/* -------------------------------------------------------------------------- */


section('listing the archived conversations')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		await seedLog(root, SESSION)
		await seedLog(root, OTHER)
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION, OTHER, THIRD] } },
			archived: [SESSION, OTHER],
			root,
			stored: new Set([SESSION, OTHER, THIRD]),
			sizes: { [SESSION]: 1234, [OTHER]: 42 },
			query: { titles: { [SESSION]: 'First conversation', [OTHER]: 'Second conversation' } },
			controller: {
				items: [
					{ sessionId: SESSION, updatedAt: 1_730_000_000_000, running: false, cwd: '/tmp/project-a' },
					{ sessionId: OTHER, updatedAt: 1_740_000_000_000, running: false, cwd: '/tmp/project-b' },
					{ sessionId: THIRD, updatedAt: 1_750_000_000_000, running: false, cwd: '/tmp/project-c' }
				]
			},
			live: { agents: [SESSION] }
		})

		const entries = await listArchived(host)
		equal('only archived conversations are listed', entries.map((entry) => entry.sessionId), [OTHER, SESSION])
		equal('the newest activity sorts first', entries.map((entry) => entry.updatedAt), [1_740_000_000_000, 1_730_000_000_000])
		equal('titles come from the log-backed title index', entries.map((entry) => entry.title), ['Second conversation', 'First conversation'])
		equal('sizes come from the persistence listing', entries.map((entry) => entry.sizeBytes), [42, 1234])
		equal('working directories come from the session list', entries.map((entry) => entry.cwd), ['/tmp/project-b', '/tmp/project-a'])
		check('a running turn marks its row', entries[1]?.running === true)
		check('an idle row is not marked', entries[0]?.running === false)
		check('a conversation that is not archived never appears', !entries.some((entry) => entry.sessionId === THIRD))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('the archived listing degrades instead of failing')
{
	// No title index, no session list, no sizes: the rows must still arrive, with
	// every unknown field at the value that says "unknown".
	const host = fakeHost({ workspaces: {}, archived: [SESSION, OTHER], omit: ['sessionQuery', 'sessionController'] })
	const entries = await listArchived(host)
	equal('the rows are still listed', entries.length, 2)
	equal('equal timestamps fall back to id order', entries.map((entry) => entry.sessionId), [OTHER, SESSION])
	equal('an unreadable title degrades to empty', entries[0]?.title, '')
	equal('an unreported time degrades to zero', entries[0]?.updatedAt, 0)
	equal('an unreported size degrades to -1', entries[0]?.sizeBytes, -1)
	equal('an unknown working directory degrades to empty', entries[0]?.cwd, '')
	check('an unanswered liveness probe reads as not running', entries[0]?.running === false)

	// A service that exists and throws is the same degradation as one that is absent.
	const throwing = fakeHost({
		workspaces: {},
		archived: [SESSION],
		sizes: { [SESSION]: 7 },
		query: { throws: true },
		controller: { throws: true }
	})
	const quiet = await listArchived(throwing)
	equal('a failing title index costs only the title', quiet[0]?.title, '')
	equal('a failing session list costs only the timestamp', quiet[0]?.updatedAt, 0)
	equal('the size still arrives from the backend', quiet[0]?.sizeBytes, 7)

	// A backend whose service has no `list` at all: probing, not assuming.
	const noList = fakeHost({ workspaces: {}, archived: [SESSION] })
	delete noList.get('sessionPersistence').list
	const bare = await listArchived(noList)
	equal('a backend with no listing still lists its conversations', bare.length, 1)
	equal('it reports the size as unknown', bare[0]?.sizeBytes, -1)

	// A registry is the one thing the listing cannot degrade without.
	const noRegistry = fakeHost({ workspaces: {}, archived: [SESSION], omit: ['workspaceRegistry'] })
	let refused = ''
	try {
		await listArchived(noRegistry)
	} catch (error) {
		refused = message(error)
	}
	check('a Host with no workspace registry refuses to list', refused.includes('workspaceRegistry'), refused)

	// An id that is not a plain identifier can be neither opened nor deleted, so
	// it is not a row.
	const abusive = fakeHost({ workspaces: {}, archived: ['../escape', SESSION] })
	equal('a non-identifier archive entry is not a row', (await listArchived(abusive)).map((entry) => entry.sessionId), [SESSION])
}

section('deleting every archived conversation in one batch')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const sessionLog = await seedLog(root, SESSION)
		const otherLog = await seedLog(root, OTHER)
		const thirdLog = await seedLog(root, THIRD)
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION, OTHER, THIRD] }, 'ws-2': { sessionIds: [SESSION] } },
			archived: [SESSION, OTHER, THIRD],
			projection: { [SESSION]: { asOfSeq: 1 }, [OTHER]: { asOfSeq: 1 }, [THIRD]: { asOfSeq: 1 } },
			root,
			stored: new Set([SESSION, OTHER, THIRD]),
			sizes: { [SESSION]: 100, [OTHER]: 250, [THIRD]: 999 },
			query: { titles: { [SESSION]: 'One', [OTHER]: 'Two', [THIRD]: 'Three' } },
			live: { agents: [THIRD] }
		})

		const summary = await deleteArchived(host)
		equal('every archived conversation was requested', summary.requested, 3)
		equal('the idle ones were deleted', summary.deleted, 2)
		equal('the running one was refused, not failed', summary.refused, 1)
		equal('nothing failed', summary.failed, 0)
		equal('nothing was skipped', summary.skipped, 0)
		equal('one result per entry, in archive order', summary.results.map((result) => result.outcome), ['deleted', 'deleted', 'refused'])
		equal('results carry the titles read before the deletion', summary.results.map((result) => result.title), ['One', 'Two', 'Three'])
		check('the refusal explains itself', summary.results[2]?.reason.includes('a turn is running'), summary.results[2]?.reason)
		equal('a deleted entry has no reason', summary.results[0]?.reason, '')
		equal('the freed bytes are the sizes of the deleted logs', summary.bytesFreed, 350)
		equal('workspace slots are summed over the deleted entries', summary.removed.workspacesReleased, 3)
		equal('both projections were dropped', summary.removed.projectionDropped, 2)
		equal('both logs were removed', summary.removed.logsRemoved, 2)
		check('the deleted logs are gone', !existsSync(sessionLog) && !existsSync(otherLog))
		check('the refused log survives', existsSync(thirdLog))
		equal('the archive set keeps only the refused id', host.__registry.archivedSessionIds, [THIRD])
		equal('the deletion went through the registry', host.__registry.unarchiveCalls, [SESSION, OTHER])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('a batch only ever touches ids from the archive set')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const sessionLog = await seedLog(root, SESSION)
		const thirdLog = await seedLog(root, THIRD)
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION, THIRD] } },
			archived: [SESSION],
			root,
			stored: new Set([SESSION, THIRD]),
			sizes: { [SESSION]: 5, [THIRD]: 5 },
			query: { titles: { [SESSION]: 'Archived one' } }
		})

		const summary = await deleteArchived(host, { sessionIds: [THIRD, SESSION, THIRD] })
		equal('the subset is processed in request order', summary.results.map((result) => result.sessionId), [THIRD, SESSION])
		equal('a repeated id is one entry', summary.requested, 2)
		equal('an id outside the archive set is reported, not deleted', summary.results[0]?.outcome, 'not-archived')
		check('the report says why it was left alone', summary.results[0]?.reason.includes('not in the archive set'), summary.results[0]?.reason)
		equal('the archived one was deleted', summary.results[1]?.outcome, 'deleted')
		equal('the deleted one is counted once', summary.deleted, 1)
		equal('nothing was refused or skipped', [summary.refused, summary.skipped], [0, 0])
		check('the unarchived conversation keeps its log', existsSync(thirdLog))
		check('the archived conversation lost its log', !existsSync(sessionLog))
		equal('the archive set lost exactly the deleted id', host.__registry.archivedSessionIds, [])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('invalid ids are ignored and reported')
{
	const host = fakeHost({
		workspaces: {},
		archived: ['42', SESSION],
		stored: new Set([SESSION]),
		sizes: { [SESSION]: 5 }
	})

	const summary = await deleteArchived(host, { sessionIds: [42, '../escape', null, SESSION] })
	equal('every requested entry is answered', summary.requested, 4)
	equal('the invalid ones are skipped and the valid one deleted', summary.results.map((result) => result.outcome), [
		'skipped',
		'skipped',
		'skipped',
		'deleted'
	])
	check('a skipped entry says why', summary.results[0]?.reason.includes('not a plain session identifier'), summary.results[0]?.reason)
	equal('the entries are labelled as strings', summary.results.map((result) => result.sessionId), ['42', '../escape', 'null', SESSION])
	equal('skipping is counted', summary.skipped, 3)
	// The number 42 must never become the string that names the session "42".
	equal('a non-string id never matches a session of that name', host.__registry.archivedSessionIds, ['42'])
}

section('a cancelled batch stops and reports what it left behind')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const sessionLog = await seedLog(root, SESSION)
		const otherLog = await seedLog(root, OTHER)
		const thirdLog = await seedLog(root, THIRD)
		const abort = new AbortController()
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION, OTHER, THIRD] } },
			archived: [SESSION, OTHER, THIRD],
			projection: { [SESSION]: {}, [OTHER]: {}, [THIRD]: {} },
			root,
			stored: new Set([SESSION, OTHER, THIRD]),
			sizes: { [SESSION]: 5, [OTHER]: 5, [THIRD]: 5 },
			query: { titles: { [SESSION]: 'One', [OTHER]: 'Two', [THIRD]: 'Three' } }
		})
		// The operator cancels while the first deletion is in flight: exactly what
		// closing the page mid-batch does through the route's own signal.
		const registry = host.__registry
		const unarchive = registry.unarchiveSession.bind(registry)
		let released = 0
		registry.unarchiveSession = async (sessionId) => {
			await unarchive(sessionId)
			released += 1
			if (released === 1) abort.abort()
		}

		const summary = await deleteArchived(host, { signal: abort.signal })
		equal('the conversation in flight was deleted', summary.deleted, 1)
		equal('the rest are skipped', summary.skipped, 2)
		equal('a cancellation is not a refusal or a failure', [summary.refused, summary.failed], [0, 0])
		equal('the outcomes stop at the cancellation', summary.results.map((result) => result.outcome), ['deleted', 'skipped', 'skipped'])
		check('a skipped entry names the cancellation', summary.results[1]?.reason.includes('cancelled'), summary.results[1]?.reason)
		equal('the freed bytes cover only the deleted log', summary.bytesFreed, 5)
		check('the first log is gone', !existsSync(sessionLog))
		check('the skipped logs survive', existsSync(otherLog) && existsSync(thirdLog))
		equal('the archive set keeps the skipped ids', host.__registry.archivedSessionIds, [OTHER, THIRD])

		// A signal that was already aborted deletes nothing at all.
		const stopped = new AbortController()
		stopped.abort()
		const idle = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION, OTHER] } },
			archived: [SESSION, OTHER],
			root,
			stored: new Set([SESSION, OTHER]),
			sizes: { [SESSION]: 5, [OTHER]: 5 }
		})
		const cancelled = await deleteArchived(idle, { signal: stopped.signal })
		equal('an already-cancelled batch deletes nothing', [cancelled.deleted, cancelled.skipped], [0, 2])
		equal('it still answers for every entry', cancelled.results.length, 2)
		equal('nothing was unarchived', idle.__registry.archivedSessionIds, [SESSION, OTHER])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('a batch reports failures without abandoning the rest')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const sessionLog = await seedLog(root, SESSION)
		const otherLog = await seedLog(root, OTHER)
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION, OTHER] } },
			archived: [SESSION, OTHER],
			projection: { [SESSION]: {}, [OTHER]: {} },
			root,
			stored: new Set([SESSION, OTHER]),
			sizes: { [SESSION]: 11, [OTHER]: 22 },
			query: { titles: { [SESSION]: 'One', [OTHER]: 'Two' } }
		})
		// A backend read that throws escapes `deleteSession` entirely, which is the
		// one path a batch must survive rather than propagate.
		const persistence = host.get('sessionPersistence')
		const stat = persistence.stat.bind(persistence)
		persistence.stat = async (sessionId, options) => {
			if (sessionId === SESSION) throw new Error('the backend is locked')
			return await stat(sessionId, options)
		}

		const summary = await deleteArchived(host, { sessionIds: [SESSION, OTHER] })
		equal('the throwing entry is reported as failed', summary.results[0]?.outcome, 'failed')
		check('the failure carries its cause', summary.results[0]?.reason.includes('the backend is locked'), summary.results[0]?.reason)
		equal('the batch continued to the next entry', summary.results[1]?.outcome, 'deleted')
		equal('failed and deleted are counted apart', [summary.failed, summary.deleted], [1, 1])
		check('the failed conversation is still archived', host.__registry.archivedSessionIds.includes(SESSION))
		check('the failed conversation keeps its log', existsSync(sessionLog))
		check('the deleted conversation lost its log', !existsSync(otherLog))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

section('a kept transcript is not reported as freed space')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		const sessionLog = await seedLog(root, SESSION)
		const host = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION] } },
			archived: [SESSION],
			root,
			stored: new Set([SESSION]),
			sizes: { [SESSION]: 4096 }
		})

		const summary = await deleteArchived(host, { sessionIds: [SESSION], deleteLog: false })
		equal('the conversation is still deleted', summary.deleted, 1)
		equal('no log was removed', summary.removed.logsRemoved, 0)
		equal('nothing is claimed as freed while the log is kept', summary.bytesFreed, 0)
		check('the transcript is still on disk', existsSync(sessionLog))
		equal('the archive entry is gone', host.__registry.archivedSessionIds, [])

		const noRegistry = fakeHost({ workspaces: {}, archived: [SESSION], omit: ['workspaceRegistry'] })
		let refused = ''
		try {
			await deleteArchived(noRegistry)
		} catch (error) {
			refused = message(error)
		}
		check('a Host with no workspace registry refuses the batch', refused.includes('workspaceRegistry'), refused)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

/* -------------------------------------------------------------------------- */
/* the route: the contract the browser half reads                              */
/* -------------------------------------------------------------------------- */

/**
 * A fake Host context that mounts the real route handler.
 *
 * The route is a wire contract, so it is exercised through `apply()` rather
 * than by calling the service: a renamed JSON key, or a dispatch that answers
 * 500 where it should answer 404, would otherwise only show up in the running
 * app, on the one page that cannot be reloaded into a working state.
 */
function fakeWebHost(base, { admit = { principal: {} } } = {}) {
	const provided = {}
	const routes = []
	const ctx = {
		get: (name) => provided[name] ?? base.get(name),
		provide: (key, service) => {
			provided[key] = service
		},
		effect: (callback) => {
			callback()
		},
		connection: { admit: () => admit },
		webServer: {
			register: (route) => {
				routes.push(route)
				return () => {}
			}
		}
	}
	return { ctx, routes }
}

/** One request against the mounted route, answered as the browser would see it. */
async function request(routes, { method, url, body }) {
	const chunks = body === undefined ? [] : [Buffer.from(body)]
	const req = {
		method,
		url,
		headers: {},
		destroy() {},
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk
		}
	}
	let settle
	const done = new Promise((resolve) => {
		settle = resolve
	})
	const res = {
		status: 0,
		text: '',
		writableEnded: false,
		writeHead(status) {
			this.status = status
			return this
		},
		end(text) {
			this.text = text ?? ''
			this.writableEnded = true
			settle(this)
		},
		on() {}
	}
	await routes[0].handler(req, res)
	await done
	let parsed
	try {
		parsed = JSON.parse(res.text)
	} catch {
		parsed = undefined
	}
	return { status: res.status, text: res.text, body: parsed }
}

section('the archived routes answer the contract the browser half reads')
{
	const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
	try {
		await seedLog(root, SESSION)
		await seedLog(root, OTHER)
		await seedLog(root, THIRD)
		const base = fakeHost({
			workspaces: { 'ws-1': { sessionIds: [SESSION, OTHER, THIRD] } },
			archived: [SESSION, OTHER, THIRD],
			projection: { [SESSION]: {}, [OTHER]: {}, [THIRD]: {} },
			root,
			stored: new Set([SESSION, OTHER, THIRD]),
			sizes: { [SESSION]: 64, [OTHER]: 128, [THIRD]: 256 },
			query: { titles: { [SESSION]: 'One', [OTHER]: 'Two', [THIRD]: 'Three' } },
			controller: {
				items: [
					{ sessionId: SESSION, updatedAt: 3, running: false, cwd: '/tmp/a' },
					{ sessionId: OTHER, updatedAt: 2, running: false, cwd: '/tmp/b' },
					{ sessionId: THIRD, updatedAt: 1, running: false, cwd: '/tmp/c' }
				]
			}
		})
		const { ctx, routes } = fakeWebHost(base)
		apply(ctx, {})
		equal('the plugin mounts one prefix route', routes.map((route) => `${route.kind} ${route.path}`), ['prefix /_delete-session'])

		const listed = await request(routes, { method: 'GET', url: '/_delete-session/archived' })
		equal('the listing answers 200', listed.status, 200)
		equal('it is an ok answer', listed.body?.ok, true)
		equal('it reports the total', listed.body?.value?.total, 3)
		equal(
			'each entry carries exactly the six contract fields',
			Object.keys(listed.body?.value?.entries?.[0] ?? {}).sort(),
			['cwd', 'running', 'sessionId', 'sizeBytes', 'title', 'updatedAt']
		)
		equal('the entries arrive newest first', listed.body?.value?.entries?.map((entry) => entry.sessionId), [SESSION, OTHER, THIRD])

		// The single-conversation endpoint keeps the response it has always had.
		const single = await request(routes, { method: 'POST', url: '/_delete-session/delete', body: JSON.stringify({ sessionId: THIRD }) })
		equal('a single deletion still answers ok with its report', [single.status, single.body?.ok, single.body?.value?.deleted], [200, true, true])
		equal(
			'its removed block names every step, the rewind snapshots included',
			Object.keys(single.body?.value?.removed ?? {}).sort(),
			['archiveCleared', 'logRemoved', 'projectionDropped', 'rewindRemoved', 'workspacesReleased']
		)
		equal('a clean single deletion reports no residue', single.body?.value?.residue, [])
		const refusedSingle = await request(routes, { method: 'POST', url: '/_delete-session/delete', body: JSON.stringify({ sessionId: THIRD }) })
		equal(
			'a refused single deletion still answers with its own code',
			[refusedSingle.status, refusedSingle.body?.ok, refusedSingle.body?.error?.code],
			[200, false, 'delete-session/refused']
		)

		const batch = await request(routes, { method: 'POST', url: '/_delete-session/delete-all', body: '{}' })
		equal('the batch answers 200', [batch.status, batch.body?.ok], [200, true])
		equal(
			'the summary carries exactly the contract fields',
			Object.keys(batch.body?.value ?? {}).sort(),
			['bytesFreed', 'clean', 'deleted', 'failed', 'refused', 'removed', 'requested', 'residue', 'results', 'skipped']
		)
		equal('it reports every entry', batch.body?.value?.requested, 2)
		equal('both remaining conversations were deleted', batch.body?.value?.deleted, 2)
		equal('clean says nothing was left behind', batch.body?.value?.clean, true)
		equal('the freed bytes are the sizes of the deleted logs', batch.body?.value?.bytesFreed, 192)
		equal(
			'the removed block names every summed step, the rewind snapshots included',
			Object.keys(batch.body?.value?.removed ?? {}).sort(),
			['logsRemoved', 'projectionDropped', 'rewindRemoved', 'workspacesReleased']
		)
		equal('the batch reports no residue', batch.body?.value?.residue, 0)
		equal('one result per entry, with its outcome', batch.body?.value?.results?.map((result) => result.outcome), ['deleted', 'deleted'])
		equal('a result names its conversation and title', [batch.body?.value?.results?.[0]?.sessionId, batch.body?.value?.results?.[0]?.title], [SESSION, 'One'])

		const wrongMethod = await request(routes, { method: 'GET', url: '/_delete-session/delete' })
		equal(
			'the wrong method on a known endpoint is a stable 404',
			[wrongMethod.status, wrongMethod.body?.error?.code],
			[404, 'delete-session/unknown-endpoint']
		)
		const unknown = await request(routes, { method: 'POST', url: '/_delete-session/nope', body: '{}' })
		equal('an unknown endpoint is the same 404', [unknown.status, unknown.body?.error?.code], [404, 'delete-session/unknown-endpoint'])
		const notJson = await request(routes, { method: 'POST', url: '/_delete-session/delete-all', body: 'not json' })
		equal('a body that is not JSON is a 400', [notJson.status, notJson.body?.error?.code], [400, 'delete-session/bad-request'])
		const notObject = await request(routes, { method: 'POST', url: '/_delete-session/delete-all', body: '[]' })
		equal(
			'a non-object body can never mean "delete everything"',
			[notObject.status, notObject.body?.error?.code],
			[400, 'delete-session/bad-request']
		)
		const empty = await request(routes, { method: 'POST', url: '/_delete-session/delete-all' })
		equal('an empty body is refused rather than read as "all"', [empty.status, empty.body?.error?.code], [400, 'delete-session/bad-request'])
		const badIds = await request(routes, { method: 'POST', url: '/_delete-session/delete-all', body: JSON.stringify({ sessionIds: 'all' }) })
		equal('sessionIds must be an array when it is present', [badIds.status, badIds.body?.error?.code], [400, 'delete-session/bad-request'])
		const huge = await request(routes, {
			method: 'POST',
			url: '/_delete-session/delete-all',
			body: JSON.stringify({ sessionIds: ['x'.repeat(1_100_000)] })
		})
		equal('the batch body cap still refuses with 413', [huge.status, huge.body?.error?.code], [413, 'delete-session/too-large'])

		const denied = fakeWebHost(base, { admit: { rejection: 401 } })
		apply(denied.ctx, {})
		const deniedAnswer = await request(denied.routes, { method: 'GET', url: '/_delete-session/archived' })
		equal('an unadmitted request is answered by the fence', [deniedAnswer.status, deniedAnswer.text], [401, 'unauthorized'])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

/* -------------------------------------------------------------------------- */
/* summary                                                                     */
/* -------------------------------------------------------------------------- */

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
	for (const failure of failures) console.log(`  - ${failure}`)
	process.exitCode = 1
}
