import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ImageContent } from "../../../shared/api.ts";
import { app, useApp, useSession } from "../lib/app-store.ts";
import { Icon, Spinner } from "../lib/icons.tsx";
import type { SessionStore } from "../lib/session-store.ts";
import { baseName, buildTurns, type Step, type Turn as TurnModel, turnSteps } from "../lib/turns.ts";
import { gateway } from "../lib/ws.ts";
import { Composer, type SendMode } from "./Composer.tsx";
import { Inspector } from "./Inspector.tsx";
import { type ModelChoice, ModelMenu, ModelPicker } from "./ModelMenu.tsx";
import { Turn } from "./Turn.tsx";
import { UiCard } from "./UiCard.tsx";

export function SessionView({ sessionKey }: { sessionKey: string }) {
	const a = useApp();
	const store = useSession(app.store(sessionKey));
	const summary = a.sessions.find(s => s.path.toLowerCase() === store.key.toLowerCase());
	const title = store.state?.sessionName || summary?.title || "新会话";
	const cwd = store.state?.cwd || summary?.cwd || "";
	const running = store.isRunning;
	const [showJump, setShowJump] = useState(false);
	const jumpRef = useRef<() => void>(undefined);

	useEffect(() => {
		document.title = `${title} · Oh My Pi`;
	}, [title]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && running && !document.querySelector(".pop, .scrim")) void stop(store);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [running, store]);

	return (
		<div className="main">
			<div className="main-col">
				<header className="header">
					{a.prefs.sidebarCollapsed && (
						<button className="icon-btn" title="展开侧栏" onClick={() => app.setPrefs({ sidebarCollapsed: false })}>
							<Icon name="panelLeft" />
						</button>
					)}
					<span className="title">{title}</span>
					{cwd && (
						<span className="crumb" title={cwd}>
							<Icon name="folder" size={13} />
							{baseName(cwd)}
						</span>
					)}
					<span className="spacer" />
					<button className={`icon-btn ${a.prefs.inspectorOpen ? "active" : ""}`} title="会话信息" onClick={() => app.setPrefs({ inspectorOpen: !a.prefs.inspectorOpen })}>
						<Icon name="panelRight" />
					</button>
				</header>
				{store.status === "starting" && store.messages.length === 0 ? (
					<div className="center-state">
						<div>
							<Spinner size={18} />
							<div style={{ marginTop: 12 }}>正在打开会话…</div>
						</div>
					</div>
				) : store.status === "exited" && store.messages.length === 0 ? (
					<div className="center-state">
						<div>
							{store.lostModel ? (
								<ReopenWithModel store={store} lost={store.lostModel} />
							) : (
								<>
									<div>会话进程已退出</div>
									{store.error && <div className="err">{store.error}</div>}
									<button className="btn" onClick={() => reconnectSession(store)}>
										重新打开
									</button>
								</>
							)}
						</div>
					</div>
				) : (
					<Thread store={store} onJumpChange={setShowJump} jumpRef={jumpRef} onOpenSubagent={id => app.showSubagent(id)} onFork={turn => void forkTurn(store, turn)} />
				)}
				<div className="dock">
					{showJump && (
						<button className="jump" onClick={() => jumpRef.current?.()}>
							<Icon name="chevronDown" size={14} />
							回到底部
						</button>
					)}
					<div className="col composer-wrap">
						<BottomStack store={store} />
					</div>
				</div>
			</div>
			{a.prefs.inspectorOpen && <Inspector store={store} onClose={() => app.setPrefs({ inspectorOpen: false })} />}
		</div>
	);
}

async function stop(store: SessionStore): Promise<void> {
	try {
		await gateway.rpc(store.key, { type: "abort" });
	} catch (e) {
		store.notify("error", `停止失败：${(e as Error).message}`);
	}
}

/** Re-attach after the process exited: the gateway spawns a fresh one from the session file. */
function reconnectSession(store: SessionStore, model?: string): void {
	store.markReconnecting();
	gateway.attach(store.key, model);
}

/**
 * The session's saved model no longer exists (provider removed or renamed) and
 * the default role did not start either. Preselect the same model id under
 * another provider, else the last used model, else the first one listed.
 */
function ReopenWithModel({ store, lost }: { store: SessionStore; lost: string }) {
	const a = useApp();
	const lostId = lost.slice(lost.indexOf("/") + 1);
	const last = a.prefs.lastModel;
	const initial =
		a.models.find(m => m.id === lostId) ?? (last ? a.models.find(m => m.provider === last.provider && m.id === last.id) : undefined) ?? a.models[0];
	const [picked, setPick] = useState<ModelChoice | undefined>();
	const pick = picked ?? initial;

	useEffect(() => {
		void app.loadModelsWithoutSession();
	}, []);

	return (
		<>
			<div>此会话保存的模型已不可用</div>
			<div className="hint">{lost} 不在当前的模型列表里，选一个模型继续，之后会记在会话里。</div>
			<div className="reopen-row">
				<ModelPicker current={pick} efforts={[]} models={a.models} hidden={a.prefs.hiddenModels} onPick={m => setPick(m)} onLevel={() => {}} />
				<button className="btn" disabled={!pick} onClick={() => pick && reconnectSession(store, `${pick.provider}/${pick.id}`)}>
					用此模型打开
				</button>
			</div>
		</>
	);
}

/**
 * Fork from the turn's last assistant message: `get_entries` gives the stored
 * entry ids, and `fork` writes a new session the gateway then rekeys onto.
 */
async function forkTurn(store: SessionStore, turn: TurnModel): Promise<void> {
	try {
		const { entries } = await gateway.rpc<{ entries: Record<string, unknown>[] }>(store.key, { type: "get_entries" });
		const last = [...turn.messages].reverse().find(m => (m as { role?: string }).role === "assistant") as { timestamp?: number } | undefined;
		const entry = entries.find(
			e =>
				e.type === "message" &&
				(e.message as { role?: string } | undefined)?.role === "assistant" &&
				(e.message as { timestamp?: number } | undefined)?.timestamp === last?.timestamp,
		);
		if (!entry) {
			store.notify("error", "找不到这个回合的分叉点");
			return;
		}
		await gateway.rpc(store.key, { type: "fork", entryId: String(entry.id) });
	} catch (e) {
		store.notify("error", `分叉失败：${(e as Error).message}`);
	}
}

function Thread({
	store,
	onJumpChange,
	jumpRef,
	onOpenSubagent,
	onFork,
}: {
	store: SessionStore;
	onJumpChange: (visible: boolean) => void;
	jumpRef: React.RefObject<(() => void) | undefined>;
	onOpenSubagent: (id: string) => void;
	onFork: (turn: TurnModel) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);
	jumpRef.current = () => {
		atBottom.current = true;
		onJumpChange(false);
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
	};
	const turns = useMemo(() => buildTurns(store.messages), [store.messages]);
	const running = store.isRunning;

	// Settled turns keep stable step arrays so memoized <Turn> skips re-rendering during streams.
	const settled = useMemo(() => {
		const map = new Map<string, Step[]>();
		turns.forEach((t, i) => {
			if (i < turns.length - 1) map.set(t.key, turnSteps(t));
		});
		return map;
	}, [turns]);
	const last = turns[turns.length - 1];
	const lastSteps = last ? turnSteps(last, running ? store.drafts.values() : undefined, running ? store.tools : undefined) : [];

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && atBottom.current) el.scrollTop = el.scrollHeight;
	});

	useLayoutEffect(() => {
		atBottom.current = true;
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [store.key]);

	const onScroll = () => {
		const el = scroller.current;
		if (!el) return;
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
		atBottom.current = near;
		onJumpChange(!near);
	};

	return (
		<div className="scroll" ref={scroller} onScroll={onScroll}>
			<div className="col thread">
				{turns.length === 0 && !running && <div className="center-state" style={{ minHeight: "40vh" }}>发送一条消息开始</div>}
				{turns.map((t, i) =>
					i < turns.length - 1 ? (
						<Turn key={t.key} turn={t} steps={settled.get(t.key) ?? []} running={false} cwd={store.state?.cwd} subagents={store.subagents} onOpenSubagent={onOpenSubagent} onFork={onFork} />
					) : (
						<Turn
							key={t.key}
							turn={t}
							steps={lastSteps}
							running={running}
							runStartedAt={store.runStartedAt}
							cwd={store.state?.cwd}
							subagents={store.subagents}
							onOpenSubagent={onOpenSubagent}
							onFork={onFork}
						/>
					),
				)}
			</div>
		</div>
	);
}

function BottomStack({ store }: { store: SessionStore }) {
	const running = store.isRunning;
	const queued = store.state?.queuedMessages;
	const queueItems = [...(queued?.steering ?? []).map(t => ({ t, q: "steering" as const })), ...(queued?.followUp ?? []).map(t => ({ t, q: "followUp" as const }))];
	const usage = store.state?.contextUsage;

	const send = async (text: string, mode: SendMode, images?: ImageContent[]) => {
		// Always `prompt`: omp decides. Idle → a normal turn; busy → queued per streamingBehavior.
		// (A client-side guess about "running" must never turn a fresh message into a steer.)
		// Enter sends "steer" and Alt+Enter "followUp"; the setting can swap the two.
		const queued = (mode === "followUp") !== (app.prefs.enterWhileRunning === "followUp");
		const cmd = { type: "prompt", message: text, images, streamingBehavior: queued ? "followUp" : "steer" };
		try {
			await gateway.rpc(store.key, cmd);
		} catch (e) {
			store.notify("error", `发送失败：${(e as Error).message}`);
		}
	};

	// Re-attaching makes the gateway spawn a fresh process for this session file.
	const reconnect = () => reconnectSession(store);

	return (
		<>
			{store.pendingUi.map(r => (
				<UiCard key={r.id} req={r} onAnswer={p => gateway.ui(store.key, p)} />
			))}
			<Composer
				draftKey={store.key}
				autoFocus
				running={running}
				placeholder={
					running
						? app.prefs.enterWhileRunning === "followUp"
							? "消息会排到下一轮（Alt+Enter 插入当前回合）"
							: "补充说明会插入当前回合（Alt+Enter 排到下一轮）"
						: undefined
				}
				disabled={store.status !== "ready"}
				onSend={send}
				onStop={() => void stop(store)}
				onNotice={(text, level) => store.notify(level ?? "info", text)}
				commands={store.commands}
				fileCwd={store.state?.cwd}
				modelSupportsImages={store.state?.model?.input?.includes("image")}
				above={
					<>
						{store.status === "exited" && store.messages.length > 0 && (
							<div className="reconnect">
								<div className="reconnect-text">
									<b>会话进程已结束</b>
									{store.error && (
										<span className="why" title={store.error}>
											{errorSummary(store.error)}
										</span>
									)}
								</div>
								<button className="btn primary" onClick={reconnect}>
									重新连接
								</button>
							</div>
						)}
						{queueItems.length > 0 && (
							<div className="queue">
								{queueItems.map(({ t, q }, i) => (
									<div key={`${q}${i}`} className="queue-item">
										<span className="kind">{q === "steering" ? "插入" : "排队"}</span>
										<span className="txt">{t}</span>
										<button className="icon-btn" style={{ width: 24, height: 24 }} title="撤回" onClick={() => void gateway.rpc(store.key, { type: "remove_queued_message", message: t, queue: q }).catch(() => {})}>
											<Icon name="x" size={13} />
										</button>
									</div>
								))}
							</div>
						)}
					</>
				}
				right={<ModelMenu store={store} />}
			/>
			<div className="composer-hint">
				<span className="activity">
					{store.activity && (
						<>
							<Spinner size={11} />
							{store.activity}
						</>
					)}
				</span>
				<span>{usage && usage.contextWindow ? `上下文 ${Math.round(usage.percent)}%` : ""}</span>
			</div>
		</>
	);
}

/** Last non-empty line of the exit error, trimmed for the card; the whole text stays in `title`. */
function errorSummary(error: string): string {
	const line = error.split("\n").map(s => s.trim()).filter(Boolean).pop() ?? error;
	return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}
