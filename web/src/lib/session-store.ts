/**
 * React-free state for one session. Frames mutate it; React reads a version
 * number through `useSyncExternalStore`.
 *
 * Two notify channels: `#dirty()` (microtask) for structural changes and
 * `#frameDirty()` (requestAnimationFrame) for high-rate token deltas, so a
 * fast stream renders at most once per frame.
 */
import type {
	AgentMessage,
	AvailableSlashCommand,
	ExtensionUiRequest,
	RpcServerFrame,
	ServerMsg,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	SubagentSnapshot,
} from "../../../shared/api.ts";
import { applySubagentLifecycle, applySubagentProgress } from "../../../shared/subagents.ts";

export interface Block {
	type: "text" | "thinking" | "toolCall" | "image" | string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	partialJson?: string;
	intent?: string;
}

export interface Draft {
	messageId: string;
	content: Block[];
	startedAt: number;
}

export interface ToolExec {
	id: string;
	name: string;
	args: Record<string, unknown>;
	intent?: string;
	status: "running" | "done" | "error";
	partial?: string;
	result?: { content?: { type: string; text?: string }[]; details?: unknown; isError?: boolean };
	startedAt: number;
	endedAt?: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
}

type AnyFrame = Record<string, unknown> & { type: string };

let noticeSeq = 1;

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(c => (c && typeof c === "object" && "text" in c ? String((c as { text?: unknown }).text ?? "") : "")).join("");
}

export class SessionStore {
	key: string;
	status: "starting" | "ready" | "exited" = "starting";
	error?: string;
	/** Saved model that no longer exists; the exit page offers a model to reopen with. */
	lostModel?: string;
	state: SessionState | null = null;
	messages: AgentMessage[] = [];
	drafts = new Map<string, Draft>();
	tools = new Map<string, ToolExec>();
	pendingUi: ExtensionUiRequest[] = [];
	/** Slash commands omp advertised for this session; drives the `/` menu. */
	commands: AvailableSlashCommand[] = [];
	/** Subagents of this session, keyed by id. */
	subagents = new Map<string, SubagentSnapshot>();
	/** Set by the app store: a turn finished ("done") or omp asks the user something ("ask"). */
	onAttention?: (kind: "done" | "ask", detail: string) => void;
	/** Set by the app store: a live (not replayed) subagent just started. */
	onSubagentStarted?: (id: string) => void;
	notices: Notice[] = [];
	activity?: string;
	runStartedAt?: number;
	version = 0;
	#listeners = new Set<() => void>();
	#scheduled = false;
	#raf = 0;

	constructor(key: string) {
		this.key = key;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	#emit(): void {
		this.version++;
		for (const l of this.#listeners) l();
	}

	#dirty(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			cancelAnimationFrame(this.#raf);
			this.#raf = 0;
			this.#emit();
		});
	}

	#frameDirty(): void {
		if (this.#raf || this.#scheduled) return;
		this.#raf = requestAnimationFrame(() => {
			this.#raf = 0;
			this.#emit();
		});
	}

	/** omp's own streaming flag, or visible in-flight output. `runStartedAt` is only a timer. */
	get isRunning(): boolean {
		if (this.drafts.size > 0) return true;
		for (const t of this.tools.values()) if (t.status === "running") return true;
		return Boolean(this.state?.isStreaming);
	}

	handle(msg: ServerMsg): void {
		switch (msg.t) {
			case "snapshot":
				this.status = "ready";
				this.error = undefined;
				this.state = msg.state;
				// Never let a malformed payload replace the mirror with a non-array.
				this.messages = Array.isArray(msg.messages) ? msg.messages : [];
				this.drafts.clear();
				this.tools.clear();
				this.pendingUi = msg.pendingUi;
				this.commands = msg.commands ?? [];
				this.subagents = new Map((msg.subagents ?? []).map(s => [s.id, s]));
				this.runStartedAt = msg.state.isStreaming ? Date.now() : undefined;
				for (const f of msg.inflight) this.#frame(f as unknown as AnyFrame, true);
				this.#dirty();
				return;
			case "state":
				this.state = msg.state;
				if (!msg.state.isStreaming && this.drafts.size === 0) this.runStartedAt = undefined;
				this.#dirty();
				return;
			case "proc":
				if (msg.status === "exited") {
					this.status = "exited";
					this.error = msg.error;
					this.lostModel = msg.lostModel;
					this.runStartedAt = undefined;
					this.drafts.clear();
					this.pendingUi = [];
				} else if (msg.status === "starting" && this.status !== "ready") this.status = "starting";
				this.#dirty();
				return;
			case "frame":
				this.#frame(msg.frame as unknown as AnyFrame, false);
				return;
		}
	}

	notify(level: Notice["level"], text: string): void {
		const notice = { id: noticeSeq++, level, text };
		this.notices = [...this.notices, notice].slice(-4);
		this.#dirty();
		setTimeout(() => this.dismiss(notice.id), level === "error" ? 9000 : 5000);
	}

	dismiss(id: number): void {
		this.notices = this.notices.filter(n => n.id !== id);
		this.#dirty();
	}

	/**
	 * The gateway can restart a session process from its session file, so an exit
	 * is recoverable: drop the exit state and let the caller re-attach.
	 */
	markReconnecting(): void {
		this.status = "starting";
		this.error = undefined;
		this.lostModel = undefined;
		this.runStartedAt = undefined;
		this.#dirty();
	}

	/** Optimistic local echo is avoided: omp emits the user message_start/end immediately. */
	#frame(f: AnyFrame, replay: boolean): void {
		switch (f.type) {
			case "agent_start":
				this.runStartedAt = Date.now();
				this.activity = undefined;
				break;
			case "agent_end":
				this.runStartedAt = undefined;
				this.drafts.clear();
				// Settled executions already live in `messages`; keeping them here would
				// render the finished turn's tools a second time inside the next turn.
				for (const [id, tool] of this.tools) if (tool.status !== "running") this.tools.delete(id);
				this.activity = undefined;
				break;
			case "message_start": {
				const message = f.message as { role: string; content?: Block[] };
				if (message.role === "assistant") {
					this.drafts.set(String(f.messageId), {
						messageId: String(f.messageId),
						content: structuredClone(message.content ?? []),
						startedAt: Date.now(),
					});
				}
				break;
			}
			case "message_update": {
				this.#applyDelta(String(f.messageId), f.assistantMessageEvent as AnyFrame);
				if (!replay) this.#frameDirty();
				return;
			}
			case "message_end":
				this.drafts.delete(String(f.messageId));
				this.messages = [...this.messages, f.message as AgentMessage];
				break;
			case "tool_execution_start":
				this.tools.set(String(f.toolCallId), {
					id: String(f.toolCallId),
					name: String(f.toolName),
					args: (f.args as Record<string, unknown>) ?? {},
					intent: f.intent as string | undefined,
					status: "running",
					startedAt: Date.now(),
				});
				break;
			case "tool_execution_update": {
				const t = this.tools.get(String(f.toolCallId));
				if (t) t.partial = contentText((f.partialResult as { content?: unknown })?.content);
				if (!replay) this.#frameDirty();
				return;
			}
			case "tool_execution_end": {
				const t = this.tools.get(String(f.toolCallId));
				const result = f.result as ToolExec["result"];
				const isError = Boolean(f.isError ?? result?.isError);
				if (t) {
					t.status = isError ? "error" : "done";
					t.result = result;
					t.endedAt = Date.now();
				}
				break;
			}
			case "extension_ui_request": {
				const method = String(f.method);
				if (["select", "confirm", "input", "editor", "ask"].includes(method)) {
					this.pendingUi = [...this.pendingUi.filter(r => r.id !== f.id), f as unknown as ExtensionUiRequest];
					if (!replay) this.onAttention?.("ask", String(f.title ?? f.message ?? "有一个问题等你回答"));
				} else if (method === "cancel") {
					this.pendingUi = this.pendingUi.filter(r => r.id !== f.targetId);
				} else if (method === "notify" && !replay) {
					const level = f.notifyType === "error" ? "error" : f.notifyType === "warning" ? "warning" : "info";
					this.notify(level, String(f.message ?? ""));
				}
				break;
			}
			case "available_commands_update":
				this.commands = (f.commands as AvailableSlashCommand[] | undefined) ?? [];
				break;
			case "subagent_lifecycle": {
				const payload = f.payload as SubagentLifecyclePayload;
				applySubagentLifecycle(this.subagents, payload);
				if (!replay && payload.status === "started") queueMicrotask(() => this.onSubagentStarted?.(payload.id));
				break;
			}
			case "subagent_progress":
				applySubagentProgress(this.subagents, f.payload as SubagentProgressPayload);
				break;
			case "extension_ui_resolved":
				this.pendingUi = this.pendingUi.filter(r => r.id !== f.id);
				break;
			case "queue_update":
				if (this.state) this.state = { ...this.state, queuedMessages: { steering: f.steering as string[], followUp: f.followUp as string[] } };
				break;
			case "auto_compaction_start":
				this.activity = "正在压缩上下文…";
				break;
			case "auto_retry_start":
				this.activity = `请求失败，正在重试（第 ${String(f.attempt ?? "")} 次）…`;
				break;
			case "auto_compaction_end":
			case "auto_retry_end":
				this.activity = undefined;
				break;
			case "prompt_result":
				if (f.status === "error" && !replay) this.notify("error", String(f.error ?? "请求失败"));
				if (f.status === "completed" && f.agentInvoked && !replay) this.onAttention?.("done", this.#lastAnswer());
				break;
			case "notice":
				if (!replay && typeof f.message === "string") this.notify(f.level === "error" ? "error" : f.level === "warning" ? "warning" : "info", f.message);
				break;
			case "extension_error":
				if (!replay) this.notify("warning", `扩展错误：${String(f.error ?? "")}`);
				break;
			default:
				return;
		}
		if (!replay) this.#dirty();
	}

	#lastAnswer(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i] as { role?: string; content?: unknown };
			if (m.role !== "assistant") continue;
			const text = Array.isArray(m.content) ? m.content.filter(c => (c as { type?: string }).type === "text").map(c => String((c as { text?: string }).text ?? "")).join(" ") : "";
			if (text.trim()) return text.trim();
		}
		return "回合已完成";
	}

	#applyDelta(messageId: string, ev: AnyFrame): void {
		let draft = this.drafts.get(messageId);
		if (!draft) {
			draft = { messageId, content: [], startedAt: Date.now() };
			this.drafts.set(messageId, draft);
		}
		const i = Number(ev.contentIndex ?? -1);
		const c = draft.content;
		switch (ev.type) {
			case "text_start":
				c[i] = { type: "text", text: "" };
				break;
			case "text_delta":
				c[i] ??= { type: "text", text: "" };
				c[i] = { ...c[i], text: (c[i].text ?? "") + String(ev.delta ?? "") };
				break;
			case "text_end":
				c[i] = { type: "text", text: String(ev.content ?? "") };
				break;
			case "thinking_start":
				c[i] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				c[i] ??= { type: "thinking", thinking: "" };
				c[i] = { ...c[i], thinking: (c[i].thinking ?? "") + String(ev.delta ?? "") };
				break;
			case "thinking_end":
				c[i] = { type: "thinking", thinking: String(ev.content ?? "") };
				break;
			case "toolcall_start":
				c[i] = { type: "toolCall", partialJson: "" };
				break;
			case "toolcall_delta":
				c[i] ??= { type: "toolCall", partialJson: "" };
				c[i] = { ...c[i], partialJson: (c[i].partialJson ?? "") + String(ev.delta ?? "") };
				break;
			case "toolcall_end":
				c[i] = { ...(ev.toolCall as Block) };
				break;
		}
		draft.content = [...c];
	}
}
