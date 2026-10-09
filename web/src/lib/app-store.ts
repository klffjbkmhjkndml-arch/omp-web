/** Global app state: session index, route, preferences, and the per-session store registry. */
import { useSyncExternalStore } from "react";
import type { ImageContent, ModelOption, ProjectInfo, SessionSummary } from "../../../shared/api.ts";
import { API_VERSION } from "../../../shared/api.ts";
import { SessionStore } from "./session-store.ts";
import { api, gateway } from "./ws.ts";

export type Theme = "system" | "light" | "dark";
export type InspectorTab = "info" | "agents" | "files" | "changes";
export type SettingsPage = "general" | "providers" | "archived" | "about";
export type ProjectFilter = "all" | "manual" | "recent";
export type UiFont = "system" | "yahei" | "harmony";
export type CodeFont = "jetbrains" | "cascadia" | "consolas";
export type ColWidth = "narrow" | "normal" | "wide";

const UI_FONTS: Record<UiFont, string> = {
	system: `"Inter", -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`,
	yahei: `"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif`,
	harmony: `"HarmonyOS Sans SC", "MiSans", "Microsoft YaHei UI", "PingFang SC", sans-serif`,
};
const CODE_FONTS: Record<CodeFont, string> = {
	jetbrains: `"JetBrains Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace`,
	cascadia: `"Cascadia Code", "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace`,
	consolas: `Consolas, "Courier New", "Microsoft YaHei UI", monospace`,
};
const COL_WIDTHS: Record<ColWidth, string> = { narrow: "680px", normal: "780px", wide: "960px" };

export interface AppNotice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
}

let noticeSeq = 1;

/** Subset of omp's `ModelInfo` the picker needs. */
interface RawModel {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number | null;
	/** RPC `get_available_models` nests efforts; `omp models --json` gives the list itself. */
	thinking?: { efforts?: string[] } | string[];
}

interface RawModels {
	models?: RawModel[];
}

interface Prefs {
	theme: Theme;
	fontSize: "s" | "m" | "l" | "xl";
	uiFont: UiFont;
	codeFont: CodeFont;
	colWidth: ColWidth;
	/** Browser notification when a turn finishes or needs an answer while the tab is in the background. */
	notify: boolean;
	/** What Enter does while a run is active; Alt+Enter does the other. */
	enterWhileRunning: "steer" | "followUp";
	/** Open the right panel on a newly dispatched subagent. */
	autoOpenAgents: boolean;
	lastProject?: string;
	/** Model + thinking level chosen last time; applied when the next session starts. */
	lastModel?: { provider: string; id: string; level?: string };
	sidebarCollapsed: boolean;
	inspectorOpen: boolean;
	/** Which right-panel page is showing. */
	inspectorTab: InspectorTab;
	collapsedProjects: string[];
	/** Home screen: whether the "最近会话" list is folded away. */
	recentCollapsed: boolean;
	/** Home screen: sessions the user hid from "最近会话" (paths). */
	dismissedRecent: string[];
	/** Models hidden from the pickers, as `provider/id`. */
	hiddenModels: string[];
	/** Sidebar: which projects to list — everything, a hand-picked set, or recently active ones. */
	projectFilter: ProjectFilter;
	/** Days of inactivity after which a project drops out of the "recent" filter. */
	recentDays: number;
	/** Paths picked in the "manual" filter. */
	visibleProjects: string[];
}

function loadPrefs(): Prefs {
	const fallback: Prefs = {
		theme: "system",
		fontSize: "m",
		uiFont: "system",
		codeFont: "jetbrains",
		colWidth: "normal",
		notify: false,
		enterWhileRunning: "steer",
		autoOpenAgents: true,
		sidebarCollapsed: false,
		inspectorOpen: false,
		inspectorTab: "info",
		collapsedProjects: [],
		recentCollapsed: false,
		dismissedRecent: [],
		hiddenModels: [],
		projectFilter: "all",
		recentDays: 7,
		visibleProjects: [],
	};
	try {
		return { ...fallback, ...(JSON.parse(localStorage.getItem("omp-web:prefs") ?? "{}") as Partial<Prefs>) };
	} catch {
		return fallback;
	}
}

/** Last known model list, so the home screen can offer a picker without a session. */
function loadCachedModels(): ModelOption[] {
	try {
		const parsed = JSON.parse(localStorage.getItem("omp-web:models") ?? "[]") as unknown;
		return Array.isArray(parsed) ? (parsed as ModelOption[]) : [];
	} catch {
		return [];
	}
}

class AppStore {
	projects: ProjectInfo[] = [];
	sessions: SessionSummary[] = [];
	/** Sessions hidden from the sidebar (web-only archive). */
	archived: SessionSummary[] = [];
	indexLoaded = false;
	/** Open settings page, or undefined when the settings window is closed. */
	settingsPage: SettingsPage | undefined;
	/** Selected session key (session file path) or undefined for the home composer. */
	route: string | undefined = undefined;
	/** File the "改动" page should show, set by a change card's jump button. */
	inspectFile: string | undefined;
	/** Subagent selected on the right panel's "子代理" page. */
	selectedSubagent: string | undefined;
	/** Toasts that are not tied to one session (rename, export, trash). */
	notices: AppNotice[] = [];
	/** Project chosen for the next new session on the home screen. */
	draftProject: string | undefined;
	prefs: Prefs = loadPrefs();
	models: ModelOption[] = loadCachedModels();
	/** `provider/model` the gateway forces every session onto (test profile); set from `/api/health`. */
	modelLock?: { provider: string; model: string };
	/** API version the running gateway reports; `undefined` when it predates the check. */
	serverApi: number | undefined;
	#staleWarned = false;
	version = 0;
	#listeners = new Set<() => void>();
	#stores = new Map<string, SessionStore>();

	constructor() {
		this.draftProject = this.prefs.lastProject;
		this.route = this.#routeFromHash();
		void this.loadHealth();
		window.addEventListener("hashchange", () => {
			const next = this.#routeFromHash();
			if (next !== this.route) this.#setRoute(next, false);
		});
		gateway.on(msg => {
			if (msg.t === "index") {
				void this.refreshIndex();
				return;
			}
			if (msg.t === "rekey") {
				const store = this.#stores.get(msg.from);
				if (store) {
					this.#stores.delete(msg.from);
					store.key = msg.to;
					this.#stores.set(msg.to, store);
				}
				if (this.route === msg.from) this.#setRoute(msg.to, true);
				return;
			}
			if ("key" in msg) this.#stores.get(msg.key)?.handle(msg);
		});
		this.applyTheme();
	}

	subscribe = (l: () => void) => {
		this.#listeners.add(l);
		return () => this.#listeners.delete(l);
	};
	getVersion = () => this.version;

	emit(): void {
		this.version++;
		for (const l of this.#listeners) l();
	}

	#routeFromHash(): string | undefined {
		const m = location.hash.match(/^#\/s\/(.+)$/);
		return m ? decodeURIComponent(m[1]) : undefined;
	}

	#setRoute(key: string | undefined, replace: boolean): void {
		const prev = this.route;
		this.route = key;
		const hash = key ? `#/s/${encodeURIComponent(key)}` : "#/";
		if (location.hash !== hash) {
			if (replace) history.replaceState(null, "", hash);
			else history.pushState(null, "", hash);
		}
		if (prev && prev !== key) {
			// Keep running sessions attached so they keep streaming into their store.
			const store = this.#stores.get(prev);
			if (store && !store.isRunning) {
				gateway.detach(prev);
				this.#stores.delete(prev);
			}
		}
		this.emit();
	}

	open(key: string | undefined): void {
		this.#setRoute(key, false);
	}

	store(key: string): SessionStore {
		let s = this.#stores.get(key);
		if (!s) {
			s = new SessionStore(key);
			const store = s;
			// A newly dispatched subagent opens the panel on it, unless the user is following another live one.
			store.onSubagentStarted = id => {
				if (this.route !== store.key || !this.prefs.autoOpenAgents) return;
				const current = this.selectedSubagent ? store.subagents.get(this.selectedSubagent) : undefined;
				const followingLive = this.prefs.inspectorOpen && this.prefs.inspectorTab === "agents" && (current?.status === "running" || current?.status === "pending");
				if (!followingLive) this.showSubagent(id);
			};
			store.onAttention = (kind, detail) => this.#attention(store, kind, detail);
			this.#stores.set(key, s);
			gateway.attach(key);
		}
		return s;
	}

	async refreshIndex(): Promise<void> {
		try {
			const data = await api<{ projects: ProjectInfo[]; sessions: SessionSummary[]; archived?: SessionSummary[] }>("/api/index");
			this.projects = data.projects;
			this.sessions = data.sessions;
			this.archived = data.archived ?? [];
			this.indexLoaded = true;
			if (!this.draftProject && data.projects[0]) this.draftProject = data.projects[0].path;
			this.emit();
		} catch {
			// gateway restarting; the next index event retries
		}
	}

	setPrefs(patch: Partial<Prefs>): void {
		this.prefs = { ...this.prefs, ...patch };
		try {
			localStorage.setItem("omp-web:prefs", JSON.stringify(this.prefs));
		} catch {
			// storage unavailable
		}
		this.applyTheme();
		this.emit();
	}

	setDraftProject(path: string): void {
		this.draftProject = path;
		this.setPrefs({ lastProject: path });
	}

	/** Open the right panel on the "改动" page with one file selected. */
	openInChanges(path: string): void {
		this.inspectFile = path;
		this.setPrefs({ inspectorOpen: true, inspectorTab: "changes" });
	}

	selectInspectFile(path: string | undefined): void {
		this.inspectFile = path;
		this.emit();
	}

	/** Open the right panel on the "子代理" page with one subagent selected (Codex / Claude Code style). */
	showSubagent(id: string): void {
		this.selectedSubagent = id;
		this.setPrefs({ inspectorOpen: true, inspectorTab: "agents" });
	}

	selectSubagent(id: string | undefined): void {
		this.selectedSubagent = id;
		this.emit();
	}

	/**
	 * Hide one entry from the home screen's recent list, or bring them all back.
	 * Reads the live prefs, so two clicks in one tick cannot drop an update.
	 */
	dismissRecent(path: string): void {
		this.setPrefs({ dismissedRecent: [...this.prefs.dismissedRecent, path] });
	}

	restoreRecent(): void {
		this.setPrefs({ dismissedRecent: [] });
	}

	/** Show or hide one model in the pickers; also reads the live list. */
	setModelVisible(key: string, visible: boolean): void {
		const current = this.prefs.hiddenModels;
		this.setPrefs({ hiddenModels: visible ? current.filter(k => k !== key) : [...current, key] });
	}

	/**
	 * Switch the sidebar's project filter. Manual mode keeps whatever was picked
	 * before; the first time it starts empty, so the list is chosen deliberately.
	 */
	setProjectFilter(filter: ProjectFilter): void {
		this.setPrefs({ projectFilter: filter });
	}

	/** Tick or untick one project in the "manual" filter. */
	setProjectVisible(path: string, visible: boolean): void {
		const current = this.prefs.visibleProjects;
		this.setPrefs({ visibleProjects: visible ? [...current, path] : current.filter(p => p !== path) });
	}

	/** App-level toast; session-scoped messages use `SessionStore.notify` instead. */
	notify(level: AppNotice["level"], text: string): void {
		const notice = { id: noticeSeq++, level, text };
		this.notices = [...this.notices, notice].slice(-4);
		this.emit();
		setTimeout(() => this.dismiss(notice.id), level === "error" ? 9000 : 5000);
	}

	dismiss(id: number): void {
		this.notices = this.notices.filter(n => n.id !== id);
		this.emit();
	}

	applyTheme(): void {
		const root = document.documentElement;
		if (this.prefs.theme === "system") root.removeAttribute("data-theme");
		else root.setAttribute("data-theme", this.prefs.theme);
		root.setAttribute("data-font", this.prefs.fontSize);
		root.style.setProperty("--font", UI_FONTS[this.prefs.uiFont] ?? UI_FONTS.system);
		root.style.setProperty("--mono", CODE_FONTS[this.prefs.codeFont] ?? CODE_FONTS.jetbrains);
		root.style.setProperty("--col", COL_WIDTHS[this.prefs.colWidth] ?? COL_WIDTHS.normal);
	}

	openSettings(page: SettingsPage = "general"): void {
		this.settingsPage = page;
		this.emit();
	}

	closeSettings(): void {
		this.settingsPage = undefined;
		this.emit();
	}

	/** Hide or restore a session; leaving the open one when it gets archived. */
	async setArchived(path: string, archived: boolean): Promise<void> {
		await api("/api/sessions/archive", { method: "POST", body: JSON.stringify({ path, archived }) });
		if (archived && this.route && this.route.toLowerCase() === path.toLowerCase()) this.open(undefined);
		await this.refreshIndex();
	}

	async deleteArchived(path: string): Promise<void> {
		await api("/api/sessions/delete", { method: "POST", body: JSON.stringify({ path }) });
		await this.refreshIndex();
	}

	/** Background-tab notification for a finished turn or a pending question. */
	#attention(store: SessionStore, kind: "done" | "ask", detail: string): void {
		if (!this.prefs.notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
		if (!document.hidden) return;
		const title = store.state?.sessionName || this.sessions.find(s => s.path.toLowerCase() === store.key.toLowerCase())?.title || "Oh My Pi";
		const n = new Notification(kind === "ask" ? `需要你的回复 · ${title}` : `已完成 · ${title}`, { body: detail.slice(0, 120), tag: store.key });
		n.onclick = () => {
			window.focus();
			this.open(store.key);
			n.close();
		};
	}

	/** Create a session in `cwd` and send its first prompt. */
	async startSession(cwd: string, message: string, images?: ImageContent[]): Promise<void> {
		const { key } = await api<{ key: string }>("/api/sessions", { method: "POST", body: JSON.stringify({ cwd }) });
		this.setDraftProject(cwd);
		const store = this.store(key);
		this.open(key);
		await waitFor(store, () => store.status !== "starting");
		await this.#applyRememberedModel(store);
		await gateway.rpc(key, { type: "prompt", message, images });
		void this.refreshIndex();
	}

	/** Read the profile-wide model lock once; the home picker needs it to narrow the list. */
	async loadHealth(): Promise<void> {
		try {
			const health = await api<{ api?: number; modelLock?: { provider: string; model: string } | null }>("/api/health");
			this.modelLock = health.modelLock ?? undefined;
			this.serverApi = health.api;
			this.emit();
			// This page was built from newer sources than the running gateway: say so
			// instead of letting every new route fail with a bare 404.
			if (this.serverStale && !this.#staleWarned) {
				this.#staleWarned = true;
				this.notify("error", "服务端还是旧版本，部分界面不可用：请重启服务（Ctrl+C 后重新运行 ompweb，或 ompweb --restart）");
			}
		} catch {
			// gateway not up yet; the picker just shows the full list
		}
	}

	/** True when the running gateway predates this bundle (or reports another API version). */
	get serverStale(): boolean {
		return this.serverApi !== API_VERSION;
	}

	rememberModel(choice: { provider: string; id: string; level?: string }): void {
		this.setPrefs({ lastModel: choice });
	}

	/** A locked profile ignores the remembered choice; failures only warn and never block the first prompt. */
	async #applyRememberedModel(store: SessionStore): Promise<void> {
		const want = this.prefs.lastModel;
		if (!want || this.modelLock) return;
		const current = store.state?.model;
		const sameModel = current?.provider === want.provider && current?.id === want.id;
		const sameLevel = !want.level || store.state?.thinkingLevel === want.level;
		if (sameModel && sameLevel) return;
		try {
			if (!sameModel) await gateway.rpc(store.key, { type: "set_model", provider: want.provider, modelId: want.id });
			if (want.level) await gateway.rpc(store.key, { type: "set_thinking_level", level: want.level });
		} catch (e) {
			store.notify("error", `应用上次的模型失败：${(e as Error).message}`);
		}
	}

	async loadModels(key: string): Promise<void> {
		try {
			// omp answers with `{ models }`; tolerate a bare array from older builds.
			const result = await gateway.rpc<RawModels | RawModel[]>(key, { type: "get_available_models" });
			this.#setModels(Array.isArray(result) ? result : (result?.models ?? []));
		} catch {
			// keep the previous list
		}
	}

	/** Same list without a live session (the gateway runs `omp models --json`). */
	async loadModelsWithoutSession(): Promise<void> {
		try {
			this.#setModels((await api<RawModels>("/api/models")).models ?? []);
		} catch {
			// keep the previous list
		}
	}

	#setModels(list: RawModel[]): void {
		this.models = list.map(m => ({
			provider: m.provider,
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			contextWindow: m.contextWindow ?? undefined,
			efforts: Array.isArray(m.thinking) ? m.thinking : m.thinking?.efforts,
		}));
		try {
			localStorage.setItem("omp-web:models", JSON.stringify(this.models));
		} catch {
			// storage unavailable
		}
		this.emit();
	}
}

function waitFor(store: SessionStore, done: () => boolean): Promise<void> {
	if (done()) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const off = store.subscribe(() => {
		if (done()) {
			off();
			resolve();
		}
	});
	return promise;
}

export const app = new AppStore();

export function useApp(): AppStore {
	useSyncExternalStore(app.subscribe, app.getVersion);
	return app;
}

export function useSession(store: SessionStore): SessionStore {
	useSyncExternalStore(store.subscribe, store.getVersion);
	return store;
}
