/**
 * The Host faces this plugin uses, described structurally.
 *
 * Nothing here is imported from a Host package: the plugin has no runtime
 * dependency on one beyond the Cordis services it is handed, so every context,
 * service, and route face it touches is described by the minimum it actually
 * reads. A shape that drifts from the real Host therefore shows up as a type
 * error here, at the access, instead of as a crash in a running composition.
 *
 * The file is a declaration file on purpose: it carries no runtime code, and a
 * `.d.ts` keeps the build from emitting an empty module for it.
 * @module dsh-delete-session/types
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export type { IncomingMessage, ServerResponse }

/* -------------------------------------------------------------------------- */
/* context                                                                     */
/* -------------------------------------------------------------------------- */

/** A Cordis callable logger; only its optional `warn` is read here. */
export interface Logger {
	readonly warn?: (text: string) => unknown
}

/** Every service this plugin reads through `ctx.get()`, under the keys it uses. */
export interface HostServices {
	/** The workspace registry: its archive set and its workspace records. */
	workspaceRegistry: WorkspaceRegistry
	/** The open storage domains. */
	storageDomain: StorageDomainService
	/** The session persistence backend. */
	sessionPersistence: SessionPersistence
	/** The Host's live session store. */
	sessions: SessionStore
	/** The live agent registry. */
	agents: AgentService
	/** The log-backed title index. */
	sessionQuery: SessionQueryService
	/** The service behind the shipped session list: the app's own activity clock. */
	sessionController: SessionControllerService
	/** The service this plugin itself provides. */
	deleteSession: DeleteSessionApi
}

/**
 * The Host context faces the deletion uses.
 *
 * `get` is the only way to reach a service this plugin does not declare, and it
 * answers `undefined` rather than throwing when a deployment composes a subset,
 * so every access to an optional service is written as one.
 */
export interface ServiceContext {
	/** Read one service; `undefined` when this Host does not provide it. */
	get<K extends keyof HostServices>(key: K): HostServices[K] | undefined
	/** Register one service under this fiber's effect. */
	provide<K extends keyof HostServices>(key: K, service: HostServices[K]): void
	/** Own one setup step through the fiber, disposed with the plugin. */
	effect(callback: () => unknown, name?: string): void
	/**
	 * Emit one Host event, or absent on a context that publishes none.
	 *
	 * Cordis dispatches an emitted event to the listeners of the emitting
	 * context and of its ancestors, which is how one plugin's event reaches
	 * another package's relay: the session controller pushes its own
	 * `api-session/*` events exactly this way.
	 */
	emit?(event: string, ...args: unknown[]): unknown
	/** The Cordis logger; `warn` is not guaranteed to exist. */
	readonly logger?: Logger
}

/**
 * The Host context `apply` receives.
 *
 * `inject` declares `connection` and `webServer`, so both are present by the
 * time this plugin runs and may be read as properties.
 */
export interface WebHostContext extends ServiceContext {
	/** The trust and authentication decision this route reuses. */
	readonly connection: ConnectionService
	/** The route table this plugin mounts into. */
	readonly webServer: WebServerService
}

/* -------------------------------------------------------------------------- */
/* services                                                                    */
/* -------------------------------------------------------------------------- */

/** The `workspace` domain: the durable workspace accounting table. */
export interface WorkspaceStorageDomain {
	/** The accounting records, keyed by workspace id. */
	table(name: 'workspaces'): StorageTable<WorkspaceRecord> | undefined
}

/** The `session_projcache` domain: one checkpoint per session. */
export interface ProjectionStorageDomain {
	/** The persisted projections, keyed by session id. */
	table(name: 'sessions'): StorageTable<unknown> | undefined
}

/** `ctx.get('storageDomain')`: the two domains the deletion opens. */
export interface StorageDomainService {
	/** The domain `dsh-workspace` opens. */
	get(name: 'workspace'): WorkspaceStorageDomain | undefined
	/** The domain `dsh-session-projection-cache` opens. */
	get(name: 'session_projcache'): ProjectionStorageDomain | undefined
}

/** One table of an open storage domain. */
export interface StorageTable<Row> {
	/** Every row, keyed by id. */
	entries(): Iterable<[string, Row]>
	/** Remove one row, reporting whether it was there. */
	delete(key: string): Promise<boolean>
}

/** One durable workspace record. */
export interface WorkspaceRecord {
	/** The sessions this workspace accounts for. */
	readonly sessionIds: string[]
}

/** One workspace: the accounting slots the deletion releases. */
export interface WorkspaceEntity {
	/** The workspace id. */
	readonly id: string
	/** The sessions this workspace accounts for. */
	readonly sessionIds: readonly string[]
	/** Release one session's slot. */
	detachSession(sessionId: string): Promise<void>
}

/**
 * The workspace registry.
 *
 * Its archive set is an in-memory cache refreshed only through the registry's
 * own write path, which is why the deletion goes through `unarchiveSession`
 * instead of editing the domain.
 */
export interface WorkspaceRegistry {
	/** Every archived session id, cached in memory. */
	readonly archivedSessionIds: readonly string[]
	/** Every workspace record. */
	list(): WorkspaceEntity[]
	/** One workspace record, or `undefined` when the id is unknown. */
	get(workspaceId: string): WorkspaceEntity | undefined
	/** Remove one id from the archive set through the registry's serialized write path. */
	unarchiveSession(sessionId: string): Promise<void>
}

/** The session persistence backend; only the JSONL root, one stat, and one list are read. */
export interface SessionPersistence {
	/** Backend configuration; the JSONL backend exposes its root here. */
	readonly config?: { readonly root?: unknown }
	/**
	 * Whether one session is stored.
	 *
	 * Required, not probed: the deletion reads it through the service's own
	 * optional chain, so a backend without one has nothing to degrade to.
	 */
	stat(sessionId: string, options: { readonly signal?: AbortSignal }): Promise<unknown>
	/**
	 * Every stored session, with its physical size when the backend reports one.
	 *
	 * Optional, unlike `stat`: a backend that cannot list still deletes, and the
	 * archive view then loses only its size column. The listing is read through
	 * `list?.()` for exactly that reason.
	 */
	list?(options?: { readonly signal?: AbortSignal }): Promise<readonly SessionPersistenceSnapshot[]>
}

/** One session header, as far as the archived view reads it. */
export interface SessionHeader {
	/** The session id. */
	readonly id: string
	/** Creation time in milliseconds. */
	readonly createdAt: number
	/** The working directory the backend grouped the log under. */
	readonly cwd?: string
}

/**
 * One stored-session observation: its header, plus whatever the backend knows
 * without reading the log. `sizeBytes` is the physical artifact size and is
 * absent for a session that has been created but not materialized.
 */
export interface SessionPersistenceSnapshot {
	/** The stored header. */
	readonly header: SessionHeader
	/** The physical size of the artifact, when the backend reports one. */
	readonly sizeBytes?: number
	/** The number of persisted events, when the backend reports one. */
	readonly eventCount?: number
}

/** The latest title folded from one session's log. */
export interface SessionTitleSnapshot {
	/** The title text. */
	readonly title: string
	/** When that title was last written, in milliseconds. */
	readonly updatedAt: number
}

/** One title observation: the source header, and the title when the log has one. */
export interface SessionTitleObservation {
	/** The header the title was read from. */
	readonly session: SessionHeader
	/** The latest title, or absent when the log carries no title event. */
	readonly title?: SessionTitleSnapshot
}

/**
 * One per-session outcome of a batch title read.
 *
 * Failures stay isolated per session, so one unreadable log costs one title;
 * only cancellation rejects the whole call.
 */
export type SessionTitleObservationResult =
	| { readonly sessionId: string; readonly status: 'fulfilled'; readonly value: SessionTitleObservation }
	| { readonly sessionId: string; readonly status: 'rejected'; readonly reason: unknown }

/**
 * The `sessionQuery` service: the log-backed title index.
 *
 * The batch read is the whole surface used here — {@link SessionQueryService.readTitleSnapshots}
 * already isolates per-session failures, which is the degradation this view
 * wants, and it answers in first-occurrence input order.
 */
export interface SessionQueryService {
	/** Fold the latest title of every requested session in one observation. */
	readTitleSnapshots(sessionIds: readonly string[], signal?: AbortSignal): Promise<readonly SessionTitleObservationResult[]>
}

/** One row of the Host's own session list. */
export interface SessionSummary {
	/** The session id. */
	readonly sessionId: string
	/** Last activity in milliseconds, as the shipped session list computes it. */
	readonly updatedAt: number
	/** Whether a turn is running in that session. */
	readonly running: boolean
	/** The session's working directory. */
	readonly cwd?: string
}

/**
 * The `sessionController` service.
 *
 * It is the Host half of the shipped session list, and its `updatedAt` is the
 * application's own last-activity number (`max(createdAt, lastPromptAt)`).
 * Reading it keeps this view's timestamps identical to the ones the sidebar
 * shows instead of deriving a second, disagreeing clock.
 */
export interface SessionControllerService {
	/** Every visible session row; the archived ones are included, the client filters them. */
	list(request: { readonly cursor?: string }, signal?: AbortSignal): Promise<{ readonly items: readonly SessionSummary[] }>
}

/** One entry in the Host's live session store. */
export interface SessionEntry {
	/** The session id. */
	readonly id: string
}

/**
 * The Host's live session store.
 *
 * `liveEntryFor` and `detachEntered` are the store's own detach path and are
 * not present in every build, so both are optional and probed before use.
 */
export interface SessionStore {
	/** The resident session, or `undefined` when the Host does not hold it. */
	get(sessionId: string): SessionEntry | undefined
	/** The store entry for one session, when this build exposes the detach path. */
	liveEntryFor?(session: SessionEntry): SessionEntry | undefined
	/** Release one store entry, which emits `session/disposed` once. */
	detachEntered?(entry: SessionEntry): void
}

/** The live-agent registry, which is the only liveness source there is. */
export interface AgentService {
	/** The agent for one session, or `undefined` when there is none. */
	get(sessionId: string): Agent | undefined
	/**
	 * Every live agent, or absent on a build that publishes none.
	 *
	 * This is what makes a subagent descendant checkable for liveness at all: a
	 * finished child is simply not in the registry, however loudly its parent's
	 * durable catalog still names it.
	 */
	list?(): readonly Agent[]
}

/** One live agent. */
export interface Agent {
	/** The session it runs. */
	readonly id?: string
	/** `running` means mid-turn, which refuses the deletion. */
	readonly status?: 'idle' | 'running'
	/** The session behind the agent, whose header carries the subagent lineage. */
	readonly session?: {
		readonly header?: {
			/** The session's own id. */
			readonly id?: string
			/** The session this one was spawned from, when it is a subagent. */
			readonly parentSession?: string
			/** `'subagent'` marks a spawned child; a fork carries no origin. */
			readonly origin?: string
		}
	}
}

/* -------------------------------------------------------------------------- */
/* the route                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One admission decision.
 *
 * A rejection carries the HTTP status to answer with; an admitted request
 * carries the principal the fence resolved. The browser half posts with the
 * page's own cookie, so this is the whole authentication story of the route.
 */
export type HostAdmission = { readonly rejection: number } | { readonly principal: unknown }

/** The `connection` service: only its admission decision is used. */
export interface ConnectionService {
	/** Apply the shipped Host/Origin fence and browser-cookie check to one request. */
	admit(request: IncomingMessage): HostAdmission
}

/** The `webServer` service: only route registration is used. */
export interface WebServerService {
	/** Mount one route; the returned disposer unmounts it. */
	register(route: HostRoute): () => void
}

/** One route declaration. */
export interface HostRoute {
	/** `prefix` mounts the handler under `path` for every method. */
	readonly kind: 'prefix'
	/** The route prefix, leading slash included. */
	readonly path: string
	/** The handler; its rejection is the route's problem, not the server's. */
	readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

/* -------------------------------------------------------------------------- */
/* the deletion                                                                */
/* -------------------------------------------------------------------------- */

/** Options one deletion accepts. */
export interface DeleteOptions {
	/** Cancellation from the dispatching caller. */
	signal?: AbortSignal
	/** `false` keeps the conversation log on disk. */
	deleteLog?: boolean
}

/** What one deletion actually removed, step by step. */
export interface DeleteReport {
	/** The id as received, before it was validated. */
	sessionId: unknown
	/** Whether the archive entry could be cleared, which is the deletion itself. */
	deleted: boolean
	/** Whether the session was archived at all. */
	archived: boolean
	/** Whether the backend still had the session stored. */
	wasStored: boolean
	/** How many workspace accounting slots were released. */
	workspacesReleased: number
	/** Whether the archive id was cleared through the registry. */
	archiveCleared: boolean
	/** Whether the log directory was removed. */
	logRemoved: boolean
	/** Whether the rewind plugin's snapshot directory for this session was removed. */
	rewindRemoved: boolean
	/** Whether a persisted projection checkpoint was dropped, verified after the fact. */
	projectionDropped: boolean
	/** Whether the resident session was released. */
	evicted: boolean
	/** Per-step failures; an empty list means the deletion was clean. */
	problems: string[]
	/** Per-step remarks that are not failures. */
	notes: string[]
	/**
	 * Traces the closing audit still found once every removal step had run, one
	 * line each. Empty is the only value that means nothing was left behind: the
	 * removal steps report what they attempted, this reports what is actually
	 * gone, and only this may call a deletion clean.
	 */
	residue: string[]
}

/** The Host service this plugin provides. */
export interface DeleteSessionApi {
	/** Delete one archived conversation and everything the Host keeps for it. */
	delete(sessionId: string, signal?: AbortSignal): Promise<DeleteReport>
	/** List every archived conversation with the metadata the settings page shows. */
	listArchived(signal?: AbortSignal): Promise<ArchivedEntry[]>
	/** Delete archived conversations in one batch. */
	deleteArchived(request: DeleteArchivedRequest, signal?: AbortSignal): Promise<ArchivedDeleteSummary>
}

/* -------------------------------------------------------------------------- */
/* archived conversation management                                            */
/* -------------------------------------------------------------------------- */

/** Options one archived listing accepts. */
export interface ListArchivedOptions {
	/** Cancellation from the dispatching caller. */
	signal?: AbortSignal
}

/**
 * One archived conversation, as the settings page shows it.
 *
 * Every field degrades instead of failing: an unreadable title is empty, an
 * unknown time is `0`, an unknown size is `-1`, and an unanswered liveness
 * probe is "not running". A row with no metadata is still a row that can be
 * deleted, which is the whole point of the view.
 */
export interface ArchivedEntry {
	/** The session id. */
	sessionId: string
	/** The latest title, or an empty string when none could be read. */
	title: string
	/** Last activity in milliseconds, or `0` when no service reports one. */
	updatedAt: number
	/** Physical size in bytes, or `-1` when the backend does not report one. */
	sizeBytes: number
	/** Whether a turn (or running subagents) would refuse a deletion right now. */
	running: boolean
	/** The session's working directory, or an empty string when unknown. */
	cwd: string
}

/** Options one batch deletion accepts. */
export interface DeleteArchivedOptions {
	/** Cancellation from the dispatching caller. */
	signal?: AbortSignal
	/** `false` keeps the conversation logs on disk. */
	deleteLog?: boolean
	/** The subset to delete; omitted means every archived conversation. */
	sessionIds?: readonly unknown[]
}

/** What happened to one entry of a batch deletion. */
export type ArchivedOutcome = 'deleted' | 'refused' | 'failed' | 'skipped' | 'not-archived'

/** One entry of a batch deletion's report. */
export interface ArchivedDeleteResult {
	/** The entry's id, as a label. */
	sessionId: string
	/** The title read before the deletion, or an empty string when none was. */
	title: string
	/** What happened to this entry. */
	outcome: ArchivedOutcome
	/** One human-readable sentence; empty only for a fully clean `deleted`. */
	reason: string
	/**
	 * Traces the closing audit still found for this entry, one line each. A
	 * deleted conversation can carry residue: it is gone from every list, but
	 * bytes remain on disk, and that is the difference between "deleted" and
	 * "deleted cleanly".
	 */
	residue: string[]
}

/** What a batch deletion removed, summed over the entries it deleted. */
export interface ArchivedDeleteRemoved {
	/** Workspace accounting slots released, over all deleted entries. */
	workspacesReleased: number
	/** Deleted entries whose cached projection was dropped. */
	projectionDropped: number
	/** Deleted entries whose log directory was removed. */
	logsRemoved: number
	/** Deleted entries whose rewind snapshot directory was removed. */
	rewindRemoved: number
}

/**
 * The whole outcome of one batch deletion.
 *
 * `requested` is the number of distinct entries the batch acted on and always
 * equals `results.length`; `results` carries one entry per requested id, so a
 * caller can name every conversation that was left behind and why.
 */
export interface ArchivedDeleteSummary {
	/** Distinct entries the batch acted on, including the ones it refused or skipped. */
	requested: number
	/** Entries that were removed. */
	deleted: number
	/** Entries the deletion refused (a running turn, running subagents, no registry write path). */
	refused: number
	/** Entries whose deletion threw. */
	failed: number
	/** Entries left alone: invalid ids, and everything after a cancellation. */
	skipped: number
	/** Bytes of logs actually removed, summed over the deleted entries. */
	bytesFreed: number
	/**
	 * Deleted conversations whose closing audit still found something. They are
	 * gone from every list — this counts residue, not survivors, so it must never
	 * be read as "entries left behind".
	 */
	residue: number
	/** Per-step totals over the deleted entries. */
	removed: ArchivedDeleteRemoved
	/** One result per requested entry, in request order. */
	results: ArchivedDeleteResult[]
}

/** The request one batch deletion accepts from a transport. */
export interface DeleteArchivedRequest {
	/** The subset to delete; omitted means every archived conversation. */
	sessionIds?: readonly unknown[]
}

/** The resolved plugin config; `deleteLog` is the only switch. */
export interface PluginConfig {
	/** `false` keeps the conversation log on disk. */
	readonly deleteLog?: boolean
}
