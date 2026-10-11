/**
 * `dsh-delete-session` — the browser half.
 *
 * One row in a Session's "..." menu: **delete this conversation**, shown only on
 * an archived row, gated behind an acknowledgment, and carried out by the Host
 * over Connection's generic RPC channel. The Host owns the deletion; this half
 * owns the menu entry, the confirmation, and the follow-up refresh.
 *
 * Three rules this file follows, all of them learned the hard way in
 * `plugins/dsh-purge-archived/INCIDENT.md`:
 *
 *   1. It reaches every service through `ctx.get()` and exits quietly when one is
 *      missing. `inject` is not declared at all, because a declared service that
 *      is not there yet parks the entry as `pending` — and the renderer's boot
 *      treats *any* non-active client entry as fatal.
 *   2. It imports only modules the shell already seeds into the platform module
 *      table (`react`, `react/jsx-runtime`, and the UI primitives), so
 *      `dsh.client.external` stays empty and no second copy of anything is
 *      bundled.
 *   3. It declares no Typert Remote and no wire schema, so the loader has no
 *      generated artifact to validate at mount time.
 */

/**
 * The shell's module loader.
 *
 * This file is deliberately *not* a module: the whole file is one `load()` call
 * carrying a factory, so any top-level `import`/`export` would change what is
 * registered. The loader therefore has to be declared, and `factory` receives
 * the loader's own `require` — a name-to-module lookup whose result is `any`,
 * narrowed to a local face at each of the three call sites below.
 */
interface Window {
	__ModuleLoader__: {
		load(entry: {
			readonly id: string
			readonly factory: (require: (name: string) => any) => unknown
		}): void
	}
}

window.__ModuleLoader__.load({
	id: 'dsh-delete-session',
	factory: (require) => {
		const module: { exports: Record<string, unknown> } = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		/** The `react` face this bundle uses. */
		interface ReactModule {
			/**
			 * One piece of component state.
			 *
			 * The setter takes a value or an updater, as React's does: the settings
			 * page keeps one hovered-row id for the whole list, and reading the
			 * previous value is what makes "clear it only if it is still mine" safe
			 * when the pointer moves straight from one row to the next.
			 */
			useState<S>(initial: S | (() => S)): [S, (next: S | ((current: S) => S)) => void]
			useSyncExternalStore<T>(
				subscribe: (listener: () => void) => () => void,
				getSnapshot: () => T,
				getServerSnapshot?: () => T
			): T
			/**
			 * Run one effect after commit, with its cleanup.
			 *
			 * Optional for the same reason every other platform face here is: a React
			 * without it costs the settings page its automatic refresh, never the page.
			 */
			useEffect?(callback: () => void | (() => void), deps: readonly unknown[]): void
		}

		/** `react/jsx-runtime`'s automatic-runtime factories, as this bundle calls them. */
		/**
		 * One seeded primitive: a component the shell owns, rendered with whatever
		 * props this bundle spreads into it.
		 */
		type Primitive = (props: Record<string, unknown>) => unknown

		/**
		 * One renderable: a seeded primitive, or a plain DOM tag name.
		 *
		 * The settings section draws its own structure out of plain tags and keeps
		 * the seeded components for the controls, so both shapes have to reach the
		 * jsx runtime.
		 */
		type Element = Primitive | string

		interface JsxRuntimeModule {
			jsx(type: Element, props: Record<string, unknown>, key?: string): unknown
			jsxs(type: Element, props: Record<string, unknown>, key?: string): unknown
		}

		/**
		 * The seeded UI primitives this bundle renders.
		 *
		 * Everything past the controls this half already shipped is optional on
		 * purpose: each name is reached off the same seeded module and guarded with
		 * `typeof … === 'function'`, so a shell that does not export one costs that
		 * control's styling (or an icon), never the page. `Button`, `Checkbox`,
		 * `Input` and `Pill` are what the shipped settings pages use; the icons
		 * carry the row actions.
		 */
		interface PrimitivesModule {
			MenuItemButton: Primitive
			RiskConfirmation: Primitive
			Toast: Primitive
			Button?: Primitive
			Checkbox?: Primitive
			Input?: Primitive
			Pill?: Primitive
			IconTrashOutlineRegular: Primitive
			IconWarningOutlineRegular: Primitive
			IconArchiveOffOutlineRegular?: Primitive
			IconRefreshOutlineRegular?: Primitive
			IconCloseOutlineRegular?: Primitive
		}

		const react: ReactModule = require('react')
		const { jsx, jsxs }: JsxRuntimeModule = require('react/jsx-runtime')
		const primitives: PrimitivesModule = require('@deepseek-ai/dsh-client-ui-primitives')

		/** Module identity for the slot registration id and the boot graph. */
		const PACKAGE = 'dsh-delete-session'
		/** The Host route this half posts to; the Host half owns the same pair. */
		const CHANNEL = '/_delete-session'
		const ENDPOINT = 'delete'
		/** The archived list the settings section reads. */
		const ENDPOINT_LIST = 'archived'
		/** The bulk deletion the settings section runs. */
		const ENDPOINT_ALL = 'delete-all'
		/** The whole request is one session id, so it may never take long. */
		const TIMEOUT_MS = 30000
		/**
		 * The bulk call walks every archived conversation — registry writes, log
		 * removals, projection drops — so it gets its own, much longer ceiling than
		 * the single-row call. Timing out mid-batch is safe (the deletion is
		 * per-session and idempotent) but it would hide the report the operator
		 * needs, which is why this is not simply the same 30s.
		 */
		const BULK_TIMEOUT_MS = 15 * 60 * 1000
		/**
		 * The empty selection, as one stable object.
		 *
		 * It is handed to `useSyncExternalStore` as a snapshot, so it may not be
		 * rebuilt per call: a fresh `new Set()` every render would be a new identity
		 * every time, which React reads as "the store changed" and would spin.
		 */
		const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>()
		/**
		 * How long archive-membership pushes are coalesced before the settings page
		 * re-reads its list. Long enough to merge one deletion's two writes, short
		 * enough that the page still feels live.
		 */
		const ARCHIVE_DEBOUNCE_MS = 250
		/**
		 * Do nothing, for the effect slot when this React ships no `useEffect`.
		 *
		 * A named no-op rather than a conditional call keeps the hook order identical
		 * on every render, which is the one rule React does enforce.
		 */
		const noEffect = () => {}
		/**
		 * Locale namespace this half owns.
		 *
		 * Copy is *registered with the client's own locale registry* rather than
		 * picked from `navigator.language`: the language the operator chose in
		 * Settings is the one the rest of the UI speaks, and it can differ from the
		 * browser's. Registering also means the switch happens live — the registry
		 * bumps its revision on every change, and the row re-reads through the
		 * locale face below.
		 *
		 * The untyped `register(ns, locale, dict)` form is used deliberately: the
		 * typed form demands a `LocaleNamespaceMap` declaration merge and every
		 * shipped locale in one call, and this half must degrade rather than throw
		 * when a deployment ships a locale it has no dictionary for. A locale with
		 * no dictionary resolves to the key itself, so nothing breaks.
		 */
		const NS = 'dsh-delete-session'

		/* ------------------------------------------------------------------ */
		/* the platform faces this half reads                                  */
		/* ------------------------------------------------------------------ */

		/** One stable translate function per namespace; it resolves the active locale at call time. */
		type Translate = (key: CopyKey, params?: Record<string, string | number>) => string

		/** The locale service's snapshot: the active locale, carrying the registration revision. */
		interface LocaleSnapshot {
			readonly active: string
			readonly revision: number
		}

		/** The client's locale registry, as this half uses it. */
		interface LocaleService {
			/** Publish one dictionary under a namespace; an unknown locale id is the registry's to refuse. */
			register(namespace: string, locale: string, dictionary: Copy): unknown
			/** The namespace's translate function. */
			bind(namespace: string): Translate
			getSnapshot(): LocaleSnapshot
			subscribe(listener: () => void): () => void
		}

		/** One observable face: the subscribe/getSnapshot pair `useSyncExternalStore` takes. */
		interface Observable<T> {
			getSnapshot(): T
			subscribe(listener: () => void): () => void
		}

		/** The workspace list projection; only the archive set is read. */
		interface WorkspaceListSnapshot {
			readonly archivedSessionIds: readonly string[]
		}

		/** The workspace service. */
		interface WorkspacesService {
			readonly list: Observable<WorkspaceListSnapshot>
			/**
			 * Return one archived conversation to the sidebar.
			 *
			 * Unarchiving is the shipped workspace controller's own operation, so the
			 * reversible action goes through the same service the sidebar's archived
			 * view uses: this half never edits the archive set itself, and the
			 * sidebar updates through the controller's normal echo/push path.
			 * Optional — a composition without it simply offers no unarchive control.
			 */
			unarchiveSession?(sessionId: string): Promise<void>
		}

		/**
		 * The client's sessions service — only its list refresh is used.
		 *
		 * `refresh()` is `ClientSessions`' own "re-read the Host baseline, reusing an
		 * in-flight pull". It is the one call that makes the browser drop a row whose
		 * conversation is already gone: a deletion performed by this plugin never
		 * travels through the controller's normal removal path, so no list frame is
		 * pushed for it. (`refreshList` — what an earlier version of this file called
		 * — does not exist on this face; the call was silently a no-op.)
		 */
		interface SessionsService {
			refresh?(): Promise<unknown>
		}

		/** A selector hook: what a binding of `react.useSyncExternalStore` looks like to a component. */
		type SelectorHook<Value> = <Selected>(selector: (value: Value) => Selected) => Selected

		/**
		 * A component as the slot registry sees it.
		 *
		 * The registry spreads the props it decides on — this half's inject face
		 * plus whatever the owner adds — which is not expressible from here, so the
		 * parameter is `never` and each component's own props interface is the
		 * contract.
		 */
		type SlotComponent = (...props: never[]) => unknown

		/** One slot declaration, as the registry takes it. */
		interface SlotDeclaration {
			readonly name: string
			readonly id: string
			readonly order?: number
			/**
			 * The nav row's text, for the one seat that projects one.
			 *
			 * A thunk, not a string: the owner re-reads it on every projection, so
			 * the label follows a live language switch without re-registering.
			 */
			readonly label?: () => string
			/**
			 * The entry's own inject face, called with no arguments: this half only
			 * registers into root-scope list slots, and the renderer appends arguments
			 * (a key, a store) for scoped ones. Whatever the owner knows about the
			 * occurrence — its Session id, its title — arrives as owner props.
			 */
			readonly inject?: () => unknown
		}

		/** The slot registry: registration, deferred until the declaring entry arrives. */
		interface SlotsService {
			/** Re-run the callback once the slot's declaring entry is present. */
			inject(key: string, callback: () => unknown): unknown
			/** Register one entry; the returned disposer unregisters it. */
			register(declaration: SlotDeclaration, component: SlotComponent): () => void
		}

		/** Services this half reads through `ctx.get()`; a deployment may omit any of them. */
		interface BrowserServices {
			slots: SlotsService
			workspaces: WorkspacesService
			locale: LocaleService
			sessions: SessionsService
		}

		/** The context `inject` hands the deferred callback. */
		interface ScopedContext {
			get<K extends keyof BrowserServices>(key: K): BrowserServices[K] | undefined
		}

		/** The browser Cordis context this half is applied with. */
		interface BrowserContext {
			/** Run the callback once every named service is present, and dispose it if they go away. */
			inject(names: readonly (keyof BrowserServices)[], callback: (scoped: ScopedContext) => void): unknown
			/** The client logger; only `warn` is read, and it is not guaranteed to exist. */
			readonly logger?: { readonly warn?: (text: string) => unknown }
		}

		/**
		 * One pending deletion awaiting confirmation.
		 *
		 * The menu row and the settings page share this one confirmation seat, so
		 * the request carries which of the three the operator asked for: `one` names
		 * a Session, `all` walks the Host's whole archive set, `selected` names the
		 * rows that were ticked.
		 */
		interface DeleteRequest {
			readonly kind: 'one' | 'all' | 'selected'
			readonly sessionId?: string
			readonly title?: string
			readonly count?: number
			/** The ticked ids, for `selected`; the Host re-checks each against its archive set. */
			readonly sessionIds?: readonly string[]
		}

		/** One archived conversation as the Host's list reports it. */
		interface ArchivedEntry {
			readonly sessionId: string
			readonly title: string
			/** Last update, epoch ms; `0` when the Host could not read it. */
			readonly updatedAt: number
			/** Log size in bytes; negative when unknown. */
			readonly sizeBytes: number
			/** Whether a turn is running — the deletion refuses those. */
			readonly running: boolean
			readonly cwd: string
		}

		/**
		 * What the settings section reads.
		 *
		 * `null` (the store's initial value) means "never read yet", which is what
		 * makes the first render kick off exactly one request instead of loading at
		 * page boot for an operator who never opens Settings.
		 */
		interface ArchivedListState {
			readonly status: 'loading' | 'ready' | 'error'
			readonly entries: readonly ArchivedEntry[]
			readonly message: string
		}

		/** One entry of a bulk outcome, as the Host reports it. */
		interface BulkResult {
			readonly sessionId: string
			readonly outcome: string
		}

		/** The bulk deletion's summary. */
		interface BulkValue {
			readonly requested?: number
			readonly deleted?: number
			readonly refused?: number
			readonly failed?: number
			readonly skipped?: number
			readonly clean?: boolean
		}

		/** The three outcomes a deletion reports. */
		type NoticeTone = 'done' | 'partial' | 'failed'

		/**
		 * One outcome being reported, with the id that keys its toast.
		 *
		 * `text` carries a finished sentence for outcomes the dictionaries cannot
		 * spell on their own (a bulk run reports counts); when it is absent the
		 * toast falls back to the per-conversation copy.
		 */
		interface Notice {
			readonly id: number
			readonly tone: NoticeTone
			readonly detail: string
			readonly text?: string
		}

		/** The store shape the overlays and `useSyncExternalStore` share. */
		interface Store<T> {
			getSnapshot(): T
			subscribe(listener: () => void): () => void
			set(next: T): void
		}

		/**
		 * One answer from the Host route.
		 *
		 * Every success field is optional and read through guards: `JSON.parse` is
		 * untyped, so a declared shape would be an unchecked claim about a body this
		 * half does not control. `entries` is the archived list; the counts and
		 * `clean` are the bulk report; each member declares the other one absent so
		 * the failure path can read `error` without narrowing.
		 */
		type HostAnswer =
			| {
					readonly ok: true
					readonly value?: {
						readonly clean?: boolean
						readonly entries?: unknown
						/** Host-reported remarks: non-failures the operator should still see. */
						readonly notes?: unknown
						/**
						 * Host-reported residue: traces the closing audit still found
						 * after the deletion, one line each. A deleted conversation can
						 * carry these — it is gone from every list while bytes stay on
						 * disk — so they are what separates "deleted" from "deleted
						 * cleanly", and the notice must name them rather than say
						 * "some files".
						 */
						readonly residue?: unknown
						readonly total?: number
						readonly deleted?: number
						readonly skipped?: number
						readonly refused?: number
						readonly failed?: number
					}
					readonly error?: undefined
			  }
			| { readonly ok: false; readonly value?: undefined; readonly error?: { readonly message?: string } }

		/** What this half injects into the row. */
		interface MenuInjected {
			readonly requestDelete: (sessionId: string) => void
			readonly t: Translate
			readonly useLocale: () => LocaleSnapshot
			readonly useArchived: SelectorHook<ReadonlySet<string>>
		}

		/** The row's props: the owner's own share plus the inject face above. */
		interface DeleteSessionMenuItemProps extends MenuInjected {
			/** The row's Session, supplied by the owner. */
			readonly sessionId: string
			/** The menu's own open state, supplied by the owner. */
			readonly useMenuOpenState: () => [boolean, (open: boolean) => void]
		}

		/** What this half injects into the confirmation overlay. */
		interface ConfirmInjected {
			readonly usePending: SelectorHook<DeleteRequest | null>
			readonly settleDelete: () => void
			readonly confirmDelete: (sessionId: string) => Promise<void>
			readonly confirmDeleteAll: () => Promise<void>
			readonly confirmDeleteSelected: (sessionIds: readonly string[]) => Promise<void>
			readonly t: Translate
			readonly useLocale: () => LocaleSnapshot
		}

		/** What this half injects into the archived-conversation settings section. */
		interface ArchivedSectionInjected {
			readonly useList: SelectorHook<ArchivedListState | null>
			readonly useSelection: SelectorHook<ReadonlySet<string>>
			readonly useQuery: SelectorHook<string>
			readonly setQuery: (query: string) => void
			readonly ensureLoaded: () => void
			readonly reload: () => void
			readonly toggleSelect: (sessionId: string) => void
			readonly setSelection: (sessionIds: readonly string[], selected: boolean) => void
			readonly clearSelection: () => void
			readonly requestDeleteOne: (entry: ArchivedEntry) => void
			readonly requestDeleteAll: () => void
			readonly requestDeleteSelected: () => void
			readonly unarchive: (sessionIds: readonly string[]) => Promise<void>
			/**
			 * Subscribe to the client's own archive membership.
			 *
			 * This page reads a richer list than the browser holds, so it cannot derive
			 * one from a push — but the push is what tells it that its copy is stale.
			 * Returns the unsubscribe.
			 */
			readonly watchArchive: (listener: () => void) => () => void
			/** Whether this composition offers the reversible action at all. */
			readonly canUnarchive: boolean
			readonly t: Translate
			readonly useLocale: () => LocaleSnapshot
		}

		/** What this half injects into the outcome toast. */
		interface NoticeInjected {
			readonly useNotice: SelectorHook<Notice | null>
			readonly dismissNotice: () => void
			readonly t: Translate
			readonly useLocale: () => LocaleSnapshot
		}

		/* ------------------------------------------------------------------ */
		/* copy                                                                */
		/* ------------------------------------------------------------------ */

		/** Keys this namespace defines; the same set in every dictionary. */
		const COPY_KEYS = [
			'menu',
			'title',
			'description',
			'acknowledge',
			'cancel',
			'close',
			'confirm',
			'pending',
			'done',
			'donePartial',
			'failed',
			'nav',
			'sectionTitle',
			'sectionIntro',
			'tabLabel',
			'total',
			'loading',
			'refresh',
			'empty',
			'emptyLead',
			'emptySubject',
			'emptyHint',
			'unavailable',
			'rowDelete',
			'rowRunning',
			'rowUnarchive',
			'searchPlaceholder',
			'noMatches',
			'selectAll',
			'selectedCount',
			'deleteSelected',
			'unarchiveSelected',
			'clearSelection',
			'unarchived',
			'unarchiveFailed',
			'deleteAll',
			'confirmAllTitle',
			'confirmAllDesc',
			'confirmAllLabel',
			'confirmSelectedTitle',
			'confirmSelectedLabel',
			'bulkDone',
			'bulkPartial',
			'bulkResidue',
			'bulkResidueTail',
			'today',
			'yesterday'
		] as const

		/** One copy key, taken from the list above so the two cannot drift. */
		type CopyKey = (typeof COPY_KEYS)[number]

		/** One locale's complete copy table. */
		type Copy = Record<CopyKey, string>

		/**
		 * One dictionary per shipped locale, keyed by its locale id.
		 *
		 * `{n}`-style placeholders follow the registry's own interpolation form,
		 * which the shipped settings pages use too (`t(key, { n })`).
		 */
		const DICTS: Record<string, Copy> = {
			en: {
				menu: 'Delete conversation',
				title: 'Delete this conversation permanently?',
				description: 'The conversation, its transcript on disk, and its cached projections are removed. This cannot be undone.',
				acknowledge: 'I understand this cannot be undone',
				cancel: 'Cancel',
				close: 'Close',
				confirm: 'Delete permanently',
				pending: 'Deleting…',
				done: 'Conversation deleted.',
				donePartial: 'The conversation was removed, but some of its files could not be cleaned up.',
				failed: 'Could not delete the conversation.',
				nav: 'Archived',
				sectionTitle: 'Archived conversations',
				sectionIntro: 'Search, restore, or permanently delete archived conversations.',
				tabLabel: 'Conversations',
				total: '{n} archived conversation(s)',
				loading: 'Loading…',
				refresh: 'Refresh',
				empty: 'No archived conversations.',
				emptyLead: 'No archived',
				emptySubject: 'conversations',
				emptyHint: 'Archive a conversation from the sidebar and it shows up here.',
				unavailable: 'The archived list is unavailable right now.',
				rowDelete: 'Delete',
				rowRunning: 'work is still running — it will be skipped',
				rowUnarchive: 'Unarchive',
				searchPlaceholder: 'Search archived conversations',
				noMatches: 'Nothing matches that search.',
				selectAll: 'Select all',
				selectedCount: '{n} selected',
				deleteSelected: 'Delete selected',
				unarchiveSelected: 'Unarchive selected',
				clearSelection: 'Clear',
				unarchived: 'Restored {n} conversation(s).',
				unarchiveFailed: 'Could not unarchive the conversation.',
				deleteAll: 'Delete all',
				confirmAllTitle: 'Delete all {n} archived conversations?',
				confirmAllDesc: 'Each conversation, its transcript on disk, and its cached projections are removed. This cannot be undone.',
				confirmAllLabel: 'Delete them all',
				confirmSelectedTitle: 'Delete the {n} selected conversation(s)?',
				confirmSelectedLabel: 'Delete selected',
				bulkDone: 'Deleted {n} conversation(s).',
				bulkPartial: 'Deleted {n} conversation(s); {skipped} were left in place.',
				bulkResidue: 'Deleted {n} conversation(s), but {residue} kept files on disk.',
				bulkResidueTail: '{residue} also kept files on disk.',
				today: 'Today',
				yesterday: 'Yesterday'
			},
			zh: {
				menu: '删除会话',
				title: '永久删除这个会话?',
				description: '会话本体、磁盘上的完整记录以及缓存的投影都会被删除。此操作无法撤销。',
				acknowledge: '我明白此操作无法撤销',
				cancel: '取消',
				close: '关闭',
				confirm: '永久删除',
				pending: '正在删除…',
				done: '会话已删除。',
				donePartial: '会话已移除,但部分残留文件未能清理。',
				failed: '无法删除该会话。',
				nav: '归档会话',
				sectionTitle: '归档会话管理',
				sectionIntro: '搜索、恢复或永久删除已归档的会话。',
				tabLabel: '会话',
				total: '共 {n} 个归档会话',
				loading: '正在读取…',
				refresh: '刷新',
				empty: '当前没有归档的会话。',
				emptyLead: '还没有已归档',
				emptySubject: '会话',
				emptyHint: '在侧边栏把会话归档后,它会出现在这里。',
				unavailable: '暂时读不到归档列表。',
				rowDelete: '删除',
				rowRunning: '有工作在跑,会被跳过',
				rowUnarchive: '取消归档',
				searchPlaceholder: '搜索已归档会话',
				noMatches: '没有匹配的会话。',
				selectAll: '全选',
				selectedCount: '已选 {n} 项',
				deleteSelected: '删除选中',
				unarchiveSelected: '取消归档',
				clearSelection: '取消选择',
				unarchived: '已取消归档 {n} 个会话。',
				unarchiveFailed: '取消归档失败。',
				deleteAll: '全部删除',
				confirmAllTitle: '删除全部 {n} 个归档会话?',
				confirmAllDesc: '每个会话的本体、磁盘上的完整记录以及缓存的投影都会被删除。此操作无法撤销。',
				confirmAllLabel: '永久删除全部',
				confirmSelectedTitle: '删除选中的 {n} 个会话?',
				confirmSelectedLabel: '永久删除选中',
				bulkDone: '已删除 {n} 个会话。',
				bulkPartial: '已删除 {n} 个;{skipped} 个被跳过(多半是有回合在跑)。',
				bulkResidue: '已删除 {n} 个会话,但有 {residue} 个残留文件未能清理。',
				bulkResidueTail: '另有 {residue} 个残留文件未能清理。',
				today: '今天',
				yesterday: '昨天'
			}
		}

		/**
		 * Publish this half's dictionaries into the client's locale registry.
		 *
		 * Every failure is swallowed: a locale this build does not ship simply gets
		 * no dictionary, and its keys resolve to themselves. Throwing here would
		 * fail a client entry, which the renderer treats as fatal.
		 * @param locale - The `locale` service.
		 * @returns Resolution after every dictionary that could register has.
		 */
		function registerCopy(locale: LocaleService) {
			for (const [id, dict] of Object.entries(DICTS)) {
				try {
					locale.register(NS, id, dict)
				} catch {
					/* Unknown locale id: leave it to the fallback chain. */
				}
			}
		}

		/**
		 * Build the component-facing copy table from a translate function.
		 *
		 * `t` reads the active locale at call time — the registry hands back one
		 * stable function per namespace — so this must be re-invoked on every
		 * render for the copy to follow a language switch.
		 * @param t - The namespace's translate function.
		 * @returns One string per copy key.
		 */
		function copyOf(t: Translate): Copy {
			const table: Record<string, string> = {}
			for (const key of COPY_KEYS) table[key] = t(key)
			return table
		}

		/* ------------------------------------------------------------------ */
		/* observable helpers                                                  */
		/* ------------------------------------------------------------------ */

		/**
		 * Project one observable into another, recomputing only when the source
		 * snapshot changes identity.
		 * @param source - The observable to project.
		 * @param project - Pure projection of one source snapshot.
		 * @returns The projected observable, subscribing through the source.
		 */
		function derive<S, T>(source: Observable<S>, project: (snapshot: S) => T): Observable<T> {
			let seen: S | undefined
			let value: T | undefined
			return {
				getSnapshot: () => {
					const snapshot = source.getSnapshot()
					if (value === undefined || snapshot !== seen) {
						seen = snapshot
						value = project(snapshot)
					}
					// `project` seeded `value` on the first call, and every later call
					// either returns it or reseeds it; the `undefined` check above cannot
					// tell the checker that, so the invariant is asserted here.
					return value as T
				},
				subscribe: (listener) => source.subscribe(listener)
			}
		}

		/**
		 * Build the `useArchived` selector hook the row subscribes through.
		 *
		 * It mirrors the shape the shipped archive row uses — a `useSelector` over a
		 * Set — because React calls the hook it receives directly. The row's own
		 * `sessionId` is *not* a parameter here: it arrives as an owner prop and the
		 * row passes its own selector, which is the only place that value is needed.
		 * @param archivedSet - Observable archive set.
		 * @returns A selector hook answering whether a row is archived.
		 */
		function bindArchivedHook(archivedSet: Observable<ReadonlySet<string>>): SelectorHook<ReadonlySet<string>> {
			return <Selected>(selector: (archived: ReadonlySet<string>) => Selected): Selected =>
				react.useSyncExternalStore(
					archivedSet.subscribe,
					() => selector(archivedSet.getSnapshot()),
					() => selector(archivedSet.getSnapshot())
				)
		}

		/* ------------------------------------------------------------------ */
		/* the menu row                                                        */
		/* ------------------------------------------------------------------ */

		/**
		 * The "..." menu row. Renders nothing unless the row is archived, so a
		 * normal conversation never grows a delete action, and closes its own menu
		 * before raising the confirmation.
		 * @param props - Owner share plus this plugin's injected behavior.
		 * @returns The menu row, or null.
		 */
		function DeleteSessionMenuItem({ sessionId, useArchived, useMenuOpenState, requestDelete, t, useLocale }: DeleteSessionMenuItemProps) {
			const [, setMenuOpen] = useMenuOpenState()
			useLocale()
			const archived = useArchived((set) => set.has(sessionId))
			if (!archived) return null
			return jsx(primitives.MenuItemButton, {
				separatorBefore: true,
				icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				danger: true,
				onSelect: () => {
					setMenuOpen(false)
					requestDelete(sessionId)
				},
				children: t('menu')
			})
		}

		/* ------------------------------------------------------------------ */
		/* the confirmation dialog                                             */
		/* ------------------------------------------------------------------ */

		/**
		 * The `shell.overlay` entry: the confirmation for whichever deletion is
		 * pending, or nothing. Confirming runs the Host call and reports the
		 * outcome through the same overlay's toast.
		 *
		 * One dialog serves both the menu row and the settings page, so its copy
		 * branches on the request's kind: a bulk run says how many conversations it
		 * is about to walk, because "delete all" without the count is the kind of
		 * confirmation an operator clicks through without reading.
		 * @param props - The pending hook, the three callbacks, and the copy table.
		 * @returns The open dialog, or null.
		 */
		function DeleteSessionConfirm({ usePending, settleDelete, confirmDelete, confirmDeleteAll, confirmDeleteSelected, t, useLocale }: ConfirmInjected) {
			const request = usePending((pending) => pending)
			const [busy, setBusy] = react.useState(false)
			const [acknowledged, setAcknowledged] = react.useState(false)
			useLocale()
			if (request === null) return null
			const copy = copyOf(t)
			const bulk = request.kind !== 'one'
			const selected = request.kind === 'selected'
			const close = () => {
				if (busy) return
				setAcknowledged(false)
				settleDelete()
			}
			return jsx(primitives.RiskConfirmation, {
				open: true,
				title: selected
					? t('confirmSelectedTitle', { n: request.count ?? 0 })
					: bulk
						? t('confirmAllTitle', { n: request.count ?? 0 })
						: copy.title,
				description: bulk ? copy.confirmAllDesc : copy.description,
				acknowledgeLabel: copy.acknowledge,
				cancelLabel: copy.cancel,
				closeLabel: copy.close,
				confirmLabel: busy ? copy.pending : selected ? copy.confirmSelectedLabel : bulk ? copy.confirmAllLabel : copy.confirm,
				acknowledged,
				disabled: busy,
				onAcknowledgedChange: setAcknowledged,
				onCancel: close,
				onConfirm: () => {
					if (busy) return
					setBusy(true)
					const run = selected
						? confirmDeleteSelected(request.sessionIds ?? [])
						: bulk
							? confirmDeleteAll()
							: confirmDelete(request.sessionId ?? '')
					run.then(
						() => {
							setBusy(false)
							setAcknowledged(false)
						},
						() => {
							setBusy(false)
						}
					)
				}
			})
		}

		/* ------------------------------------------------------------------ */
		/* the outcome toast                                                   */
		/* ------------------------------------------------------------------ */

		/**
		 * The `shell.overlay` entry that reports one deletion outcome, then clears
		 * itself through `Toast`'s own hold.
		 *
		 * `tone` has exactly one honoured value in the primitives (`success`, which
		 * draws the check mark); every other outcome is set apart by its icon, which
		 * is what the shipped workspace notices do too. A notice that carries its own
		 * sentence (a bulk run's counts) prints that instead of the per-conversation
		 * copy.
		 * @param props - The notice hook, its dismissal, and the copy table.
		 * @returns The toast, or null.
		 */
		function DeleteSessionNotice({ useNotice, dismissNotice, t, useLocale }: NoticeInjected) {
			const notice = useNotice((value) => value)
			useLocale()
			if (notice === null) return null
			const copy = copyOf(t)
			const failed = notice.tone === 'failed'
			const fallback =
				notice.tone === 'done' ? copy.done : notice.tone === 'partial' ? copy.donePartial : `${copy.failed} ${notice.detail}`
			// The key is the runtime's *third argument*, never a prop: `key` is reserved,
			// so a `key:` inside the props object is dropped without a word — and this
			// Toast has to remount per notice. Its lifetime timer depends only on
			// `holdMs`, so a reused instance would show a second outcome for whatever
			// was left of the first one's hold (sometimes a blink).
			return jsx(
				primitives.Toast,
				{
					text: notice.text !== undefined && notice.text !== '' ? notice.text : fallback,
					tone: failed ? undefined : 'success',
					icon: failed ? jsx(primitives.IconWarningOutlineRegular, {}) : undefined,
					onDone: dismissNotice
				},
				String(notice.id)
			)
		}

		/* ------------------------------------------------------------------ */
		/* the archived-conversation settings section                          */
		/* ------------------------------------------------------------------ */

		/**
		 * Layout for the settings page.
		 *
		 * Every colour comes from the shell's own theme tokens (`--dsw-alias-*`) —
		 * nothing is hardcoded. That is not decoration: this section renders inside
		 * the settings column, so a literal palette would be a second theme to keep
		 * in sync and would break the moment the shell switches between light and
		 * dark. The shape follows the reference product's archived page: a title, a
		 * one-line description, a tab row whose right end carries the destructive
		 * action, a search toolbar, and one bordered card holding the rows or the
		 * empty state.
		 */
		const TONE = {
			error: 'var(--dsw-alias-state-error-primary)',
			warn: 'var(--dsw-alias-state-warn-primary)',
			accent: 'var(--dsw-alias-brand-primary)',
			primary: 'var(--dsw-alias-label-primary)',
			secondary: 'var(--dsw-alias-label-secondary)',
			border: 'var(--dsw-alias-border-l1)',
			borderStrong: 'var(--dsw-alias-border-l2)',
			layer: 'var(--dsw-alias-bg-layer-1)',
			layer2: 'var(--dsw-alias-bg-layer-2)'
		}

		const STYLE: Record<string, Record<string, string | number>> = {
			page: { display: 'flex', flexDirection: 'column' },
			title: { fontSize: '20px', fontWeight: 600, color: TONE.primary, lineHeight: 1.3 },
			intro: { fontSize: '12px', color: TONE.secondary, marginTop: '6px', lineHeight: 1.5 },
			tabRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginTop: '18px' },
			tab: {
				fontSize: '12px',
				color: TONE.primary,
				background: TONE.layer2,
				border: `1px solid ${TONE.border}`,
				borderRadius: '8px',
				padding: '4px 12px'
			},
			tabActions: { display: 'flex', alignItems: 'center', gap: '8px' },
			toolbar: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '14px' },
			search: { flex: 1, minWidth: 0 },
			selectionBar: {
				display: 'flex',
				alignItems: 'center',
				gap: '8px',
				marginTop: '10px',
				padding: '8px 12px',
				borderRadius: '10px',
				border: `1px solid ${TONE.borderStrong}`,
				background: TONE.layer2
			},
			selectionCount: { fontSize: '12px', fontWeight: 600, color: TONE.primary },
			spacer: { flex: 1 },
			card: { border: `1px solid ${TONE.border}`, borderRadius: '12px', overflow: 'hidden', marginTop: '14px' },
			selectRow: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: '10px',
				padding: '9px 12px',
				borderBottom: `1px solid ${TONE.border}`,
				background: TONE.layer
			},
			list: { display: 'flex', flexDirection: 'column' },
			row: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderTop: `1px solid ${TONE.border}` },
			rowMain: { minWidth: 0, flex: 1 },
			rowTitle: { fontSize: '13px', color: TONE.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			rowMeta: {
				fontSize: '11px',
				color: TONE.secondary,
				marginTop: '3px',
				display: 'flex',
				gap: '6px',
				alignItems: 'center',
				flexWrap: 'wrap'
			},
			rowActions: { display: 'flex', alignItems: 'center', gap: '4px' },
			badge: { color: TONE.warn },
			separator: { opacity: 0.6 },
			empty: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', padding: '46px 16px' },
			emptyPlate: {
				width: '56px',
				height: '56px',
				borderRadius: '14px',
				border: `1px solid ${TONE.border}`,
				background: TONE.layer,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				color: TONE.secondary
			},
			emptyLine: { fontSize: '14px', color: TONE.primary },
			emptyAccent: { color: TONE.accent },
			emptyHint: { fontSize: '12px', color: TONE.secondary },
			note: { fontSize: '12px', color: TONE.secondary, lineHeight: 1.6, padding: '18px 12px' },
			errorNote: { fontSize: '12px', color: TONE.error, lineHeight: 1.6, padding: '18px 12px' },
			plain: {
				fontSize: '12px',
				padding: '2px 8px',
				color: TONE.primary,
				background: 'transparent',
				border: `1px solid ${TONE.border}`,
				borderRadius: '8px',
				cursor: 'pointer'
			}
		}

		/**
		 * One seeded icon, or nothing at all.
		 *
		 * Icons are separate exports of the same seeded module, so each is looked up
		 * and skipped when absent: an unknown name must cost an icon, never a render
		 * (an undefined component would reach the jsx runtime as a bad element type).
		 * @param name - The icon export this bundle wants.
		 * @param size - Optional pixel size.
		 * @returns The icon element, or undefined.
		 */
		function iconOf(name: 'IconTrashOutlineRegular' | 'IconArchiveOffOutlineRegular' | 'IconRefreshOutlineRegular' | 'IconCloseOutlineRegular', size?: number) {
			const Icon = primitives[name]
			return typeof Icon === 'function' ? jsx(Icon, size === undefined ? {} : { size }) : undefined
		}

		/**
		 * One action control, preferring the shell's own button.
		 *
		 * `danger` is not a variant the primitive ships, so a destructive control is
		 * marked the way the reference product marks its own: an outline button whose
		 * text, icon and border take the theme's error colour over a faint wash of
		 * that same colour. On a shell without `Button` this degrades to a plain
		 * `<button>` carrying the same colours — the emphasis survives either way.
		 * @param props - Label, handler, and the optional emphasis/disable/icon.
		 * @returns The control.
		 */
		function actionButton(props: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; icon?: unknown; title?: string }) {
			const Button = primitives.Button
			const danger =
				props.danger === true
					? { color: TONE.error, borderColor: TONE.error, background: `color-mix(in srgb, ${TONE.error} 12%, transparent)` }
					: {}
			const shared: Record<string, unknown> = {
				disabled: props.disabled === true,
				onClick: props.onClick,
				...(props.title === undefined ? {} : { title: props.title }),
				...(props.icon === undefined ? {} : { icon: props.icon }),
				children: props.label
			}
			if (typeof Button === 'function') return jsx(Button, { variant: 'outline', size: 'sm', ...shared, style: danger })
			return jsx('button', { type: 'button', ...shared, style: { ...STYLE.plain, ...danger } })
		}

		/**
		 * One checkbox, preferring the shell's own.
		 *
		 * The primitive hands back a boolean; a plain `<input>` hands back an event,
		 * so the fallback adapts instead of leaking the difference into the caller.
		 * @param checked - Whether the box is ticked.
		 * @param onChange - Called with the next state.
		 * @param label - The accessible name.
		 * @returns The control.
		 */
		function checkBox(checked: boolean, onChange: (next: boolean) => void, label: string) {
			const Checkbox = primitives.Checkbox
			if (typeof Checkbox === 'function') {
				return jsx(Checkbox, { checked, onChange: (next: unknown) => onChange(next === true), label, title: label })
			}
			return jsxs('label', { style: STYLE.selectionCount, children: [
				jsx('input', {
					type: 'checkbox',
					checked,
					onChange: (event: { target?: { checked?: unknown } }) => onChange(event?.target?.checked === true)
				}),
				jsx('span', { children: label })
			]})
		}

		/**
		 * The archived page's search-field height, in px.
		 *
		 * 36 is this design system's medium control height (`Button.md`); the `Input`
		 * primitive ships 32 and offers no size prop, which is the whole reason the
		 * override below exists. The width rule is the same story: the wrapper is an
		 * `inline-flex` box sized by the input's `size` attribute, so it does not
		 * stretch to the row on its own.
		 */
		const SEARCH_HEIGHT_PX = 36
		/** Class carried by the search field's wrapper, so the rule below stays scoped. */
		const SEARCH_CLASS = 'dsh-delete-session-search'
		/** The single rule that makes the search field a comfortable size. */
		const SEARCH_CSS = `.${SEARCH_CLASS}{height:${String(SEARCH_HEIGHT_PX)}px !important;width:100% !important}`

		/**
		 * The search field, preferring the shell's own input.
		 * @param query - Current text.
		 * @param onQuery - Called with the next text.
		 * @param placeholder - Placeholder and accessible name.
		 * @returns The field.
		 */
		function searchField(query: string, onQuery: (next: string) => void, placeholder: string) {
			const Input = primitives.Input
			const onChange = (event: { target?: { value?: unknown } }) => {
				onQuery(typeof event?.target?.value === 'string' ? event.target.value : '')
			}
			const base = { value: query, onChange, placeholder, 'aria-label': placeholder }
			// The flex container is ours, not a style handed to `Input`: that primitive
			// forwards everything to the inner <input> and keeps its own wrapper span,
			// so a `flex` passed to it would size the input inside a shrink-to-fit
			// parent and the field would never fill the row.
			if (typeof Input === 'function') {
				return jsxs('div', {
					style: STYLE.search,
					children: [
						// One scoped rule, because the wrapper is the only box the height can
						// be changed on and it takes no style prop — `className` is the one
						// handle it exposes. `!important` is deliberate: the primitive's
						// stylesheet is injected by its own module, and which of the two rules
						// the cascade sees last is not something this half controls.
						jsx('style', { children: SEARCH_CSS }),
						jsx(Input, { ...base, className: SEARCH_CLASS })
					]
				})
			}
			return jsx('input', { type: 'search', ...base, style: { ...STYLE.plain, ...STYLE.search, height: `${String(SEARCH_HEIGHT_PX)}px` } })
		}

		/**
		 * A byte count an operator can read. Negative means the Host could not
		 * measure the log, which is reported as nothing rather than as "0 B".
		 * @param bytes - Log size, or negative when unknown.
		 * @returns The size, or an empty string.
		 */
		function formatSize(bytes: number) {
			if (!Number.isFinite(bytes) || bytes < 0) return ''
			if (bytes < 1024) return `${String(bytes)} B`
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
		}

		/**
		 * A timestamp an operator can scan: the clock for today, the clock behind
		 * "yesterday", the date before that. `0` means unknown and renders as nothing.
		 * @param ms - Epoch milliseconds, or 0.
		 * @param copy - The active copy table, for the day words.
		 * @returns The formatted time, or an empty string.
		 */
		function formatTime(ms: number, copy: Copy) {
			if (!Number.isFinite(ms) || ms <= 0) return ''
			const at = new Date(ms)
			const now = new Date()
			const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
			if (at.toDateString() === now.toDateString()) return `${copy.today} ${clock}`
			if (at.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return `${copy.yesterday} ${clock}`
			try {
				return at.toLocaleDateString()
			} catch {
				return at.toISOString().slice(0, 10)
			}
		}

		/**
		 * Interleave rendered parts with separators, dropping the empty ones so the
		 * line never shows a dangling dot.
		 * @param parts - Rendered pieces, any of which may be null.
		 * @returns The pieces and their separators.
		 */
		function withSeparators(parts: readonly unknown[]) {
			const out: unknown[] = []
			for (const part of parts) {
				if (part === null || part === undefined) continue
				if (out.length > 0) out.push(jsx('span', { style: STYLE.separator, children: '·' }))
				out.push(part)
			}
			return out
		}

		/**
		 * The row's meta line: when it was last touched, how big its log is, and —
		 * in the warning colour — whether the deletion will refuse it.
		 * @param entry - The archived conversation.
		 * @param copy - The active copy table.
		 * @returns The meta line's children.
		 */
		function metaParts(entry: ArchivedEntry, copy: Copy) {
			const time = formatTime(entry.updatedAt, copy)
			const size = formatSize(entry.sizeBytes)
			return withSeparators([
				time === '' ? null : jsx('span', { children: time }),
				size === '' ? null : jsx('span', { children: size }),
				entry.running ? jsx('span', { style: STYLE.badge, children: copy.rowRunning }) : null
			])
		}

		/**
		 * A readable stand-in for a conversation whose title the Host could not read.
		 *
		 * Ids are `session-<uuid>`: the prefix distinguishes nothing, so the label
		 * shows the segment after it — the part that actually tells two rows apart.
		 * @param entry - The archived conversation.
		 * @returns The title, or that short id.
		 */
		function rowLabel(entry: ArchivedEntry) {
			const title = entry.title.trim()
			if (title !== '') return title
			return `${entry.sessionId.replace(/^session-/, '').slice(0, 8)}…`
		}

		/**
		 * The card's empty state, shaped after the reference product's: a plate with
		 * the archive mark, then one line whose subject carries the brand accent.
		 * @param copy - The active copy table.
		 * @returns The empty state.
		 */
		function emptyState(copy: Copy) {
			const plate = iconOf('IconArchiveOffOutlineRegular', 22)
			return jsxs('div', { style: STYLE.empty, children: [
				jsx('div', { style: STYLE.emptyPlate, children: plate === undefined ? jsx('span', {}) : plate }),
				jsxs('div', { style: STYLE.emptyLine, children: [
					jsx('span', { children: copy.emptyLead }),
					jsx('span', { style: STYLE.emptyAccent, children: copy.emptySubject })
				]}),
				jsx('div', { style: STYLE.emptyHint, children: copy.emptyHint })
			]})
		}

		/**
		 * The `settings.section` entry: every archived conversation, with search,
		 * multi-select, restore, and deletion.
		 *
		 * The list comes from this plugin's own Host route rather than from a client
		 * store, and that is deliberate: the archive set is authoritative on the Host,
		 * a browser only ever holds the summaries it happens to have loaded, and the
		 * deletion is decided there anyway — so what is listed here is exactly what a
		 * bulk delete walks. Restoring goes the other way, through the shipped
		 * workspace service, because that action belongs to the sidebar's own model.
		 *
		 * The first render asks for the list (the store starts as `null`), which keeps
		 * the request off the page-boot path for an operator who never opens Settings.
		 * @param props - The list/selection/query hooks, the actions, and the copy table.
		 * @returns The section.
		 */
		function ArchivedSection({
			useList,
			useSelection,
			useQuery,
			setQuery,
			ensureLoaded,
			reload,
			toggleSelect,
			setSelection,
			clearSelection,
			requestDeleteOne,
			requestDeleteAll,
			requestDeleteSelected,
			unarchive,
			watchArchive,
			canUnarchive,
			t,
			useLocale
		}: ArchivedSectionInjected) {
			const state = useList((value) => value)
			const selected = useSelection((value) => value)
			const query = useQuery((value) => value)
			const [hovered, setHovered] = react.useState<string | null>(null)
			useLocale()
			// Declared before the loading return below: hooks must run in the same
			// order on every render, and the first render of a cold page returns early.
			//
			// Two ways this page keeps itself current, so 刷新 is an escape hatch
			// rather than the workflow: entering it re-reads (titles, sizes and
			// last-used times move without the archive set changing), and every
			// membership change re-reads again — archiving, restoring or deleting a
			// conversation, from this page, the sidebar, or another window.
			const useEffect = react.useEffect ?? noEffect
			useEffect(() => {
				reload()
				return watchArchive(reload)
			}, [])
			if (state === null) {
				ensureLoaded()
				return jsx('div', { style: STYLE.page, children: jsx('div', { style: STYLE.note, children: t('loading') }) })
			}
			const copy = copyOf(t)
			const busy = state.status === 'loading'
			const needle = query.trim().toLowerCase()
			const visible = needle === '' ? state.entries : state.entries.filter((entry) => `${entry.title} ${entry.sessionId}`.toLowerCase().includes(needle))
			const visibleIds = visible.map((entry) => entry.sessionId)
			const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

			const header = jsxs('div', { children: [
				jsx('div', { style: STYLE.title, children: copy.sectionTitle }),
				jsx('div', { style: STYLE.intro, children: copy.sectionIntro })
			]})

			// The tab row's right end is where the irreversible action lives, exactly
			// as the reference page puts it: reachable in one click, styled so it never
			// reads as an ordinary button.
			const tabRow = jsxs('div', { style: STYLE.tabRow, children: [
				jsx('span', { style: STYLE.tab, children: copy.tabLabel }),
				jsxs('div', { style: STYLE.tabActions, children: [
					actionButton({ label: copy.refresh, disabled: busy, icon: iconOf('IconRefreshOutlineRegular', 14), onClick: reload }),
					actionButton({
						label: copy.deleteAll,
						danger: true,
						disabled: busy || state.entries.length === 0,
						icon: iconOf('IconTrashOutlineRegular', 14),
						onClick: requestDeleteAll
					})
				]})
			]})

			const toolbar = jsx('div', { style: STYLE.toolbar, children: searchField(query, setQuery, copy.searchPlaceholder) })

			// The selection bar only exists while something is ticked, so the page
			// stays calm at rest and turns into a batch surface on demand.
			const selectionBar =
				selected.size === 0
					? null
					: jsxs('div', { style: STYLE.selectionBar, children: [
							jsx('span', { style: STYLE.selectionCount, children: t('selectedCount', { n: selected.size }) }),
							jsx('span', { style: STYLE.spacer, children: '' }),
							canUnarchive
								? actionButton({
										label: copy.unarchiveSelected,
										icon: iconOf('IconArchiveOffOutlineRegular', 14),
										onClick: () => {
											void unarchive([...selected])
										}
									})
								: null,
							actionButton({
								label: copy.deleteSelected,
								danger: true,
								icon: iconOf('IconTrashOutlineRegular', 14),
								onClick: requestDeleteSelected
							}),
							actionButton({ label: copy.clearSelection, icon: iconOf('IconCloseOutlineRegular', 12), onClick: clearSelection })
						]})

			const selectRow = jsxs('div', { style: STYLE.selectRow, children: [
				checkBox(allSelected, (next) => setSelection(visibleIds, next), copy.selectAll),
				jsx('span', { style: STYLE.selectionCount, children: t('total', { n: state.entries.length }) })
			]})

			// Row actions ride the hover state (one id for the whole list, so no row
			// owns React state of its own) and stay visible on a ticked row: a batch
			// selection has to keep showing what it acts on.
			const rows = visible.map((entry, index) =>
				jsxs(
					'div',
					{
						style: index === 0 ? { ...STYLE.row, borderTop: 'none' } : STYLE.row,
						onMouseEnter: () => setHovered(entry.sessionId),
						onMouseLeave: () => setHovered((current) => (current === entry.sessionId ? null : current)),
						children: [
							checkBox(selected.has(entry.sessionId), (next) => setSelection([entry.sessionId], next), rowLabel(entry)),
							jsxs('div', { style: STYLE.rowMain, children: [
								jsx('div', { style: STYLE.rowTitle, title: entry.sessionId, children: rowLabel(entry) }),
								jsx('div', { style: STYLE.rowMeta, children: metaParts(entry, copy) })
							]}),
							jsxs('div', {
								style: {
									...STYLE.rowActions,
									visibility: hovered === entry.sessionId || selected.has(entry.sessionId) ? 'visible' : 'hidden'
								},
								children: [
									canUnarchive
										? actionButton({
												label: copy.rowUnarchive,
												icon: iconOf('IconArchiveOffOutlineRegular', 14),
												onClick: () => {
													void unarchive([entry.sessionId])
												}
											})
										: null,
									actionButton({
										label: copy.rowDelete,
										danger: true,
										icon: iconOf('IconTrashOutlineRegular', 14),
										onClick: () => requestDeleteOne(entry)
									})
								]
							})
						]
					},
					entry.sessionId
				)
			)

			const body = (() => {
				if (state.status === 'error') {
					return jsx('div', { style: STYLE.errorNote, role: 'alert', children: `${copy.unavailable} ${state.message}`.trim() })
				}
				if (state.entries.length === 0) return emptyState(copy)
				if (visible.length === 0) return jsx('div', { style: STYLE.note, children: copy.noMatches })
				return jsxs('div', { style: STYLE.list, children: [selectRow, ...rows] })
			})()

			return jsxs('div', { style: STYLE.page, children: [header, tabRow, toolbar, selectionBar, jsx('div', { style: STYLE.card, children: body })] })
		}

		/* ------------------------------------------------------------------ */
		/* application                                                         */
		/* ------------------------------------------------------------------ */

		/**
		 * Register the menu row and its two overlays.
		 *
		 * Registration is *deferred* through `ctx.inject`, and that is the whole
		 * point of this shape. A client entry materializes early — before the
		 * packages it wants services from have finished activating — so reading
		 * `ctx.get('slots')` directly here returns `undefined`, and an eager
		 * `if (!slots) return` silently drops the entire feature while the page
		 * still boots green. `ctx.inject` runs the callback when the services
		 * actually arrive and disposes it if they go away, which is also how the
		 * shipped `ui-workspace` half waits for the slots and workspace services.
		 *
		 * Nothing here may throw: a client entry that does not reach `active`
		 * fails the whole page boot, so the deferred callback guards its own work.
		 * @param ctx - The browser Cordis context.
		 */
		function apply(ctx: BrowserContext) {
			ctx.inject(['slots', 'workspaces', 'locale'], (scoped) => {
				const slots = scoped.get('slots')
				const workspaces = scoped.get('workspaces')
				const locale = scoped.get('locale')
				if (!slots || !workspaces || !locale) return

				registerCopy(locale)
				const t = locale.bind(NS)
				const archivedSet = derive(workspaces.list, (snapshot) => new Set(snapshot.archivedSessionIds))

				/**
				 * Re-render this half's components when the client's language changes.
				 *
				 * The locale service is already a `useSyncExternalStore`-safe face —
				 * `getSnapshot` returns a reference that is stable between changes and
				 * carries a `revision`, and `subscribe` fires on a language switch and on
				 * late dictionary registration. Defined once per injection so the
				 * subscribe/getSnapshot pair stays referentially stable across renders,
				 * as `useSyncExternalStore` requires; components then read the active
				 * locale through `t`, which resolves it at call time.
				 * @returns Nothing; the subscription is the point.
				 */
				const useLocale = () =>
					react.useSyncExternalStore(
						(listener) => locale.subscribe(listener),
						() => locale.getSnapshot(),
						() => locale.getSnapshot()
					)

			// Overlay state shared by the three registrations below. The request
			// store holds the Session awaiting confirmation; the notice store holds
			// the one outcome being reported. Both are local external stores, so the
			// plugin depends on no module beyond the platform seed table.
			let nextNoticeId = 0
			const requestStore = createStore<DeleteRequest>()
			const noticeStore = createStore<Notice>()
			// The archived list the settings section reads. `null` = never read; see
			// `ArchivedListState` for why that is the first render's trigger.
			const listStore = createStore<ArchivedListState>()
			let listInFlight = false
			// The ticked rows and the search text. Both are local external stores for the
			// same reason the overlays are: no module beyond the platform seed table.
			const selectionStore = createStore<ReadonlySet<string>>()
			const queryStore = createStore<string>()

			/**
			 * Show one outcome. A second outcome replaces the first rather than
			 * queuing, so a burst of deletions cannot stack toasts.
			 * @param tone - `done`, `partial`, or `failed`.
			 * @param detail - Host-supplied diagnostic for a failure.
			 * @param text - A finished sentence to print instead of the per-conversation copy.
			 */
			const notify = (tone: NoticeTone, detail?: string, text?: string) => {
				nextNoticeId += 1
				noticeStore.set({ id: nextNoticeId, tone, detail: detail ?? '', ...(text === undefined ? {} : { text }) })
			}

			/**
			 * Ask the browser's own Session list to re-read the Host baseline.
			 *
			 * Called after every mutation this half performs, because none of them
			 * travels through the controller's removal path: without it the browser
			 * keeps rendering a row for a conversation whose files are already gone,
			 * which reads as "the deletion did not work" even though it did.
			 *
			 * Both failure shapes are swallowed on purpose — the Host is already
			 * correct, so a failed re-read only delays the row's departure, and a
			 * rejected promise here must not escape into the page.
			 */
			const refreshSessionList = () => {
				try {
					// Looked up on every call, never captured when this half was injected:
					// `ctx.get` answers `undefined` for a service whose provider has not
					// activated yet, which is indistinguishable from a wrong name — and a
					// value captured then would stay `undefined` for the life of the page,
					// turning this call into exactly the silent no-op it exists to fix.
					const pending = scoped.get('sessions')?.refresh?.()
					if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') pending.catch(() => {})
				} catch {
					/* The list keeps its cached rows until something else re-reads it. */
				}
			}

			/**
			 * Read the archived list from the Host.
			 *
			 * The last good entries stay on screen while a reload is in flight: the
			 * alternative is the whole section blinking empty on every refresh, and
			 * after a bulk deletion that blink is exactly where the operator is
			 * looking. A failed read replaces them, because a list that may be stale
			 * is worse than an honest error here — the rows carry delete buttons.
			 * @returns Resolution after the store holds the answer.
			 */
			const loadArchived = async () => {
				if (listInFlight) return
				listInFlight = true
				const previous = listStore.getSnapshot()
				listStore.set({ status: 'loading', entries: previous?.entries ?? [], message: '' })
				try {
					const answer = await requestJson(ENDPOINT_LIST, { method: 'GET', timeoutMs: TIMEOUT_MS })
					if (answer.ok === true) {
						const entries = readEntries(answer.value)
						listStore.set({ status: 'ready', entries, message: '' })
						// Drop ticked rows this read no longer reports: a selection that
						// outlives its rows would let a later bulk delete name stale ids.
						const ticked = selectionStore.getSnapshot()
						if (ticked !== null && ticked.size > 0) {
							const alive = new Set(entries.map((entry) => entry.sessionId))
							const next = new Set([...ticked].filter((sessionId) => alive.has(sessionId)))
							if (next.size !== ticked.size) selectionStore.set(next)
						}
					} else {
						listStore.set({ status: 'error', entries: [], message: answer.error?.message ?? '' })
					}
				} catch (error) {
					listStore.set({ status: 'error', entries: [], message: describe(error) })
				} finally {
					listInFlight = false
				}
			}

			/**
			 * Watch the archive membership the client already receives.
			 *
			 * Every browser is pushed the archive set (`workspaces.list`) — that is what
			 * keeps the sidebar's archived view current. This page reads a richer list
			 * from the Host over HTTP (titles, sizes, last-used times), so it cannot be
			 * derived from that push; what the push tells it is that its own copy is now
			 * out of date. Re-reading on that signal is what makes archiving, restoring,
			 * or deleting a conversation appear here without anyone pressing 刷新 —
			 * including changes made from the sidebar, from the row menu, or from
			 * another window.
			 *
			 * Coalesced: one deletion moves the set and the list together, and a restore
			 * moves it once per conversation, so the reader is spared a burst of
			 * identical reads. Only the set's *content* counts — the projection hands
			 * back a new snapshot object on every unrelated workspace change, and
			 * re-reading on those would be pure noise.
			 * @param listener - Called after the membership actually changed.
			 * @returns The unsubscribe, which also cancels a pending read.
			 */
			const watchArchive = (listener: () => void) => {
				const keyOf = () => (workspaces.list.getSnapshot().archivedSessionIds ?? []).join('\u0000')
				let seen = keyOf()
				let timer: ReturnType<typeof setTimeout> | null = null
				const unsubscribe = workspaces.list.subscribe(() => {
					const key = keyOf()
					if (key === seen) return
					seen = key
					if (timer !== null) return
					timer = setTimeout(() => {
						timer = null
						listener()
					}, ARCHIVE_DEBOUNCE_MS)
				})
				return () => {
					unsubscribe()
					if (timer !== null) {
						clearTimeout(timer)
						timer = null
					}
				}
			}

			/**
			 * Ask the Host to delete one archived conversation, then refresh the
			 * browser's own projections so the row leaves every list immediately.
			 *
			 * The call is a plain `fetch` against the Host's own origin: it carries
			 * the browser session cookie the page was admitted with, and answers the
			 * same shape the Host wrote (`{ ok, value }` or `{ ok, error }`). The Host
			 * never trusts this body, so nothing here is a security decision.
			 * @param sessionId - The archived Session.
			 * @returns Resolution after the outcome is reported and the dialog closed.
			 */
			const confirmDelete = async (sessionId: string) => {
				try {
					let outcome: HostAnswer
					try {
						outcome = await requestJson(ENDPOINT, { method: 'POST', body: { sessionId } })
					} catch (error) {
						outcome = { ok: false, error: { message: describe(error) } }
					}
					if (outcome && outcome.ok === true) {
						refreshSessionList()
						void loadArchived()
						// The Host reports a conversation it could not fully release as a
						// note, not a problem — and a note is exactly the difference between
						// "deleted" and "a row may stay until DSH restarts", which the
						// operator must not have to guess. Residue is the stronger case: the
						// conversation is gone from every list while bytes stay on disk, so
						// the notice names what was left rather than saying "some files".
						const notes = stringList(outcome.value?.notes)
						const residue = stringList(outcome.value?.residue)
						notify(
							outcome.value?.clean === false || notes.length > 0 ? 'partial' : 'done',
							'',
							residue.length > 0
								? `${t('donePartial')} ${residue.join(' ')}`
								: notes.length > 0
									? `${t('done')} ${notes.join(' ')}`
									: undefined
						)
						return
					}
					notify('failed', outcome?.error?.message ?? '')
				} finally {
					// The dialog must never outlive its request, whatever happened.
					requestStore.set(null)
				}
			}

			/**
			 * Ask the Host to delete every archived conversation.
			 *
			 * The body is empty on purpose: the Host resolves "all" from its own
			 * archive set, so a list this page rendered a minute ago can never widen
			 * or narrow what is deleted. The answer is a per-conversation report —
			 * a session with a running turn is refused, not silently dropped — and
			 * the counts are what the operator gets told.
			 * @returns Resolution after the outcome is reported and the dialog closed.
			 */
			const confirmDeleteAll = async () => {
				try {
					let outcome: HostAnswer
					try {
						outcome = await requestJson(ENDPOINT_ALL, { method: 'POST', body: {}, timeoutMs: BULK_TIMEOUT_MS })
					} catch (error) {
						outcome = { ok: false, error: { message: describe(error) } }
					}
					if (outcome && outcome.ok === true) {
						refreshSessionList()
						void loadArchived()
						notify(outcome.value?.clean === false ? 'partial' : 'done', '', bulkOutcomeText(outcome.value ?? {}, t))
						return
					}
					notify('failed', outcome?.error?.message ?? '')
				} finally {
					requestStore.set(null)
				}
			}

			const requestDelete = (sessionId: string) => {
				requestStore.set({ kind: 'one', sessionId })
			}

			/**
			 * Return the ticked conversations to the sidebar.
			 *
			 * Sequential and one at a time: each call goes through the shipped
			 * workspace controller, which serializes its own durable writes, and a
			 * failure part-way must leave a report rather than a half-applied batch.
			 * The reversible action is never destructive, so it is the one bulk
			 * operation that does not ask for confirmation.
			 * @param sessionIds - The conversations to restore.
			 * @returns Resolution after the outcome is reported and the list re-read.
			 */
			const unarchive = async (sessionIds: readonly string[]) => {
				if (sessionIds.length === 0) return
				// Count a restore only when one actually happened. Calling an optional
				// method and counting anyway would report "restored N" for a page whose
				// composition never had that call — a success message with nothing
				// behind it. (The controls are hidden in that case, so this is the
				// belt to that suspenders.)
				if (typeof workspaces.unarchiveSession !== 'function') {
					notify('failed', describe(new Error('this build has no workspace unarchive call')))
					return
				}
				let restored = 0
				let failure = ''
				for (const sessionId of sessionIds) {
					try {
						// Read off the service at call time, never through a detached
						// binding: the controller's methods need their receiver.
						await workspaces.unarchiveSession(sessionId)
						restored += 1
					} catch (error) {
						failure = describe(error)
						break
					}
				}
				if (restored > 0) {
					refreshSessionList()
					clearSelection()
					void loadArchived()
				}
				if (failure !== '') notify('failed', failure, restored > 0 ? t('unarchived', { n: restored }) : undefined)
				else if (restored > 0) notify('done', '', t('unarchived', { n: restored }))
			}

			/**
			 * Tick or untick a set of rows at once (the header's select-all, or one row).
			 *
			 * A fresh Set every time: the selection store's snapshot is compared by
			 * identity by `useSyncExternalStore`, so mutating it in place would never
			 * re-render.
			 * @param sessionIds - The rows this action applies to.
			 * @param selected - Whether they become ticked or unticked.
			 */
			const setSelection = (sessionIds: readonly string[], selected: boolean) => {
				const next = new Set(selectionStore.getSnapshot() ?? [])
				for (const sessionId of sessionIds) {
					if (selected) next.add(sessionId)
					else next.delete(sessionId)
				}
				selectionStore.set(next)
			}

			const toggleSelect = (sessionId: string) => {
				setSelection([sessionId], !(selectionStore.getSnapshot()?.has(sessionId) ?? false))
			}

			const clearSelection = () => {
				selectionStore.set(EMPTY_SELECTION)
			}

			/**
			 * Delete exactly the ticked conversations.
			 *
			 * The ids travel as the request's `sessionIds`, and the Host re-checks
			 * each against its archive set — so a row that was restored in another
			 * window between the tick and the confirm is reported as left alone
			 * instead of being deleted on the strength of a stale page.
			 * @param sessionIds - The ticked conversations.
			 * @returns Resolution after the outcome is reported and the dialog closed.
			 */
			const confirmDeleteSelected = async (sessionIds: readonly string[]) => {
				try {
					let outcome: HostAnswer
					try {
						outcome = await requestJson(ENDPOINT_ALL, {
							method: 'POST',
							body: { sessionIds: [...sessionIds] },
							timeoutMs: BULK_TIMEOUT_MS
						})
					} catch (error) {
						outcome = { ok: false, error: { message: describe(error) } }
					}
					if (outcome && outcome.ok === true) {
						refreshSessionList()
						clearSelection()
						void loadArchived()
						notify(outcome.value?.clean === false ? 'partial' : 'done', '', bulkOutcomeText(outcome.value ?? {}, t))
						return
					}
					notify('failed', outcome?.error?.message ?? '')
				} finally {
					requestStore.set(null)
				}
			}

			const requestDeleteSelected = () => {
				const selected = selectionStore.getSnapshot()
				if (selected === null || selected.size === 0) return
				requestStore.set({ kind: 'selected', sessionIds: [...selected], count: selected.size })
			}

			// The row's Session id is an owner prop, not part of this face: an entry
			// whose slot is declared at root scope with no store is injected with no
			// arguments at all (the renderer only appends a key for scoped slots), so
			// a face that expected `(standard, hookContext)` would read `undefined`
			// twice while looking authoritative.
			//
			// Visible copy rides the inject face rather than a `t` prop. The renderer
			// spreads owner props LAST, and this slot's owner supplies its own `t`
			// from the ui-workspace namespace — so a `t` bound onto the component
			// arrives as `undefined` here, and reading it throws during render.
			const menuInjected = (): MenuInjected => ({
				requestDelete,
				t,
				useLocale,
				useArchived: bindArchivedHook(archivedSet)
			})

			// One registration per slot, each re-established when the declaring
			// entry is replaced. `slots.inject` waits for that declaration, so this
			// half stays active whether or not the sidebar is composed yet.
			const register = (key: string, options: SlotDeclaration, component: SlotComponent) => {
				try {
					slots.inject(key, () => slots.register(options, component))
				} catch (error) {
					ctx.logger?.warn?.(`${PACKAGE}: could not register into ${key}: ${describe(error)}`)
				}
			}

			register(
				'sidebar.workspaces.session.menu.item',
				{
					name: 'sidebar.workspaces.session.menu.item',
					id: `${PACKAGE}.delete`,
					order: 500,
					inject: menuInjected
				},
				DeleteSessionMenuItem
			)

			register(
				'shell.overlay',
				{
					name: 'shell.overlay',
					id: `${PACKAGE}.confirm`,
					inject: (): ConfirmInjected => ({
						usePending: (selector) => useStore(requestStore, selector),
						settleDelete: () => {
							requestStore.set(null)
						},
						confirmDelete,
						confirmDeleteAll,
						confirmDeleteSelected,
						t,
						useLocale
					})
				},
				DeleteSessionConfirm
			)

			register(
				'shell.overlay',
				{
					name: 'shell.overlay',
					id: `${PACKAGE}.notice`,
					inject: (): NoticeInjected => ({
						useNotice: (selector) => useStore(noticeStore, selector),
						dismissNotice: () => {
							noticeStore.set(null)
						},
						t,
						useLocale
					})
				},
				DeleteSessionNotice
			)

			// The archived-conversation manager, as a Settings page of its own.
			//
			// The id is the *shipped* `archived-sessions`, not one of this package's
			// own, and that is deliberate: `settings.section` projects only `id`,
			// `order`, and `label` — there is no icon to pass — and the shell picks
			// the nav glyph from a closed list of ids it knows, falling back to its
			// own gear for everything else. `archived-sessions` is the id that list
			// reserves for exactly this page, so taking it is what gives the row the
			// archive glyph instead of a gear, with no DOM patching at all. It is
			// also the one id a future shipped page would claim: if DSH ever grows
			// its own archived-sessions section, this registration replaces that
			// cell, and the README records that trade.
			//
			// `label` is the nav row's text and must be a thunk: the shell re-reads
			// it on every projection, so the row follows a live language switch
			// without this half re-registering (which is what the shipped sections
			// and the market's own section rely on too). `order` sits the page after
			// the shipped sections and after the market's, before plugin-contributed
			// ones that ask for the tail.
			register(
				'settings.section',
				{
					name: 'settings.section',
					id: 'archived-sessions',
					order: 45,
					label: () => t('nav'),
					inject: (): ArchivedSectionInjected => ({
						useList: (selector) => useStore(listStore, selector),
						useSelection: (selector) => useStore(selectionStore, (value) => selector(value ?? EMPTY_SELECTION)),
						useQuery: (selector) => useStore(queryStore, (value) => selector(value ?? '')),
						setQuery: (next) => {
							queryStore.set(next)
						},
						ensureLoaded: () => {
							if (listStore.getSnapshot() === null) void loadArchived()
						},
						reload: () => {
							void loadArchived()
						},
						toggleSelect,
						setSelection,
						clearSelection,
						requestDeleteOne: (entry) => {
							requestStore.set({ kind: 'one', sessionId: entry.sessionId, title: entry.title })
						},
						requestDeleteAll: () => {
							requestStore.set({ kind: 'all', count: listStore.getSnapshot()?.entries.length ?? 0 })
						},
						requestDeleteSelected,
						unarchive,
						watchArchive,
						canUnarchive: typeof workspaces.unarchiveSession === 'function',
						t,
						useLocale
					})
				},
				ArchivedSection
			)
			})
		}

		/** Render an unknown thrown value as one line. */
		function describe(error: unknown) {
			return error instanceof Error ? error.message : String(error)
		}

		/**
		 * Call one Host route on this page's own origin.
		 *
		 * `credentials: 'same-origin'` is what carries the browser session cookie;
		 * without it the Host's authentication fence answers 401 before the route
		 * runs. A non-JSON or non-2xx answer is reported as a failure the operator
		 * can read rather than a silent no-op.
		 * @param endpoint - Endpoint under the route prefix.
		 * @param init - Method, optional JSON body, and the ceiling for this call.
		 * @returns The parsed response body.
		 */
		async function requestJson(
			endpoint: string,
			init: { method: string; body?: unknown; timeoutMs?: number }
		): Promise<HostAnswer> {
			const controller = new AbortController()
			const timer = setTimeout(() => {
				controller.abort()
			}, init.timeoutMs ?? TIMEOUT_MS)
			try {
				const response = await fetch(`${CHANNEL}/${endpoint}`, {
					method: init.method,
					...(init.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
					credentials: 'same-origin',
					signal: controller.signal
				})
				const text = await response.text()
				// The Host's own answer: `JSON.parse` is untyped, so the guard below is
				// what keeps the declared shape a checked claim.
				let parsed: HostAnswer | null
				try {
					parsed = JSON.parse(text)
				} catch {
					throw new Error(`the Host answered ${String(response.status)} with no readable body`)
				}
				if (parsed !== null && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return parsed
				throw new Error(`the Host answered ${String(response.status)} in an unexpected shape`)
			} finally {
				clearTimeout(timer)
			}
		}

		/**
		 * Narrow the archived list out of an untyped answer.
		 *
		 * Every field is re-checked: the list decides what the page offers to delete,
		 * so a malformed row must be dropped rather than rendered with `undefined`
		 * in it, and a field the Host could not read arrives as a value this treats
		 * as "unknown" (empty title, `0` time, negative size).
		 * @param value - The answer's success value.
		 * @returns The entries that were well formed.
		 */
		function readEntries(value: { readonly entries?: unknown } | undefined): ArchivedEntry[] {
			const raw = value?.entries
			if (!Array.isArray(raw)) return []
			const entries: ArchivedEntry[] = []
			for (const item of raw) {
				if (item === null || typeof item !== 'object') continue
				const row = item as Record<string, unknown>
				if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
				entries.push({
					sessionId: row.sessionId,
					title: typeof row.title === 'string' ? row.title : '',
					updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
					sizeBytes: typeof row.sizeBytes === 'number' && Number.isFinite(row.sizeBytes) ? row.sizeBytes : -1,
					running: row.running === true,
					cwd: typeof row.cwd === 'string' ? row.cwd : ''
				})
			}
			return entries
		}

		/**
		 * The string members of an untyped field.
		 *
		 * The Host's reports carry arrays of human-readable notes; anything that is
		 * not a string is dropped rather than rendered.
		 * @param value - Candidate.
		 * @returns The strings it contains.
		 */
		function stringList(value: unknown) {
			if (!Array.isArray(value)) return []
			return value.filter((item): item is string => typeof item === 'string' && item !== '')
		}

		/**
		 * A finite number from an untyped field.
		 * @param value - Candidate.
		 * @param fallback - What to use when it is not a finite number.
		 * @returns The number.
		 */
		function numberOr(value: unknown, fallback: number) {
			return typeof value === 'number' && Number.isFinite(value) ? value : fallback
		}

		/**
		 * The sentence one bulk outcome is reported with.
		 *
		 * There are two different reasons a bulk run is not clean, and the shipped
		 * copy only describes one of them: conversations *left in place* (a running
		 * turn, a refusal) and conversations *deleted with residue* (gone from every
		 * list, bytes still on disk). Saying "0 were left in place" about the second
		 * would be true and useless, so residue gets its own sentence — and a run
		 * that both left some behind and left bytes behind reports both counts.
		 * @param value - The Host's bulk answer, untyped.
		 * @param t - The bound translator.
		 * @returns The sentence to show.
		 */
		function bulkOutcomeText(
			value: {
				readonly clean?: boolean
				readonly deleted?: number
				readonly skipped?: number
				readonly refused?: number
				readonly failed?: number
				readonly residue?: unknown
			},
			t: Translate
		) {
			const deleted = numberOr(value.deleted, 0)
			const residue = numberOr(value.residue, 0)
			const skipped = numberOr(value.skipped, 0) + numberOr(value.refused, 0) + numberOr(value.failed, 0)
			if (value.clean !== false) return t('bulkDone', { n: deleted })
			if (skipped === 0 && residue > 0) return t('bulkResidue', { n: deleted, residue })
			if (residue > 0) return `${t('bulkPartial', { n: deleted, skipped })} ${t('bulkResidueTail', { residue })}`
			return t('bulkPartial', { n: deleted, skipped })
		}

		/**
		 * A minimal external store: `useSyncExternalStore` compatible, with the
		 * `set` the overlays drive. Local to this bundle so the plugin depends on
		 * no module beyond the platform seed table.
		 * @returns The store.
		 */
		function createStore<T>(): Store<T | null> {
			let value: T | null = null
			const listeners = new Set<() => void>()
			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener)
					return () => {
						listeners.delete(listener)
					}
				},
				set: (next) => {
					if (Object.is(value, next)) return
					value = next
					for (const listener of [...listeners]) listener()
				}
			}
		}

		/**
		 * Subscribe one selector to a store.
		 * @param store - The store to read.
		 * @param selector - Pure selector over the current value.
		 * @returns The selected value.
		 */
		function useStore<T, S>(store: Store<T>, selector: (value: T) => S): S {
			return react.useSyncExternalStore(
				store.subscribe,
				() => selector(store.getSnapshot()),
				() => selector(store.getSnapshot())
			)
		}

		exports.apply = apply
		return module.exports
	}
})
