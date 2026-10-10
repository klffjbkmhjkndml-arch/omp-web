import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SubagentSnapshot } from "../../../shared/api.ts";
import { app, useApp } from "../lib/app-store.ts";
import { tokens } from "../lib/format.ts";
import { Icon, Spinner } from "../lib/icons.tsx";
import type { SessionStore } from "../lib/session-store.ts";
import { buildTurns, toolLabel, turnSteps } from "../lib/turns.ts";
import { gateway } from "../lib/ws.ts";
import { Turn } from "./Turn.tsx";

const STATE: Record<string, string> = { pending: "等待", running: "运行中", completed: "完成", failed: "失败", aborted: "已停止" };
const POLL_MS = 1500;

interface Progress {
	currentTool?: string;
	currentToolArgs?: string;
	currentToolIntent?: string;
	lastIntent?: string;
	toolCount?: number;
	tokens?: number;
}

function live(s: SubagentSnapshot | undefined): boolean {
	return s?.status === "running" || s?.status === "pending";
}

/** What the subagent is doing right now, in one line. */
function activity(s: SubagentSnapshot): string {
	const p = (s.progress ?? {}) as Progress;
	if (p.currentToolIntent) return p.currentToolIntent;
	if (p.currentTool) {
		const label = toolLabel(p.currentTool, {});
		return `${label.verb}${p.currentToolArgs ? ` ${p.currentToolArgs}` : ""}`;
	}
	return p.lastIntent ?? "思考中";
}

/** Right panel "子代理" page: list on top, the selected subagent's live progress and transcript below. */
export function AgentsPanel({ store }: { store: SessionStore }) {
	const a = useApp();
	const all = [...store.subagents.values()].sort((x, y) => Number(live(y)) - Number(live(x)) || y.lastUpdate - x.lastUpdate);
	const selectedId = a.selectedSubagent && store.subagents.has(a.selectedSubagent) ? a.selectedSubagent : all[0]?.id;
	const selected = selectedId ? store.subagents.get(selectedId) : undefined;

	if (all.length === 0) {
		return <div className="ins-empty">这个会话还没有派发子代理。模型调用 task 工具后，进度会显示在这里。</div>;
	}
	return (
		<div className="agents">
			<div className="agents-list">
				{all.map(s => (
					<button key={s.id} className={`agent-row ${s.id === selectedId ? "on" : ""}`} onClick={() => app.selectSubagent(s.id)}>
						{live(s) ? <Spinner size={11} /> : <span className={`dot ${s.status}`} />}
						<span className="agent-name">{s.agent}</span>
						<span className="agent-desc">{s.description ?? s.task ?? ""}</span>
						<span className={`state ${s.status}`}>{STATE[s.status] ?? s.status}</span>
					</button>
				))}
			</div>
			{selected && <AgentDetail key={selected.id} store={store} agent={selected} />}
		</div>
	);
}

function AgentDetail({ store, agent }: { store: SessionStore; agent: SubagentSnapshot }) {
	const [messages, setMessages] = useState<AgentMessage[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string>();
	const [taskOpen, setTaskOpen] = useState(false);
	const [steer, setSteer] = useState("");
	const cursor = useRef(0);
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const running = live(agent);
	const p = (agent.progress ?? {}) as Progress;
	// Synthetic index-keyed entries have no transcript id yet.
	const fetchable = !agent.id.startsWith("index:");

	// Incremental transcript: `fromByte`/`nextByte` so polling only reads what was appended.
	useEffect(() => {
		if (!fetchable) return;
		let alive = true;
		let fails = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const pull = async () => {
			try {
				const data = await gateway.rpc<{ messages?: AgentMessage[]; nextByte?: number; reset?: boolean }>(store.key, {
					type: "get_subagent_messages",
					subagentId: agent.id,
					fromByte: cursor.current,
				});
				if (!alive) return;
				fails = 0;
				cursor.current = data?.nextByte ?? cursor.current;
				const fresh = data?.messages ?? [];
				if (data?.reset) setMessages(fresh);
				else if (fresh.length > 0) setMessages(prev => [...prev, ...fresh]);
				setLoaded(true);
				setError(undefined);
			} catch (e) {
				if (!alive) return;
				fails++;
				setError((e as Error).message);
			}
			if (!alive || !running) return;
			// Back off while the gateway is unreachable; poll lazily in hidden tabs.
			const delay = Math.min(POLL_MS * 2 ** fails, 15_000) * (document.hidden ? 4 : 1);
			timer = setTimeout(() => void pull(), delay);
		};
		void pull();
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [store.key, agent.id, running, fetchable]);

	const turns = useMemo(() => buildTurns(messages), [messages]);

	useEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [turns, p.currentTool, p.currentToolIntent]);

	const sendSteer = async () => {
		const message = steer.trim();
		if (!message) return;
		try {
			await gateway.rpc(store.key, { type: "steer_subagent", subagentId: agent.id, message });
			setSteer("");
		} catch (e) {
			store.notify("error", `追加指令失败：${(e as Error).message}`);
		}
	};

	return (
		<div className="agent-detail">
			<div className="agent-head">
				<div className="agent-title">
					<b>{agent.agent}</b>
					<span className={`state ${agent.status}`}>{STATE[agent.status] ?? agent.status}</span>
				</div>
				<div className="agent-meta">
					{typeof p.toolCount === "number" && <span>工具 {p.toolCount} 次</span>}
					{typeof p.tokens === "number" && p.tokens > 0 && <span>{tokens(p.tokens)} tokens</span>}
				</div>
				{(agent.task ?? agent.description) && (
					<button className={`agent-task ${taskOpen ? "open" : ""}`} onClick={() => setTaskOpen(o => !o)} title={taskOpen ? "收起" : "展开任务"}>
						{agent.task ?? agent.description}
					</button>
				)}
			</div>
			<div
				className="agent-transcript"
				ref={scroller}
				onScroll={e => {
					const el = e.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
				}}
			>
				{error && <div className="err-text">{error}</div>}
				{!loaded && !error && fetchable && <div className="muted">正在读取过程…</div>}
				{loaded && turns.length === 0 && <div className="muted">还没有输出</div>}
				{turns.map(t => (
					<Turn key={t.key} turn={t} steps={turnSteps(t)} running={false} cwd={store.state?.cwd} defaultOpen compact />
				))}
				{running && (
					<div className="agent-now">
						<Spinner size={11} />
						<span className="shimmer">{activity(agent)}</span>
					</div>
				)}
			</div>
			{running && (
				<div className="agent-foot">
					<input
						className="text-input"
						placeholder="给它追加指令，Enter 发送"
						value={steer}
						onChange={e => setSteer(e.target.value)}
						onKeyDown={e => e.key === "Enter" && !e.nativeEvent.isComposing && void sendSteer()}
					/>
					<button
						className="btn ghost"
						title="停止这个子代理"
						onClick={() => void gateway.rpc(store.key, { type: "cancel_subagent", subagentId: agent.id }).catch(e => store.notify("error", (e as Error).message))}
					>
						<Icon name="stop" size={12} />
						停止
					</button>
				</div>
			)}
		</div>
	);
}
