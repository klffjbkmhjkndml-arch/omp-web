import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { FileView, FsTree, GitDiff, GitStatus } from "../../../shared/api.ts";
import { app, type InspectorTab, useApp } from "../lib/app-store.ts";
import { effortName, tokens } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { highlightCode, languageForFile } from "../lib/markdown.tsx";
import type { SessionStore } from "../lib/session-store.ts";
import { api } from "../lib/ws.ts";
import { AgentsPanel } from "./AgentsPanel.tsx";
import { Diff } from "./Turn.tsx";

const TABS: { id: InspectorTab; label: string }[] = [
	{ id: "info", label: "信息" },
	{ id: "agents", label: "子代理" },
	{ id: "files", label: "文件" },
	{ id: "changes", label: "改动" },
];

/** Right panel: session facts, the project's files, and its git changes. */
export function Inspector({ store, onClose }: { store: SessionStore; onClose: () => void }) {
	const a = useApp();
	const tab = a.prefs.inspectorTab;
	const cwd = store.state?.cwd;
	const runningAgents = [...store.subagents.values()].filter(s => s.status === "running" || s.status === "pending").length;
	return (
		<aside className="inspector">
			<div className="ins-head">
				<div className="ins-tabs">
					{TABS.map(t => (
						<button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => app.setPrefs({ inspectorTab: t.id })}>
							{t.label}
							{t.id === "agents" && runningAgents > 0 && <span className="tab-badge">{runningAgents}</span>}
						</button>
					))}
				</div>
				<span className="spacer" />
				<button className="icon-btn" onClick={onClose} title="关闭">
					<Icon name="x" />
				</button>
			</div>
			{tab === "info" && <InfoPage store={store} />}
			{tab === "agents" && <AgentsPanel store={store} />}
			{tab === "files" && (cwd ? <FilesPage cwd={cwd} /> : <div className="ins-empty">会话还没有工作目录</div>)}
			{tab === "changes" && (cwd ? <ChangesPage cwd={cwd} /> : <div className="ins-empty">会话还没有工作目录</div>)}
		</aside>
	);
}

function InfoPage({ store }: { store: SessionStore }) {
	const s = store.state;
	const usage = s?.contextUsage;
	const phases = s?.todoPhases ?? [];
	return (
		<div className="ins-body">
			{phases.some(p => p.tasks.length > 0) && (
				<section className="ins-sec">
					<h4>待办</h4>
					{phases.map(p => (
						<div key={p.name} className="todo-phase">
							{phases.length > 1 && <b>{p.name}</b>}
							{p.tasks.map((t, i) => (
								<div key={i} className={`todo-item ${t.status}`}>
									<span className="box">{t.status === "completed" && <Icon name="check" size={10} strokeWidth={3} />}</span>
									<span>{t.content}</span>
								</div>
							))}
						</div>
					))}
				</section>
			)}
			<section className="ins-sec">
				<h4>上下文</h4>
				{usage && usage.contextWindow ? (
					<>
						<div className="meter">
							<i style={{ width: `${Math.min(100, usage.percent)}%` }} />
						</div>
						<div className="muted" style={{ fontSize: "var(--fs-small)" }}>
							{tokens(usage.tokens)} / {tokens(usage.contextWindow)} tokens（{usage.percent.toFixed(1)}%）
						</div>
					</>
				) : (
					<div className="muted">暂无数据</div>
				)}
			</section>
			<section className="ins-sec">
				<h4>会话</h4>
				<dl className="kv">
					<dt>模型</dt>
					<dd>{s?.model ? `${s.model.provider}/${s.model.id}` : "—"}</dd>
					<dt>思考</dt>
					<dd>{effortName(s?.thinkingLevel) || "—"}</dd>
					<dt>消息</dt>
					<dd>{s?.messageCount ?? 0}</dd>
					<dt>目录</dt>
					<dd>{s?.cwd ?? "—"}</dd>
					<dt>文件</dt>
					<dd className="muted" style={{ fontSize: "var(--fs-small)" }}>
						{s?.sessionFile ?? "—"}
					</dd>
				</dl>
			</section>
		</div>
	);
}

/** Expandable project tree; clicking a file previews it below the tree. */
function FilesPage({ cwd }: { cwd: string }) {
	const [children, setChildren] = useState<Record<string, FsTree["entries"]>>({});
	const [openDirs, setOpenDirs] = useState<string[]>([]);
	const [preview, setPreview] = useState<FileView>();
	const [error, setError] = useState<string>();

	const load = useCallback(
		async (rel: string) => {
			try {
				const data = await api<FsTree>(`/api/fs/tree?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(rel)}`);
				setChildren(prev => ({ ...prev, [rel]: data.entries }));
			} catch (e) {
				setError((e as Error).message);
			}
		},
		[cwd],
	);

	useEffect(() => {
		setChildren({});
		setPreview(undefined);
		setOpenDirs([]);
		void load("");
	}, [load]);

	const toggle = (rel: string) => {
		setOpenDirs(prev => (prev.includes(rel) ? prev.filter(p => p !== rel) : [...prev, rel]));
		if (!children[rel]) void load(rel);
	};

	const openFile = async (rel: string) => {
		setError(undefined);
		try {
			setPreview(await api<FileView>(`/api/fs/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(rel)}`));
		} catch (e) {
			setError((e as Error).message);
		}
	};

	const rows: ReactNode[] = [];
	const walk = (rel: string, depth: number) => {
		for (const entry of children[rel] ?? []) {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			const open = openDirs.includes(child);
			rows.push(
				<button
					key={child}
					className={`tree-row ${preview?.path === child ? "on" : ""}`}
					style={{ paddingLeft: 8 + depth * 12 }}
					title={child}
					onClick={() => (entry.dir ? toggle(child) : void openFile(child))}
				>
					<Icon name={entry.dir ? (open ? "chevronDown" : "chevronRight") : "file"} size={13} className={entry.dir ? "" : "muted"} />
					<span className="tree-name">{entry.name}</span>
				</button>,
			);
			if (entry.dir && open) walk(child, depth + 1);
		}
	};
	walk("", 0);

	return (
		<>
			<div className="ins-tree">{rows.length > 0 ? rows : <div className="ins-empty">空目录</div>}</div>
			<div className="ins-preview">
				{error && <div className="err-text">{error}</div>}
				{preview && <FilePreview view={preview} cwd={cwd} />}
			</div>
		</>
	);
}

function FilePreview({ view, cwd }: { view: FileView; cwd: string }) {
	const head = (
		<div className="ins-preview-head">
			<span className="tree-name" title={view.path}>
				{view.path}
			</span>
			<span className="muted">{formatBytes(view.size)}</span>
		</div>
	);
	if (view.image) {
		return (
			<>
				{head}
				<img className="ins-image" src={`/api/fs/raw?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(view.path)}`} alt={view.path} />
			</>
		);
	}
	if (view.binary) {
		return (
			<>
				{head}
				<div className="muted">二进制文件，无法预览</div>
			</>
		);
	}
	const language = languageForFile(view.path);
	return (
		<>
			{head}
			<pre className="ins-code">
				<code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(view.text ?? "", language) }} />
			</pre>
			{view.truncated && <div className="muted">文件较大，仅显示前 256 KB</div>}
		</>
	);
}

/** git prints work-tree relative paths; an edit card hands over cwd relative ones. */
function samePathName(a: string, b: string): boolean {
	const x = a.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
	const y = b.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
	return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** Git status list; a row shows its diff below. */
function ChangesPage({ cwd }: { cwd: string }) {
	const a = useApp();
	const [status, setStatus] = useState<GitStatus>();
	const [diff, setDiff] = useState<GitDiff>();
	const [error, setError] = useState<string>();
	const selected = a.inspectFile;
	const files = status?.files ?? [];
	const rowPath = selected ? (files.find(f => samePathName(f.path, selected))?.path ?? selected) : undefined;

	useEffect(() => {
		setStatus(undefined);
		setDiff(undefined);
		let alive = true;
		void api<GitStatus>(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
			.then(data => alive && setStatus(data))
			.catch((e: Error) => alive && setError(e.message));
		return () => {
			alive = false;
		};
		// `selected` is included so a jump from a change card re-reads the list even
		// though this page was already mounted (and showing a stale, clean tree).
	}, [cwd, selected]);

	useEffect(() => {
		if (!rowPath) {
			setDiff(undefined);
			return;
		}
		let alive = true;
		void api<GitDiff>(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(rowPath)}`)
			.then(data => alive && setDiff(data))
			.catch((e: Error) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, [cwd, rowPath]);

	if (error) return <div className="ins-empty">{error}</div>;
	if (!status) return <div className="ins-empty">正在读取改动…</div>;
	if (status.notRepo) return <div className="ins-empty">此项目不是 Git 仓库</div>;
	if (files.length === 0) return <div className="ins-empty">工作区干净，没有改动</div>;

	return (
		<>
			<div className="ins-tree">
				{files.map(f => (
					<button key={f.path} className={`git-row ${selected && samePathName(f.path, selected) ? "on" : ""}`} title={f.path} onClick={() => app.selectInspectFile(f.path)}>
						<span className={`git-flag ${f.x === "?" ? "new" : f.x === "D" || f.y === "D" ? "del" : "mod"}`}>{(f.x === "?" ? "??" : `${f.x}${f.y}`).trim()}</span>
						<span className="tree-name">{f.path}</span>
					</button>
				))}
			</div>
			<div className="ins-preview">
				{rowPath ? (
					<>
						<div className="ins-preview-head">
							<span className="tree-name" title={rowPath}>
								{rowPath}
							</span>
						</div>
						{diff ? (
							<>
								<Diff text={diff.diff || "（没有内容差异）"} />
								{diff.untracked && <div className="muted">未跟踪的文件，按全新增显示</div>}
								{diff.truncated && <div className="muted">diff 超过 512 KB，已截断</div>}
							</>
						) : (
							<div className="muted">正在读取 diff…</div>
						)}
					</>
				) : (
					<div className="muted">选择上面的文件查看 diff</div>
				)}
			</div>
		</>
	);
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
