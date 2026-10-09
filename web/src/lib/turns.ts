/**
 * View model: group the flat message list into turns and flatten each turn's
 * assistant output into ordered steps (thinking / text / tool call / notes).
 */
import type { AgentMessage } from "../../../shared/api.ts";
import { type Block, contentText, type Draft, type ToolExec } from "./session-store.ts";

export type Step =
	| { kind: "thinking"; key: string; text: string; live: boolean }
	| { kind: "text"; key: string; text: string; live: boolean }
	| { kind: "tool"; key: string; call: Block; exec?: ToolExec; result?: ToolResult; live: boolean }
	| { kind: "steer"; key: string; text: string }
	| { kind: "bash"; key: string; command: string; output: string; exitCode?: number }
	| { kind: "note"; key: string; text: string; tone: "info" | "error" };

export interface ToolResult {
	content?: { type: string; text?: string }[];
	details?: unknown;
	isError?: boolean;
}

export interface Turn {
	key: string;
	user?: { text: string; images: number; timestamp: number };
	messages: AgentMessage[];
	/** Divider rendered above the turn (compaction, branch summary). */
	divider?: string;
}

type Msg = AgentMessage & { role: string; [k: string]: unknown };

export function buildTurns(messages: readonly AgentMessage[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | undefined;
	messages.forEach((raw, index) => {
		const m = raw as Msg;
		if (m.role === "user" && !m.steering && !m.synthetic) {
			const content = m.content as unknown;
			const images = Array.isArray(content) ? content.filter(c => (c as { type?: string }).type === "image").length : 0;
			current = { key: `t${index}`, user: { text: contentText(content), images, timestamp: Number(m.timestamp) }, messages: [] };
			turns.push(current);
			return;
		}
		if (m.role === "compactionSummary" || m.role === "branchSummary") {
			current = { key: `t${index}`, messages: [], divider: m.role === "compactionSummary" ? "上下文已压缩" : "已切换分支" };
			turns.push(current);
			return;
		}
		if (!current) {
			current = { key: `t${index}`, messages: [] };
			turns.push(current);
		}
		current.messages.push(raw);
	});
	return turns;
}

/** Ordered steps of a turn. `drafts`/`tools` are only passed for the live (last) turn. */
export function turnSteps(turn: Turn, drafts?: Iterable<Draft>, tools?: Map<string, ToolExec>): Step[] {
	const results = new Map<string, ToolResult>();
	for (const raw of turn.messages) {
		const m = raw as Msg;
		if (m.role === "toolResult") results.set(String(m.toolCallId), m as unknown as ToolResult);
	}
	const steps: Step[] = [];
	const pushBlocks = (blocks: Block[], prefix: string, live: boolean) => {
		blocks.forEach((b, i) => {
			if (!b) return;
			const key = `${prefix}:${i}`;
			if (b.type === "thinking" && b.thinking?.trim()) steps.push({ kind: "thinking", key, text: b.thinking, live });
			else if (b.type === "text" && b.text?.trim()) steps.push({ kind: "text", key, text: b.text, live });
			else if (b.type === "toolCall") {
				const id = b.id ?? "";
				steps.push({ kind: "tool", key: id || key, call: b, exec: id ? tools?.get(id) : undefined, result: id ? results.get(id) : undefined, live });
			}
		});
	};
	turn.messages.forEach((raw, index) => {
		const m = raw as Msg;
		switch (m.role) {
			case "assistant": {
				pushBlocks((m.content as Block[]) ?? [], `${turn.key}:${index}`, false);
				if (m.stopReason === "error" && m.errorMessage) steps.push({ kind: "note", key: `${turn.key}:${index}:err`, text: String(m.errorMessage), tone: "error" });
				if (m.stopReason === "aborted") steps.push({ kind: "note", key: `${turn.key}:${index}:abort`, text: "已停止", tone: "info" });
				break;
			}
			case "user":
				if (m.steering) steps.push({ kind: "steer", key: `${turn.key}:${index}`, text: contentText(m.content) });
				break;
			case "bashExecution":
				steps.push({ kind: "bash", key: `${turn.key}:${index}`, command: String(m.command), output: String(m.output ?? ""), exitCode: m.exitCode as number | undefined });
				break;
			case "custom":
				if (m.display) steps.push({ kind: "note", key: `${turn.key}:${index}`, text: contentText(m.content), tone: "info" });
				break;
		}
	});
	for (const d of drafts ?? []) pushBlocks(d.content, `draft:${d.messageId}`, true);
	// Live executions whose call block is not visible yet (should be rare). Only a
	// still-running one qualifies: a settled execution was already rendered by the
	// turn that owns its call block, so it must never leak into a later turn.
	if (tools) {
		const shown = new Set(steps.filter(s => s.kind === "tool").map(s => s.key));
		for (const t of tools.values()) {
			if (t.status !== "running" || shown.has(t.id) || results.has(t.id)) continue;
			steps.push({ kind: "tool", key: t.id, call: { type: "toolCall", id: t.id, name: t.name, arguments: t.args }, exec: t, live: true });
		}
	}
	return steps;
}

export function toolStatus(step: Extract<Step, { kind: "tool" }>): "pending" | "running" | "done" | "error" {
	if (step.result) return step.result.isError ? "error" : "done";
	if (step.exec) return step.exec.status;
	return step.call.name ? "running" : "pending";
}

export function resultText(step: Extract<Step, { kind: "tool" }>): string {
	const r = step.result ?? step.exec?.result;
	if (r) return contentText(r.content);
	return step.exec?.partial ?? "";
}

/** Gaps longer than this between consecutive events are idle time, not work. */
export const MAX_ACTIVE_GAP_MS = 10 * 60_000;

/** Active time of a turn: sum of gaps between its events, each capped, so idle pauses never count. */
export function turnDuration(turn: Turn): number | undefined {
	if (!turn.user) return undefined;
	const points = [turn.user.timestamp];
	for (const m of turn.messages as unknown as { timestamp?: number; completedAt?: number; duration?: number }[]) {
		if (m.timestamp) points.push(m.timestamp);
		const end = m.completedAt ?? (m.timestamp && m.duration ? m.timestamp + m.duration : undefined);
		if (end) points.push(end);
	}
	points.sort((a, b) => a - b);
	let total = 0;
	for (let i = 1; i < points.length; i++) total += Math.min(points[i] - points[i - 1], MAX_ACTIVE_GAP_MS);
	return total > 0 ? total : undefined;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** Shell line continuations (backslash + newline) read as one command line. */
function joinContinuations(cmd: string): string {
	return cmd.replace(/\\\r?\n\s*/g, " ");
}

function short(text: string, max = 80): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function baseName(p: string): string {
	const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || p;
}

/** Paths an edit/write call touches (hashline/apply_patch inputs carry them inline). */
export function editPaths(name: string, args: Record<string, unknown>): string[] {
	if (name === "write" || name === "ast_edit") return str(args.path) ? [str(args.path)] : [];
	if (name !== "edit") return [];
	if (str(args.path)) return [str(args.path)];
	const input = str(args.input);
	const out = new Set<string>();
	for (const m of input.matchAll(/^\[(.+?)#[0-9A-Fa-f]{4}\]/gm)) out.add(m[1]);
	for (const m of input.matchAll(/^\*\*\* (?:Edit|Add|Update|Delete) File:\s*(.+?)(?:\s+all)?$/gm)) out.add(m[1].trim());
	return [...out];
}

export interface ToolLabel {
	icon: "file" | "search" | "terminal" | "edit" | "agent" | "globe" | "list" | "code" | "wait" | "ask" | "tool" | "check";
	verb: string;
	target: string;
}

export function toolLabel(name: string | undefined, args: Record<string, unknown> = {}): ToolLabel {
	switch (name) {
		case undefined:
			return { icon: "tool", verb: "准备工具调用", target: "" };
		case "read":
			return { icon: "file", verb: "读取", target: baseName(str(args.path)) };
		case "grep":
			return { icon: "search", verb: "搜索", target: `${short(str(args.pattern), 48)}${str(args.path) ? ` · ${baseName(str(args.path))}` : ""}` };
		case "glob":
			// omp's glob takes the pattern in `path`.
			return { icon: "search", verb: "查找文件", target: short(str(args.path) || str(args.pattern), 60) };
		case "yield":
			return { icon: "check", verb: "提交结果", target: "" };
		case "find":
			return { icon: "search", verb: "查找", target: short(str(args.query) || str(args.pattern), 60) };
		case "bash":
			return { icon: "terminal", verb: str(args.name) ? "启动服务" : "运行", target: short(str(args.name) || joinContinuations(str(args.command)), 90) };
		case "edit": {
			const paths = editPaths(name, args);
			return { icon: "edit", verb: "编辑", target: paths.length > 1 ? `${paths.length} 个文件` : baseName(paths[0] ?? "") };
		}
		case "write": {
			const p = str(args.path);
			if (p.startsWith("xd://")) return { icon: "tool", verb: "调用", target: p.slice(5) };
			if (p.startsWith("proc://")) return { icon: "terminal", verb: p.endsWith("/kill") ? "终止" : "写入进程", target: p.slice(7).replace(/\/kill$/, "") };
			if (p.startsWith("agent://")) return { icon: "agent", verb: "发送消息", target: p.slice(8) };
			return { icon: "edit", verb: "写入", target: baseName(p) };
		}
		case "ast_grep":
			return { icon: "search", verb: "结构搜索", target: short(str(args.pattern), 60) };
		case "ast_edit":
			return { icon: "edit", verb: "结构编辑", target: baseName(str(args.path)) };
		case "task": {
			const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0;
			return { icon: "agent", verb: "子代理", target: tasks > 1 ? `${tasks} 个任务` : short(str(args.name) || str(args.task), 60) };
		}
		case "wait":
			return { icon: "wait", verb: "等待后台任务", target: "" };
		case "web_search":
			return { icon: "globe", verb: "搜索网页", target: short(str(args.query), 60) };
		case "todo":
			return { icon: "list", verb: "更新待办", target: "" };
		case "ask":
			return { icon: "ask", verb: "提问", target: "" };
		case "eval":
			return { icon: "code", verb: "运行代码", target: str(args.language) || str(args.lang) };
		case "lsp":
			return { icon: "code", verb: "语言服务", target: short(str(args.action) || str(args.op), 40) };
		case "github":
			return { icon: "globe", verb: "GitHub", target: short(str(args.op) || str(args.action), 40) };
		case "debug":
			return { icon: "code", verb: "调试", target: short(str(args.action), 40) };
		default:
			return { icon: "tool", verb: name, target: "" };
	}
}

export interface DiffStat {
	added: number;
	removed: number;
}

export function diffStat(diff: string): DiffStat {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

export interface FileChange {
	path: string;
	diff: string;
	stat: DiffStat;
	op: string;
}

/** Display path relative to `cwd` when inside it, with forward slashes. */
export function displayPath(p: string, cwd?: string): string {
	const norm = p.replace(/\\/g, "/");
	if (!cwd) return norm;
	const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	if (norm.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return norm.slice(base.length + 1);
	return norm.replace(/^\.\//, "");
}

/** Per-file changes from a successful edit/write result; paths are made relative to `cwd`. */
export function fileChanges(step: Extract<Step, { kind: "tool" }>, cwd?: string): FileChange[] {
	return rawFileChanges(step).map(c => ({ ...c, path: displayPath(c.path, cwd) }));
}

/** A turn's file changes merged by path, so relative and absolute spellings of one file collapse into one entry. */
export function mergeChanges(steps: Step[], cwd?: string): FileChange[] {
	const map = new Map<string, FileChange>();
	for (const s of steps) {
		if (s.kind !== "tool") continue;
		for (const c of fileChanges(s, cwd)) {
			const prev = map.get(c.path.toLowerCase());
			if (prev)
				map.set(c.path.toLowerCase(), {
					...c,
					diff: [prev.diff, c.diff].filter(Boolean).join("\n"),
					stat: { added: prev.stat.added + c.stat.added, removed: prev.stat.removed + c.stat.removed },
				});
			else map.set(c.path.toLowerCase(), c);
		}
	}
	return [...map.values()];
}

function rawFileChanges(step: Extract<Step, { kind: "tool" }>): FileChange[] {
	const name = step.call.name;
	if (name !== "edit" && name !== "write" && name !== "ast_edit") return [];
	if (toolStatus(step) !== "done") return [];
	const details = ((step.result ?? step.exec?.result)?.details ?? {}) as {
		diff?: string;
		path?: string;
		op?: string;
		perFileResults?: { path: string; diff?: string; op?: string }[];
	};
	const args = step.call.arguments ?? {};
	if (name === "write") {
		const p = str(args.path);
		if (!p || /^[a-z]+:\/\//.test(p)) return [];
		const lines = str(args.content).replace(/\n$/, "").split("\n").length;
		return [{ path: p, diff: "", stat: { added: lines, removed: 0 }, op: "write" }];
	}
	if (details.perFileResults?.length) {
		return details.perFileResults.map(f => ({ path: f.path, diff: f.diff ?? "", stat: diffStat(f.diff ?? ""), op: f.op ?? "update" }));
	}
	const p = details.path ?? editPaths(name, args)[0];
	if (!p) return [];
	return [{ path: p, diff: details.diff ?? "", stat: diffStat(details.diff ?? ""), op: details.op ?? "update" }];
}
