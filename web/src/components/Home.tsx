import { useEffect, useState } from "react";
import type { ImageContent } from "../../../shared/api.ts";
import { app, useApp } from "../lib/app-store.ts";
import { relativeTime } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { baseName } from "../lib/turns.ts";
import { Composer, type SendMode } from "./Composer.tsx";
import { type ModelChoice, ModelPicker } from "./ModelMenu.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";

/** How many recent sessions the home screen lists. */
const RECENT_LIMIT = 5;

function pathKey(p: string): string {
	return p.replace(/[\\/]+$/, "").toLowerCase();
}

/** New-session screen. No omp process exists until the first message is sent. */
export function Home() {
	const a = useApp();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const dismissed = new Set(a.prefs.dismissedRecent.map(pathKey));
	const recent = a.sessions.filter(s => !dismissed.has(pathKey(s.path))).slice(0, RECENT_LIMIT);
	const hiddenCount = a.sessions.filter(s => dismissed.has(pathKey(s.path))).length;

	useEffect(() => {
		document.title = "Oh My Pi";
	}, []);

	const send = async (text: string, _mode: SendMode, images?: ImageContent[]) => {
		if (!a.draftProject) {
			setError("请先选择项目文件夹");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await app.startSession(a.draftProject, text, images);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="main">
			<div className="main-col">
				<header className="header">
					{a.prefs.sidebarCollapsed && (
						<button className="icon-btn" title="展开侧栏" onClick={() => app.setPrefs({ sidebarCollapsed: false })}>
							<Icon name="panelLeft" />
						</button>
					)}
				</header>
				<div className="home">
					<h1>
						<span className="brand-mark">π</span>
						有什么要做的？
					</h1>
					<div className="composer-wrap">
						<Composer
							autoFocus
							draftKey="home"
							disabled={busy}
							placeholder={busy ? "正在启动会话…" : "描述任务，Enter 发送"}
							onSend={send}
							onNotice={text => setError(text)}
							left={<ProjectPicker />}
							right={<HomeModelPicker />}
							fileCwd={a.draftProject}
						/>
					</div>
					{error && <div className="err-text" style={{ marginTop: 10 }}>{error}</div>}
					{a.sessions.length > 0 && (
						<div className="home-recent">
							<div className="recent-head">
								<button className="recent-toggle" title={a.prefs.recentCollapsed ? "展开" : "收起"} onClick={() => app.setPrefs({ recentCollapsed: !a.prefs.recentCollapsed })}>
									<Icon name={a.prefs.recentCollapsed ? "chevronRight" : "chevronDown"} size={12} />
									<span>最近会话</span>
									{recent.length > 0 && <span className="count">{recent.length}</span>}
								</button>
								{hiddenCount > 0 && (
									<button className="recent-restore" onClick={() => app.restoreRecent()}>
										恢复隐藏（{hiddenCount}）
									</button>
								)}
							</div>
							{!a.prefs.recentCollapsed && (
								<div className="recent-list">
									{recent.map(s => (
										<div key={s.path} className="recent-row">
											<button className="pop-item" onClick={() => app.open(s.path)}>
												<span className="main-label">{s.title}</span>
												<span className="sub">
													{baseName(s.cwd)} · {relativeTime(s.activeAt || s.modified)}
												</span>
											</button>
											<button
												className="icon-btn recent-x"
												title="从最近会话里隐藏"
												onClick={() => app.dismissRecent(s.path)}
											>
												<Icon name="x" size={13} />
											</button>
										</div>
									))}
									{recent.length === 0 && <div className="recent-note">最近会话都隐藏了</div>}
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * Home picker. No omp process exists yet, so a pick only remembers the choice;
 * `startSession` applies it with `set_model` / `set_thinking_level` before the
 * first prompt. The list comes from the cached `models` list, not the gateway.
 */
function HomeModelPicker() {
	const a = useApp();
	const lock = a.modelLock;
	const remembered = a.prefs.lastModel;
	const cached = remembered ? a.models.find(m => m.provider === remembered.provider && m.id === remembered.id) : undefined;
	const current: ModelChoice | undefined = remembered ? { provider: remembered.provider, id: remembered.id, name: cached?.name } : undefined;
	const lockCached = lock ? a.models.find(m => m.provider === lock.provider && m.id === lock.model) : undefined;
	const lockedTo: ModelChoice | undefined = lock ? { provider: lock.provider, id: lock.model, name: lockCached?.name } : undefined;
	const efforts = cached?.reasoning ? ["off", ...(cached.efforts ?? [])] : [];

	return (
		<ModelPicker
			current={current}
			level={remembered?.level}
			efforts={efforts}
			models={a.models}
			hidden={a.prefs.hiddenModels}
			lockedTo={lockedTo}
			onPick={m => app.rememberModel({ provider: m.provider, id: m.id, level: remembered?.level })}
			onLevel={l => {
				if (remembered) app.rememberModel({ ...remembered, level: l });
			}}
		/>
	);
}
