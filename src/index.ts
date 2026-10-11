/**
 * `dsh-delete-session` — the Host half.
 *
 * A browser UI cannot unlink a session: `SessionPersistence` is append-only by
 * contract, the projection cache has no eviction, and the JSONL backend has no
 * removal. Deleting therefore has to happen here, and the browser reaches it
 * over the same authenticated transport every other Host call uses.
 *
 * The plugin registers two things and nothing else:
 *
 *   - a Host service, `deleteSession`, carrying the deletion itself, the
 *     archived listing, and the batch deletion;
 *   - one authenticated HTTP route prefix, `/_delete-session`, serving
 *     `POST /delete` (one conversation), `GET /archived` (the authoritative
 *     archived list), and `POST /delete-all` (a batch), each answering with a
 *     JSON report.
 *
 * Two mechanisms were deliberately *not* used, both because a plugin must never
 * be able to fail the Host composition:
 *
 *   - **No Typert Remote.** A Remote needs a matching descriptor on both faces,
 *     and the browser-side descriptor can only come from a generated Typert
 *     artifact — the one thing that crashed this application three times on
 *     2026-09-29 (see `plugins/dsh-purge-archived/INCIDENT.md`). A plain JSON
 *     route needs no wire schema on either side.
 *   - **No `ctx.connection.rpc.handle()`.** It reads well, but it mounts its
 *     route through *Connection's* context (`owner.effect(() =>
 *     owner.webServer.register(route))`), and that context does not declare
 *     `webServer` — Connection reaches the server through its own
 *     `ctx.inject(['webServer'], …)` for `/api`. Calling it throws
 *     `cannot get property "webServer" without inject`, synchronously, inside
 *     the injected child. Registering the route here keeps every service access
 *     on a context that declares what it uses.
 *
 * Authentication is not re-implemented: `ctx.connection.admit(request)` applies
 * the shipped Host/Origin fence and browser-cookie check, so this route is
 * exactly as reachable as `/api` and no more.
 * @module dsh-delete-session
 */

import { deleteArchived as runDeleteAll, deleteSession as runDelete, listArchived as runList, message } from './core.ts'

import type {
	ArchivedDeleteSummary,
	ArchivedEntry,
	DeleteArchivedRequest,
	DeleteReport,
	IncomingMessage,
	PluginConfig,
	ServerResponse,
	ServiceContext,
	WebHostContext
} from './types.js'

/** Cordis plugin name. */
export const name = 'delete-session'

/**
 * Services that must be present before this plugin activates.
 *
 * `connection` owns the trust and authentication decision this route reuses, and
 * `webServer` owns the route table it mounts into. Both are shipped by every Web
 * composition that can show this UI at all. Everything else — the workspace
 * registry, storage domains, session persistence, and the liveness services — is
 * read optionally through `ctx.get()`, so the feature degrades instead of
 * failing the Host composition when a deployment composes a subset.
 */
export const inject = ['connection', 'webServer']

/** The route this plugin owns; the browser half calls `<CHANNEL>/<ENDPOINT>`. */
const CHANNEL = '/_delete-session'
/** The endpoint that deletes one conversation. */
const ENDPOINT = 'delete'
/** The endpoint that lists the archive. */
const LIST_ENDPOINT = 'archived'
/** The endpoint that deletes a batch. */
const BATCH_ENDPOINT = 'delete-all'
/** Cordis service key the deletion is provided under. */
const SERVICE_KEY = 'deleteSession'
/** Request cap for the single-id body `delete` accepts. */
const MAX_BODY_BYTES = 4096
/**
 * Request cap for a batch body, which carries one id per conversation.
 *
 * The single-id cap would refuse a batch of a few dozen archived sessions, so
 * the batch endpoint gets a cap that scales with the archive instead. It is
 * still a hard cap, refused and destroyed at the same point, so no request can
 * make the Host buffer without bound.
 */
const MAX_BATCH_BODY_BYTES = 1_048_576

/** Stable failure codes the browser folds into its own messages. */
const CODES = {
	unavailable: 'delete-session/unavailable',
	unknownEndpoint: 'delete-session/unknown-endpoint',
	badRequest: 'delete-session/bad-request',
	refused: 'delete-session/refused',
	partial: 'delete-session/partial',
	tooLarge: 'delete-session/too-large',
	cancelled: 'delete-session/cancelled'
}

/**
 * The Host service behind the route. Its method is the domain operation an
 * in-process consumer would call; the route is only a carrier for it.
 */
class DeleteSessionService {
	declare ctx: ServiceContext
	declare config: PluginConfig

	/**
	 * @param ctx - Host context.
	 * @param config - Resolved plugin config.
	 */
	constructor(ctx: ServiceContext, config?: PluginConfig) {
		// The two fields are `declare`d above so the emitter writes a class body that
		// is exactly these assignments, which is what the original file had.
		/** Host context, captured for the deletion. */
		this.ctx = ctx
		/** Resolved plugin config; `deleteLog` is the only switch. */
		this.config = config ?? {}
	}

	/**
	 * Delete one archived conversation and everything the Host keeps for it.
	 * @param sessionId - The archived session to delete.
	 * @param signal - Cancellation from the dispatching caller.
	 * @returns The per-step deletion report.
	 */
	async delete(sessionId: string, signal?: AbortSignal): Promise<DeleteReport> {
		return await runDelete(this.ctx, sessionId, { signal, deleteLog: this.config.deleteLog !== false })
	}

	/**
	 * List every archived conversation with the metadata the settings page shows.
	 * @param signal - Cancellation from the dispatching caller.
	 * @returns The archived entries, newest first.
	 */
	async listArchived(signal?: AbortSignal): Promise<ArchivedEntry[]> {
		return await runList(this.ctx, { signal })
	}

	/**
	 * Delete archived conversations in one batch.
	 *
	 * An explicit `deleteLog` in the request wins over the plugin config, and
	 * the transport's own signal always wins over anything the body could carry:
	 * the body is JSON, so it can never name a signal, but the order makes that
	 * a property of the code rather than of the parser.
	 * @param request - The subset to delete; omitted means every archived conversation.
	 * @param signal - Cancellation from the dispatching caller.
	 * @returns The batch summary, including one result per requested entry.
	 */
	async deleteArchived(request: DeleteArchivedRequest = {}, signal?: AbortSignal): Promise<ArchivedDeleteSummary> {
		return await runDeleteAll(this.ctx, { deleteLog: this.config.deleteLog !== false, ...request, signal })
	}
}

/** One JSON reply, never cached. */
function sendJson(res: ServerResponse, status: number, body: unknown) {
	const text = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(text)
	})
	res.end(text)
}

/**
 * Map one deletion report onto the answer the browser reads.
 *
 * A refusal is a decision rather than a transport failure, so it travels as
 * `ok: false` in a 200 body: the browser shows the reason instead of reporting a
 * bare HTTP status.
 * @param report - The deletion report.
 * @returns The response body.
 */
function reportBody(report: DeleteReport) {
	const removed = {
		workspacesReleased: report.workspacesReleased,
		archiveCleared: report.archiveCleared,
		logRemoved: report.logRemoved,
		rewindRemoved: report.rewindRemoved,
		projectionDropped: report.projectionDropped
	}
	if (report.deleted) {
		return {
			ok: true,
			value: {
				sessionId: report.sessionId,
				deleted: true,
				clean: report.problems.length === 0,
				removed,
				notes: report.notes,
				problems: report.problems,
				residue: report.residue
			}
		}
	}
	return {
		ok: false,
		error: {
			code: report.archived ? CODES.partial : CODES.refused,
			message: report.problems[0] ?? 'the conversation could not be deleted',
			details: {
				sessionId: report.sessionId,
				problems: report.problems,
				notes: report.notes,
				residue: report.residue,
				removed
			}
		}
	}
}

/**
 * Map one batch summary onto the answer the browser reads.
 *
 * The wire shape is spelled out field by field rather than spread from the
 * summary: this body is a contract with the browser half, and a field added to
 * the core later must not silently appear on it.
 * @param summary - The batch summary.
 * @returns The response body.
 */
function batchBody(summary: ArchivedDeleteSummary) {
	return {
		ok: true,
		value: {
			requested: summary.requested,
			deleted: summary.deleted,
			refused: summary.refused,
			failed: summary.failed,
			skipped: summary.skipped,
			bytesFreed: summary.bytesFreed,
			// A batch is clean when nothing was left behind. `not-archived` does not
			// count: that conversation was never part of this request's work.
			clean: summary.refused === 0 && summary.failed === 0 && summary.skipped === 0 && summary.residue === 0,
			removed: {
				workspacesReleased: summary.removed.workspacesReleased,
				projectionDropped: summary.removed.projectionDropped,
				logsRemoved: summary.removed.logsRemoved,
				rewindRemoved: summary.removed.rewindRemoved
			},
			residue: summary.residue,
			results: summary.results
		}
	}
}

/**
 * Answer `POST /delete`: one validated, single-conversation deletion.
 * @param ctx - Host context.
 * @param req - The incoming request.
 * @param res - The response.
 */
async function answerDelete(ctx: WebHostContext, req: IncomingMessage, res: ServerResponse) {
	const raw = await readBody(req, res)
	if (raw === undefined) return

	// The Host's own answer; `JSON.parse` is untyped, so the check below is what
	// keeps the declared shape a checked claim.
	let payload: { sessionId?: unknown } | null
	try {
		payload = JSON.parse(raw)
	} catch {
		sendJson(res, 400, {
			ok: false,
			error: { code: CODES.badRequest, message: 'the request body is not JSON', details: {} }
		})
		return
	}

	const sessionId = payload?.sessionId
	if (typeof sessionId !== 'string' || sessionId.length === 0) {
		sendJson(res, 400, {
			ok: false,
			error: { code: CODES.badRequest, message: 'a non-empty sessionId is required', details: {} }
		})
		return
	}

	const service = ctx.get(SERVICE_KEY)
	if (service === undefined) {
		sendJson(res, 503, unavailableBody())
		return
	}

	const signal = abortOnClose(res)
	try {
		sendJson(res, 200, reportBody(await service.delete(sessionId, signal)))
	} catch (error) {
		sendJson(res, 500, {
			ok: false,
			error: {
				code: CODES.refused,
				message: `the deletion failed: ${message(error)}`,
				details: { sessionId }
			}
		})
	}
}

/**
 * Answer `GET /archived`: the authoritative archived list.
 *
 * A failure is an `ok: false` body rather than an empty list, because an empty
 * list is a legitimate answer here — it means the archive is empty — and the
 * settings page must never render a broken read as "nothing is archived".
 * @param ctx - Host context.
 * @param res - The response.
 */
async function answerList(ctx: WebHostContext, res: ServerResponse) {
	const service = ctx.get(SERVICE_KEY)
	if (service === undefined) {
		reply(res, 503, unavailableBody())
		return
	}
	const signal = abortOnClose(res)
	try {
		const entries = await service.listArchived(signal)
		reply(res, 200, { ok: true, value: { total: entries.length, entries } })
	} catch (error) {
		reply(res, 500, failure(signal, `the archived conversations could not be listed: ${message(error)}`))
	}
}

/**
 * Answer `POST /delete-all`: one batch deletion over the archive.
 *
 * Only an explicit JSON object may mean "every archived conversation": an
 * unparseable or non-object body is refused instead of being optimistically
 * read as "delete everything", because this is the one request in the plugin
 * that removes many conversations at once. Within the object, an omitted
 * `sessionIds` means the whole archive, an empty array means nothing, and the
 * entries themselves are validated by the core, which reports invalid and
 * no-longer-archived ones per entry instead of dropping them.
 * @param ctx - Host context.
 * @param req - The incoming request.
 * @param res - The response.
 */
async function answerDeleteAll(ctx: WebHostContext, req: IncomingMessage, res: ServerResponse) {
	const raw = await readBody(req, res, MAX_BATCH_BODY_BYTES)
	if (raw === undefined) return
	if (raw.trim().length === 0) {
		reply(res, 400, {
			ok: false,
			error: {
				code: CODES.badRequest,
				message: 'a JSON object body is required; send {} or omit sessionIds to delete every archived conversation',
				details: {}
			}
		})
		return
	}

	let payload: unknown
	try {
		payload = JSON.parse(raw)
	} catch {
		reply(res, 400, {
			ok: false,
			error: { code: CODES.badRequest, message: 'the request body is not JSON', details: {} }
		})
		return
	}
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		reply(res, 400, {
			ok: false,
			error: {
				code: CODES.badRequest,
				message: 'the request body must be a JSON object such as {"sessionIds": ["…"]}; omit sessionIds to delete every archived conversation',
				details: {}
			}
		})
		return
	}

	const requested = (payload as { sessionIds?: unknown }).sessionIds
	if (requested !== undefined && !Array.isArray(requested)) {
		reply(res, 400, {
			ok: false,
			error: { code: CODES.badRequest, message: 'sessionIds must be an array of session ids when it is present', details: {} }
		})
		return
	}

	const service = ctx.get(SERVICE_KEY)
	if (service === undefined) {
		reply(res, 503, unavailableBody())
		return
	}

	const signal = abortOnClose(res)
	try {
		const summary = await service.deleteArchived(requested === undefined ? {} : { sessionIds: requested }, signal)
		reply(res, 200, batchBody(summary))
	} catch (error) {
		reply(res, 500, failure(signal, `the batch deletion failed: ${message(error)}`))
	}
}

/**
 * Buffer one request body with a hard cap.
 *
 * A session id is the only thing this route accepts, so anything past a few
 * hundred bytes is a malformed caller; the request is destroyed rather than
 * buffered further.
 * @param req - The incoming request.
 * @param res - The response, owned when the cap is exceeded.
 * @param limit - The byte cap for this endpoint.
 * @returns The body text, or undefined when the request was refused.
 */
async function readBody(req: IncomingMessage, res: ServerResponse, limit = MAX_BODY_BYTES): Promise<string | undefined> {
	const refuse = () => {
		sendJson(res, 413, {
			ok: false,
			error: { code: CODES.tooLarge, message: 'the request body is too large', details: {} }
		})
		req.destroy()
		return undefined
	}
	const declared = req.headers['content-length']
	if (typeof declared === 'string' && Number(declared) > limit) return refuse()
	const chunks: Buffer[] = []
	let received = 0
	// `IncomingMessage` is an `AsyncIterable<any>`; a request body here is bytes.
	for await (const chunk of req as AsyncIterable<Buffer>) {
		received += chunk.byteLength
		if (received > limit) return refuse()
		chunks.push(chunk)
	}
	return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one JSON reply, tolerating a client that has already gone away.
 *
 * A tab closed mid-request leaves a destroyed response whose `writeHead` throws;
 * that must not become an exception thrown back into the web server for a reply
 * nobody is left to read.
 * @param res - The response.
 * @param status - The HTTP status.
 * @param body - The JSON body.
 */
function reply(res: ServerResponse, status: number, body: unknown) {
	try {
		sendJson(res, status, body)
	} catch {
		/* The connection is gone; there is nobody left to answer. */
	}
}

/**
 * Cancellation owned by one response.
 *
 * A browser that closes the tab or navigates away mid-request stops the work
 * instead of letting it run to completion into a socket nobody is reading: the
 * deletions already done stay done, and the rest is reported as skipped.
 * @param res - The response being written.
 * @returns The signal to hand to the service call.
 */
function abortOnClose(res: ServerResponse): AbortSignal {
	const abort = new AbortController()
	res.on('close', () => {
		if (!res.writableEnded) abort.abort()
	})
	return abort.signal
}

/**
 * The `ok: false` body for one endpoint failure.
 *
 * Cancellation is reported apart from a failure: when the caller withdrew, a
 * body that reads like the Host broke would be the wrong diagnosis for anyone
 * who does see it.
 * @param signal - The response's cancellation signal.
 * @param description - What failed.
 * @returns The response body.
 */
function failure(signal: AbortSignal, description: string) {
	const cancelled = signal.aborted
	return {
		ok: false,
		error: {
			code: cancelled ? CODES.cancelled : CODES.refused,
			message: cancelled ? `${description} (cancelled)` : description,
			details: {}
		}
	}
}

/**
 * The `ok: false` body for a Host that has not provided the service.
 * @returns The response body.
 */
function unavailableBody() {
	return {
		ok: false,
		error: { code: CODES.unavailable, message: `the ${SERVICE_KEY} service is not active on this Host`, details: {} }
	}
}

/**
 * Report one non-fatal wiring problem to stderr.
 *
 * `ctx.logger` is a callable logger in Cordis 4 whose `warn` is not guaranteed
 * to exist *or* to print, so stderr is the transport that always works. A
 * silently swallowed diagnostic is what made the first attempt at this feature
 * undebuggable.
 * @param ctx - Host context.
 * @param text - The diagnostic.
 */
function report(ctx: ServiceContext, text: string) {
	process.stderr.write(`dsh-delete-session: ${text}\n`)
	try {
		ctx.logger?.warn?.(`delete-session: ${text}`)
	} catch {
		/* the logger itself refused; stderr already reported. */
	}
}

/**
 * Wire the Host half: provide the service, then mount the route.
 *
 * `ctx.provide` — not `ctx.set` — is what registers a new service: Cordis
 * refuses `set` for a name nothing has provided yet. Providing during `apply`
 * owns the registration through this fiber's effect, so the service disappears
 * with the plugin.
 * @param ctx - Host context.
 * @param config - Resolved plugin config; `deleteLog: false` keeps the transcript.
 */
export function apply(ctx: WebHostContext, config?: PluginConfig) {
	try {
		ctx.provide(SERVICE_KEY, new DeleteSessionService(ctx, config))
	} catch (error) {
		report(ctx, `could not provide the ${SERVICE_KEY} service (${message(error)})`)
		return
	}

	// The route is mounted directly so every service access below stays on this
	// plugin's own context, which declares `connection` and `webServer`.
	try {
		ctx.effect(
			() =>
				ctx.webServer.register({
					kind: 'prefix',
					path: CHANNEL,
					handler: async (req, res) => {
						// One guard around the whole dispatch. Each endpoint already
						// answers its own failures; this is the backstop that keeps a
						// rejected promise — an aborted body stream, a reply on a socket
						// that died mid-write — from reaching the web server, which owns
						// a route table and not this plugin's errors.
						try {
							const admission = ctx.connection.admit(req)
							if ('rejection' in admission) {
								res.writeHead(admission.rejection)
								res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
								return
							}

							const endpoint = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(CHANNEL.length + 1)

							// Method and endpoint are matched together, so a legal endpoint
							// reached with the wrong method gets the same stable 404 as an
							// unknown one instead of a 500 from a half-run handler.
							if (endpoint === ENDPOINT && req.method === 'POST') {
								await answerDelete(ctx, req, res)
								return
							}
							if (endpoint === LIST_ENDPOINT && req.method === 'GET') {
								await answerList(ctx, res)
								return
							}
							if (endpoint === BATCH_ENDPOINT && req.method === 'POST') {
								await answerDeleteAll(ctx, req, res)
								return
							}

							sendJson(res, 404, {
								ok: false,
								error: {
									code: CODES.unknownEndpoint,
									message: `this route serves only POST ${CHANNEL}/${ENDPOINT}, GET ${CHANNEL}/${LIST_ENDPOINT}, and POST ${CHANNEL}/${BATCH_ENDPOINT}`,
									details: { endpoint, method: req.method }
								}
							})
						} catch (error) {
							report(ctx, `a ${req.method ?? 'GET'} ${req.url ?? CHANNEL} request failed (${message(error)})`)
							reply(res, 500, {
								ok: false,
								error: { code: CODES.refused, message: `the request failed: ${message(error)}`, details: {} }
							})
						}
					}
				}),
			'delete-session: http route'
		)
	} catch (error) {
		report(ctx, `could not mount the route (${message(error)})`)
	}
}
