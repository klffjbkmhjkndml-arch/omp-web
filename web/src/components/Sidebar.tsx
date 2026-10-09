import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionSummary } from "../../../shared/api.ts";
import { app, type ProjectFilter, useApp } from "../lib/app-store.ts";
import { relativeTime } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { api, gateway } from "../lib/ws.ts";
import { Popover } from "./Popover.tsx";
import { FolderDialog } from "./ProjectPicker.tsx";

const PAGE = 6;
const FILTERS: [ProjectFilter, string][] = [
	["all", "全部项目"],
	["manual", "仅手动选择"],
	["recent", "按最近活动"],
];
const RECENT_DAYS = [1, 3, 7, 14, 30];
const DAY_MS = 24 * 60 * 60 * 1000;

function key(p: string): string {
	return p.replace(/[\\/]+$/, "").toLowerCase();
}

export function Sidebar() {
	const a = useApp();
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Record<string, number>>({});
	const [browse, setBrowse] = useState(false);
	const [filterOpen, setFilterOpen] = useState(false);
	const filterBtn = useRef<HTMLButtonElement>(null);
	const connected = useSyncExternalStore(gateway.onStatus.bind(gateway), () => gateway.connected);

	const byProject = useMemo(() => {
		const map = new Map<string, SessionSummary[]>();
		for (const s of a.sessions) {
			const k = key(s.cwd);
			let list = map.get(k);
			if (!list) map.set(k, (list = []));
			list.push(s);
		}
		return map;
	}, [a.sessions]);

	// Newest real session per project, by message time: a file mtime is bumped by
	// omp's own bookkeeping writes (model_change, session_exit), which used to make
	// idle projects — and pinned ones — look active forever.
	const activeAt = useMemo(() => {
		const map = new Map<string, number>();
		for (const s of a.sessions) {
			const k = key(s.cwd);
			const at = s.activeAt || s.modified;
			map.set(k, Math.max(map.get(k) ?? 0, at));
		}
		return map;
	}, [a.sessions]);

	// The project of the open session always stays listed, whatever the filter says.
	const routeProject = useMemo(() => {
		if (!a.route) return undefined;
		const session = a.sessions.find(s => key(s.path) === key(a.route as string));
		return session?.cwd ? key(session.cwd) : undefined;
	}, [a.route, a.sessions]);

	const projects = useMemo(() => {
		const { projectFilter, visibleProjects, recentDays } = a.prefs;
		if (projectFilter === "all") return a.projects;
		const cutoff = Date.now() - recentDays * DAY_MS;
		return a.projects.filter(p => {
			if (routeProject && key(p.path) === routeProject) return true;
			if (projectFilter === "manual") return visibleProjects.some(v => key(v) === key(p.path));
			return (activeAt.get(key(p.path)) ?? 0) > cutoff;
		});
	}, [a.projects, a.sessions, a.prefs.projectFilter, a.prefs.visibleProjects, a.prefs.recentDays, routeProject, activeAt]);
	const hiddenProjects = a.projects.length - projects.length;

	const q = query.trim().toLowerCase();
	const collapsed = new Set(a.prefs.collapsedProjects.map(key));
	const toggle = (path: string) => {
		const k = key(path);
		const next = collapsed.has(k) ? a.prefs.collapsedProjects.filter(p => key(p) !== k) : [...a.prefs.collapsedProjects, path];
		app.setPrefs({ collapsedProjects: next });
	};

	return (
		<aside className="sidebar">
			<div className="sb-top">
				<div className="brand">
					<span className="brand-mark">π</span>
					<span>Oh My Pi</span>
				</div>
				<button className="icon-btn" title="收起侧栏" onClick={() => app.setPrefs({ sidebarCollapsed: true })}>
					<Icon name="panelLeft" />
				</button>
			</div>
			<div className="sb-actions">
				<button className={`sb-item ${a.route === undefined ? "active" : ""}`} onClick={() => app.open(undefined)}>
					<Icon name="newChat" />
					<span>新会话</span>
				</button>
				<label className="sb-search">
					<Icon name="search" />
					<input placeholder="搜索会话" value={query} onChange={e => setQuery(e.target.value)} />
				</label>
			</div>
			<div className="sb-section">
				<span>项目</span>
				<button
					ref={filterBtn}
					className={`icon-btn ${filterOpen || a.prefs.projectFilter !== "all" ? "active" : ""}`}
					title="项目显示范围"
					onClick={() => setFilterOpen(o => !o)}
				>
					<Icon name="sliders" size={15} />
				</button>
				<button className="icon-btn" title="添加项目" onClick={() => setBrowse(true)}>
					<Icon name="plus" size={15} />
				</button>
			</div>
			{filterOpen && (
				<Popover anchor={filterBtn} onClose={() => setFilterOpen(false)} width={270}>
					<div className="pop-title">显示范围</div>
					{FILTERS.map(([id, label]) => (
						<button key={id} className="pop-item" onClick={() => app.setProjectFilter(id)}>
							<span className="check">{a.prefs.projectFilter === id && <Icon name="check" size={15} />}</span>
							<span className="main-label">{label}</span>
						</button>
					))}
					{a.prefs.projectFilter === "recent" && (
						<>
							<div className="pop-sep" />
							<div className="seg-row">
								<span>最近</span>
								<div className="seg">
									{RECENT_DAYS.map(d => (
										<button key={d} className={a.prefs.recentDays === d ? "on" : ""} onClick={() => app.setPrefs({ recentDays: d })}>
											{d} 天
										</button>
									))}
								</div>
							</div>
							<div className="pop-note">按最新会话的时间筛选：只钉住、还没聊过的项目也会隐藏；当前打开的会话所属项目保留</div>
						</>
					)}
					{a.prefs.projectFilter === "manual" && (
						<>
							<div className="pop-sep" />
							<div className="pop-title">
								显示哪些项目
								<span className="pop-title-actions">
									<button onClick={() => app.setPrefs({ visibleProjects: a.projects.map(p => p.path) })}>全选</button>
									<button onClick={() => app.setPrefs({ visibleProjects: [] })}>全不选</button>
								</span>
							</div>
							<div className="pop-list" style={{ maxHeight: 260 }}>
								{a.projects.map(p => {
									const on = a.prefs.visibleProjects.some(v => key(v) === key(p.path));
									return (
										<button key={p.path} className="pop-item" onClick={() => app.setProjectVisible(p.path, !on)}>
											<span className="check">{on && <Icon name="check" size={15} />}</span>
											<span className="main-label">{p.name}</span>
											<span className="sub">{p.sessionCount} 个会话</span>
										</button>
									);
								})}
								{a.projects.length === 0 && <div className="pop-note">还没有项目</div>}
							</div>
							{a.prefs.visibleProjects.length === 0 && <div className="pop-note">勾选要显示的项目；当前打开的会话所属项目始终保留</div>}
						</>
					)}
					{hiddenProjects > 0 && <div className="pop-note">当前隐藏了 {hiddenProjects} 个项目</div>}
				</Popover>
			)}
			<div className="sb-scroll">
				{projects.map(p => {
					let sessions = byProject.get(key(p.path)) ?? [];
					if (q) sessions = sessions.filter(s => s.title.toLowerCase().includes(q));
					if (q && sessions.length === 0 && !p.name.toLowerCase().includes(q)) return null;
					const isOpen = q ? true : !collapsed.has(key(p.path));
					const limit = expanded[key(p.path)] ?? PAGE;
					return (
						<div key={p.path}>
							<div className={`proj-row ${isOpen ? "open" : ""}`} role="button" tabIndex={0} title={p.path} onClick={() => toggle(p.path)}>
								<Icon name="chevronRight" size={13} className="chev" />
								<Icon name="folder" size={15} />
								<span className="name">{p.name}</span>
								<button
									className="icon-btn hover-only"
									title="在此项目新建会话"
									onClick={e => {
										e.stopPropagation();
										app.setDraftProject(p.path);
										app.open(undefined);
									}}
								>
									<Icon name="newChat" size={14} />
								</button>
							</div>
							{isOpen && (
								<div className="sess-list">
									{sessions.slice(0, limit).map(s => (
										<SessionRow key={s.path} s={s} active={a.route !== undefined && key(a.route) === key(s.path)} />
									))}
									{sessions.length > limit && (
										<button className="more-row" onClick={() => setExpanded(x => ({ ...x, [key(p.path)]: limit + 20 }))}>
											显示更多（{sessions.length - limit}）
										</button>
									)}
									{sessions.length === 0 && !q && <div className="more-row" style={{ cursor: "default" }}>暂无会话</div>}
								</div>
							)}
						</div>
					);
				})}
				{a.indexLoaded && projects.length === 0 && <div className="more-row">{a.projects.length === 0 ? "还没有项目，点上方 + 添加" : "当前显示范围内没有项目，点漏斗图标调整"}</div>}
			</div>
			<div className="sb-foot">
				<button className="sb-item" onClick={() => app.openSettings()}>
					<Icon name="settings" />
					<span>设置</span>
					{!connected && (
						<span className="offline" title="与本机服务的连接已中断，正在自动重连">
							<i />
							连接中断
						</span>
					)}
				</button>
			</div>
			{browse && <FolderDialog onClose={() => setBrowse(false)} onPick={p => app.setDraftProject(p)} />}
		</aside>
	);
}

function SessionRow({ s, active }: { s: SessionSummary; active: boolean }) {
	const more = useRef<HTMLButtonElement>(null);
	const [menu, setMenu] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [name, setName] = useState(s.title);
	const [busy, setBusy] = useState(false);

	const close = () => setMenu(false);

	const rename = async () => {
		const next = name.trim();
		setRenaming(false);
		if (!next || next === s.title) return;
		try {
			await api("/api/sessions/rename", { method: "POST", body: JSON.stringify({ path: s.path, name: next }) });
			void app.refreshIndex();
		} catch (e) {
			app.notify("error", `重命名失败：${(e as Error).message}`);
		}
	};

	const exportHtml = async () => {
		setBusy(true);
		close();
		try {
			const { name: file } = await api<{ name: string }>("/api/sessions/export", { method: "POST", body: JSON.stringify({ path: s.path }) });
			window.open(`/api/exports/${encodeURIComponent(file)}`, "_blank");
		} catch (e) {
			app.notify("error", `导出失败：${(e as Error).message}`);
		} finally {
			setBusy(false);
		}
	};

	if (renaming) {
		return (
			<div className="sess-row editing">
				<input
					autoFocus
					value={name}
					onChange={e => setName(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter") void rename();
						if (e.key === "Escape") setRenaming(false);
					}}
					onBlur={() => setRenaming(false)}
				/>
			</div>
		);
	}

	return (
		<>
			<div className={`sess-row ${active ? "active" : ""}`}>
				{/* No timestamp in the row: it squeezes long titles. Hover shows it instead. */}
				<button className="sess-open" onClick={() => app.open(s.path)} title={`${s.title}\n${relativeTime(s.activeAt || s.modified)}`}>
					<span className="title">{s.title}</span>
					{s.live && <span className={`live-dot ${s.live === "running" ? "running" : ""}`} title={s.live === "running" ? "运行中" : "已连接"} />}
				</button>
				<button ref={more} className="icon-btn hover-only" title="更多" onClick={() => setMenu(o => !o)}>
					<Icon name="more" size={15} />
				</button>
			</div>
			{menu && (
				<Popover anchor={more} onClose={close} width={200} align="end">
					<button
						className="pop-item"
						onClick={() => {
							setName(s.title);
							setRenaming(true);
							close();
						}}
					>
						<Icon name="edit" size={14} className="muted" />
						<span className="main-label">重命名</span>
					</button>
					<button className="pop-item" disabled={busy} onClick={() => void exportHtml()}>
						<Icon name="file" size={14} className="muted" />
						<span className="main-label">导出 HTML</span>
					</button>
					<button
						className="pop-item"
						onClick={() => {
							close();
							void app.setArchived(s.path, true).then(
								() => app.notify("info", `已归档「${s.title}」，可在 设置 → 已归档的会话 中恢复`),
								e => app.notify("error", `归档失败：${(e as Error).message}`),
							);
						}}
					>
						<Icon name="archive" size={14} className="muted" />
						<span className="main-label">归档</span>
					</button>
				</Popover>
			)}
		</>
	);
}
