/**
 * Live sessions: one omp process per opened session file, shared by every
 * attached browser tab.
 *
 * Each live session keeps a mirror of settled messages plus the frames of the
 * message/tool calls still in flight, so a tab attaching mid-run gets
 * `snapshot.messages` + `snapshot.inflight` and replays the latter through the
 * same reducer it uses for live frames.
 */
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import type { AgentMessage, AvailableSlashCommand, ExtensionUiRequest, RpcServerFrame, ServerMsg, SessionState, SubagentLifecyclePayload, SubagentProgressPayload, SubagentSnapshot } from "../shared/api.ts";
import { applySubagentLifecycle, applySubagentProgress } from "../shared/subagents.ts";
import { config } from "./config.ts";
import { OmpProcess } from "./omp-process.ts";
import { samePath, titleFromText } from "./session-index.ts";

type Frame = Record<string, unknown> & { type: string };
export type Socket = ServerWebSocket<{ id: number }>;

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor", "ask"]);
/** Events after which `get_state` is re-read and pushed to tabs. */
const STATE_EVENTS = new Set([
	"agent_start",
	"agent_end",
	"prompt_result",
	"session_settled",
	"model_changed",
	"thinking_level_changed",
	"auto_compaction_end",
	"queue_update",
	"session_info_update",
	"goal_updated",
]);

function trimState(raw: Record<string, unknown>, cwd: string): SessionState {
	const { systemPrompt: _s, dumpTools: _d, ...rest } = raw;
	return { ...(rest as unknown as SessionState), cwd };
}

const TITLE_TIMEOUT_MS = 45_000;

/**
 * One-shot `omp -p` call that writes a short title for the first exchange. A
 * separate ephemeral session keeps the summarizer out of the conversation; the
 * session's own model keeps the style consistent with whatever the user picked.
 */
async function summarizeTitle(options: {
	task: string;
	reply: string;
	cwd: string;
	model?: { provider: string; id: string };
}): Promise<string | undefined> {
	const task = options.task.replace(/\s+/g, " ").trim().slice(0, 600);
	if (!task) return undefined;
	const args = [config.ompBin, "-p", "--no-session", "--no-extensions", "--max-time", "40s"];
	if (options.model) args.push("--provider", options.model.provider, "--model", options.model.id);
	args.push(
		`根据下面的任务描述和助手回复的开头，给这次会话起一个不超过 12 个字的中文标题，概括任务主题。` +
			`只输出标题本身：不要引号、句号、前缀或任何解释。\n\n任务描述：${task}${options.reply ? `\n\n回复开头：${options.reply.slice(0, 400)}` : ""}`,
	);
	const env: Record<string, string | undefined> = { ...process.env };
	if (config.agentDir) env.PI_CODING_AGENT_DIR = config.agentDir;
	const proc = Bun.spawn(args, { cwd: options.cwd, env, stdout: "pipe", stderr: "ignore" });
	const timer = setTimeout(() => proc.kill(), TITLE_TIMEOUT_MS);
	try {
		const out = (await new Response(proc.stdout).text()).trim();
		await proc.exited;
		if (proc.exitCode !== 0 || !out) return undefined;
		return titleFromText(
			out
				.replace(/<\/?title>/g, "")
				.replace(/^["'“”「」]+|["'“”「」。.]+$/g, "")
				.replace(/^标题[:：]\s*/, ""),
		);
	} finally {
		clearTimeout(timer);
	}
}

export class LiveSession {
	key: string;
	readonly cwd: string;
	readonly proc: OmpProcess;
	state: SessionState;
	messages: AgentMessage[] = [];
	inflight: Frame[] = [];
	pendingUi = new Map<string, ExtensionUiRequest>();
	/** Last `available_commands_update` payload; replayed to tabs that attach later. */
	commands: AvailableSlashCommand[] = [];
	/** Subagents of this session, folded from lifecycle/progress frames. */
	subagents = new Map<string, SubagentSnapshot>();
	readonly sockets = new Set<Socket>();
	#idleTimer?: ReturnType<typeof setTimeout>;
	#stateTimer?: ReturnType<typeof setTimeout>;
	#named = false;
	/** First prompt of the auto-named session; the title summarizer consumes it. */
	#titleSource?: string;
	/** The placeholder name this session set, so a user rename wins over the generated one. */
	#autoName?: string;
	#titleDone = false;
	/** Warning shown once to the first tab that attaches (e.g. saved model fell back). */
	startNotice?: string;

	constructor(
		private readonly hub: SessionHub,
		key: string,
		cwd: string,
		resume?: string,
		model?: string,
	) {
		this.key = key;
		this.cwd = cwd;
		this.state = { isStreaming: false, isCompacting: false, messageCount: 0, cwd };
		this.proc = new OmpProcess({
			cwd,
			resume,
			model,
			onFrame: frame => this.#onFrame(frame),
			onExit: (code, stderr) => this.hub.onExit(this, code, stderr),
		});
	}

	async init(): Promise<void> {
		await this.proc.ready;
		await this.refreshState();
		this.#named = Boolean(this.state.sessionName);
		// Settled history, paged (each page ≤ 256 messages, v2 framing keeps large ones lossless).
		const messages: AgentMessage[] = [];
		let cursor: string | undefined;
		do {
			const res = await this.proc.request({ type: "get_messages_page", cursor, limit: 200 });
			if (!res.success) throw new Error(String(res.error ?? "get_messages_page failed"));
			const data = res.data as { messages: AgentMessage[]; nextCursor?: string };
			messages.push(...data.messages);
			cursor = data.nextCursor;
		} while (cursor);
		this.messages = messages;
		// Only sessions that have never had a user message get named from their first prompt.
		if (messages.some(m => (m as { role?: string }).role === "user")) this.#named = true;
		// Subagents that started before this tab (or before the gateway) attached.
		const subagents = await this.proc.request({ type: "get_subagents" });
		if (subagents.success) {
			for (const entry of ((subagents.data as { subagents?: SubagentSnapshot[] }).subagents ?? [])) this.subagents.set(entry.id, entry);
		}
	}

	async refreshState(): Promise<SessionState> {
		const res = await this.proc.request({ type: "get_state" });
		if (res.success) this.state = trimState(res.data as Record<string, unknown>, this.cwd);
		return this.state;
	}

	snapshot(): ServerMsg {
		return {
			t: "snapshot",
			key: this.key,
			state: this.state,
			messages: this.messages,
			inflight: this.inflight as unknown as RpcServerFrame[],
			pendingUi: [...this.pendingUi.values()],
			commands: this.commands,
			subagents: [...this.subagents.values()],
		};
	}

	send(msg: ServerMsg): void {
		const text = JSON.stringify(msg);
		for (const ws of this.sockets) ws.send(text);
	}

	attach(ws: Socket): void {
		this.sockets.add(ws);
		clearTimeout(this.#idleTimer);
		ws.send(JSON.stringify(this.snapshot()));
		if (this.startNotice) {
			const frame = { type: "notice", level: "warning", message: this.startNotice };
			ws.send(JSON.stringify({ t: "frame", key: this.key, frame }));
			this.startNotice = undefined;
		}
	}

	detach(ws: Socket): void {
		this.sockets.delete(ws);
		this.#armIdle();
	}

	#armIdle(): void {
		clearTimeout(this.#idleTimer);
		if (this.sockets.size > 0) return;
		this.#idleTimer = setTimeout(() => {
			if (this.sockets.size === 0 && !this.state.isStreaming && this.pendingUi.size === 0) void this.hub.stop(this);
			else this.#armIdle();
		}, config.idleStopMs);
	}

	/** Forward a browser command, with web-side conveniences around it. */
	async command(cmd: Record<string, unknown>): Promise<Frame> {
		const type = String(cmd.type);
		if ((type === "prompt" || type === "abort_and_prompt") && !this.#named && typeof cmd.message === "string") {
			this.#named = true;
			const name = titleFromText(cmd.message);
			this.#titleSource = cmd.message;
			if (name) {
				this.#autoName = name;
				void this.proc.request({ type: "set_session_name", name }).then(() => this.hub.indexChanged());
			}
		}
		if (type === "abort" || type === "abort_and_restore_queue" || type === "abort_and_prompt") {
			// A dialog left open would keep the tool blocked; cancel dialogs before aborting.
			this.#cancelDialogs();
		}
		const res = await this.proc.request(cmd);
		if (["new_session", "fork", "switch_session", "branch", "set_model", "set_thinking_level", "set_session_name", "compact"].includes(type)) {
			const before = this.state.sessionFile;
			await this.refreshState();
			this.send({ t: "state", key: this.key, state: this.state });
			const after = this.state.sessionFile;
			if (after && before && !samePath(after, before)) {
				// Messages differ for the new file: reload mirror and move tabs.
				this.inflight = [];
				await this.#reloadMessages();
				this.hub.rekey(this, after);
			}
			this.hub.indexChanged();
		}
		return res;
	}

	answerUi(payload: Record<string, unknown>): void {
		const id = String(payload.id);
		this.pendingUi.delete(id);
		this.proc.write({ ...payload, type: "extension_ui_response" });
		this.#broadcastFrame({ type: "extension_ui_resolved", id });
	}

	#cancelDialogs(): void {
		for (const id of [...this.pendingUi.keys()]) this.answerUi({ id, cancelled: true });
	}

	async #reloadMessages(): Promise<void> {
		const res = await this.proc.request({ type: "get_messages" });
		// omp answers with `{ messages }`; keep the mirror an array whatever happens.
		this.messages = res.success ? ((res.data as { messages?: AgentMessage[] } | undefined)?.messages ?? []) : [];
	}

	#lastReplyText(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i] as { role?: string; content?: unknown };
			if (m.role !== "assistant") continue;
			const text = Array.isArray(m.content)
				? (m.content as { type?: string; text?: string }[]).filter(c => c.type === "text").map(c => c.text ?? "").join(" ")
				: "";
			if (text.trim()) return text.trim();
		}
		return "";
	}

	/** After the first exchange, replace the prompt-excerpt placeholder with a model-written title. */
	#maybeSummarizeTitle(): void {
		if (this.#titleDone || !config.autoTitle) return;
		const source = this.#titleSource;
		if (!source) return;
		this.#titleDone = true;
		void summarizeTitle({
			task: source,
			reply: this.#lastReplyText(),
			cwd: this.cwd,
			model: this.state.model ? { provider: this.state.model.provider, id: this.state.model.id } : undefined,
		})
			.then(title => {
				// A user rename between the prompt and now wins over the generated one.
				if (!title || (this.#autoName && this.state.sessionName !== this.#autoName)) return;
				return this.proc
					.request({ type: "set_session_name", name: title })
					.then(() => this.refreshState())
					.then(() => {
						this.send({ t: "state", key: this.key, state: this.state });
						this.hub.indexChanged();
					});
			})
			.catch(() => {
				// keep the placeholder; the summary is best-effort
			});
	}

	#broadcastFrame(frame: Frame): void {
		this.send({ t: "frame", key: this.key, frame: frame as unknown as RpcServerFrame });
	}

	#onFrame(frame: Frame): void {
		switch (frame.type) {
			case "message_start":
			case "message_update":
				this.inflight.push(frame);
				break;
			case "message_end": {
				const id = frame.messageId;
				this.inflight = this.inflight.filter(f => !(f.messageId === id && (f.type === "message_start" || f.type === "message_update")));
				this.messages.push(frame.message as AgentMessage);
				break;
			}
			case "tool_execution_start":
			case "tool_execution_update":
				this.inflight.push(frame);
				break;
			case "tool_execution_end": {
				const id = frame.toolCallId;
				this.inflight = this.inflight.filter(f => f.toolCallId !== id);
				break;
			}
			case "agent_end":
				this.inflight = [];
				// First exchange settled: upgrade the truncated-prompt placeholder to a
				// model-written title (skipped when the user already renamed the session).
				this.#maybeSummarizeTitle();
				break;
			case "extension_ui_request": {
				const method = String(frame.method);
				if (DIALOG_METHODS.has(method)) this.pendingUi.set(String(frame.id), frame as unknown as ExtensionUiRequest);
				else if (method === "cancel") this.pendingUi.delete(String(frame.targetId));
				else if (method === "setWidget" || method === "setStatus") return; // terminal-only chrome
				break;
			}
			case "available_commands_update":
				// Kept on the session so a tab attaching later can still complete `/`.
				this.commands = (frame.commands as AvailableSlashCommand[] | undefined) ?? [];
				break;
			case "subagent_lifecycle":
				applySubagentLifecycle(this.subagents, frame.payload as SubagentLifecyclePayload);
				break;
			case "subagent_progress":
				applySubagentProgress(this.subagents, frame.payload as SubagentProgressPayload);
				break;
		}
		this.#broadcastFrame(frame);
		if (STATE_EVENTS.has(frame.type)) this.#scheduleState(frame.type === "agent_start" ? 0 : 120);
		if (frame.type === "prompt_result") this.hub.indexChanged();
	}

	#scheduleState(delay: number): void {
		clearTimeout(this.#stateTimer);
		this.#stateTimer = setTimeout(() => {
			void this.refreshState()
				.then(state => {
					this.send({ t: "state", key: this.key, state });
					this.#armIdle();
				})
				.catch(() => {});
		}, delay);
	}
}

/** The session's saved model and the default role are both unavailable. */
export class ModelUnavailableError extends Error {
	constructor(readonly lostModel: string) {
		super(`此会话保存的模型 ${lostModel} 已不可用`);
	}
}

/** `modelRoles.default` from the profile's config.yml, or undefined when unset/unreadable. */
async function defaultRoleModel(): Promise<string | undefined> {
	try {
		const text = await Bun.file(path.join(path.dirname(config.sessionsRoot), "config.yml")).text();
		const roles = (Bun.YAML.parse(text) as { modelRoles?: Record<string, unknown> } | null)?.modelRoles;
		return typeof roles?.default === "string" && roles.default.trim() ? roles.default.trim() : undefined;
	} catch {
		return undefined;
	}
}

export class SessionHub {
	readonly sessions = new Map<string, LiveSession>();
	readonly #starting = new Map<string, Promise<LiveSession>>();
	readonly clients = new Set<Socket>();
	#indexTimer?: ReturnType<typeof setTimeout>;

	find(key: string): LiveSession | undefined {
		const direct = this.sessions.get(key);
		if (direct) return direct;
		for (const s of this.sessions.values()) if (samePath(s.key, key)) return s;
		return undefined;
	}

	/** Open (or reuse) the live process for an existing session file. */
	async open(file: string, cwd: string, model?: string): Promise<LiveSession> {
		const existing = this.find(file);
		if (existing) return existing;
		const starting = this.#starting.get(file);
		if (starting) return starting;
		const promise = (async () => {
			let live = await this.#start(file, cwd, model);
			if (live instanceof Error) {
				// rpc-ui refuses to resume when the saved model is gone (provider removed or
				// renamed) instead of falling back. Retry once on the default role; failing
				// that, the browser asks which model to reopen with.
				// stderr also echoes omp's source line (a `${...}` template); the real error comes last.
				const lost = [...live.message.matchAll(/Could not restore model ([^\s`]+)/g)].at(-1)?.[1];
				if (!lost || model || config.modelLock) throw live;
				// `--model` does not resolve role names, so pass the default role's model itself.
				const fallback = await defaultRoleModel();
				const retry = fallback ? await this.#start(file, cwd, fallback) : undefined;
				if (!retry || retry instanceof Error) throw new ModelUnavailableError(lost);
				live = retry;
				live.startNotice = `原模型 ${lost} 已不可用，已改用默认模型 ${fallback}`;
			}
			// A model given on the command line is not saved to the session, so the next
			// resume would fail the same way. `set_model` records it.
			const chosen = live.state.model;
			if ((model || live.startNotice) && chosen) {
				await live.proc.request({ type: "set_model", provider: chosen.provider, modelId: chosen.id }).catch(() => undefined);
			}
			this.sessions.set(live.key, live);
			return live;
		})().finally(() => this.#starting.delete(file));
		this.#starting.set(file, promise);
		return promise;
	}

	async #start(file: string, cwd: string, model?: string): Promise<LiveSession | Error> {
		const live = new LiveSession(this, file, cwd, file, model);
		try {
			await live.init();
			return live;
		} catch (error) {
			await live.proc.stop(500);
			return error instanceof Error ? error : new Error(String(error));
		}
	}

	/** Start a fresh session in `cwd`. Its key is the session file omp assigned. */
	async create(cwd: string): Promise<LiveSession> {
		const live = new LiveSession(this, `new:${crypto.randomUUID()}`, cwd);
		try {
			await live.init();
		} catch (error) {
			await live.proc.stop(500);
			throw error;
		}
		if (live.state.sessionFile) live.key = live.state.sessionFile;
		this.sessions.set(live.key, live);
		return live;
	}

	rekey(live: LiveSession, to: string): void {
		const from = live.key;
		this.sessions.delete(from);
		live.key = to;
		this.sessions.set(to, live);
		live.send({ t: "rekey", from, to });
		live.send(live.snapshot());
	}

	async stop(live: LiveSession): Promise<void> {
		this.sessions.delete(live.key);
		await live.proc.stop();
	}

	onExit(live: LiveSession, code: number | null, stderr: string): void {
		if (this.sessions.get(live.key) === live) this.sessions.delete(live.key);
		const error = code === 0 || code === null ? undefined : stderr.trim().split("\n").slice(-3).join("\n") || `exit ${code}`;
		live.send({ t: "proc", key: live.key, status: "exited", error });
		this.indexChanged();
	}

	liveStatus(file: string): "idle" | "running" | undefined {
		const live = this.find(file);
		if (!live) return undefined;
		return live.state.isStreaming ? "running" : "idle";
	}

	indexChanged(): void {
		clearTimeout(this.#indexTimer);
		this.#indexTimer = setTimeout(() => {
			const text = JSON.stringify({ t: "index" } satisfies ServerMsg);
			for (const ws of this.clients) ws.send(text);
		}, 250);
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.sessions.values()].map(s => s.proc.stop(2000)));
	}
}
