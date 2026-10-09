import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderConfig, ProviderModel, ProvidersView } from "../../../shared/api.ts";
import { app, type SettingsPage, useApp } from "../lib/app-store.ts";
import { relativeTime, tokens } from "../lib/format.ts";
import { Icon, type IconName } from "../lib/icons.tsx";
import { baseName } from "../lib/turns.ts";
import { api } from "../lib/ws.ts";

const PAGES: { id: SettingsPage; label: string; icon: IconName }[] = [
	{ id: "general", label: "通用", icon: "sliders" },
	{ id: "providers", label: "模型供应商", icon: "bolt" },
	{ id: "archived", label: "已归档的会话", icon: "archive" },
	{ id: "about", label: "关于", icon: "info" },
];

/** Settings window: left navigation, grouped cards on the right (Kimi / Codex layout). */
export function SettingsDialog() {
	const a = useApp();
	const page = a.settingsPage;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".pop") && app.closeSettings();
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);
	if (!page) return null;
	return createPortal(
		<div className="scrim" onPointerDown={e => e.target === e.currentTarget && app.closeSettings()}>
			<div className="settings" role="dialog" aria-modal="true" aria-label="设置">
				<nav className="settings-nav">
					<div className="settings-title">设置</div>
					{PAGES.map(p => (
						<button key={p.id} className={`settings-nav-item ${page === p.id ? "on" : ""}`} onClick={() => app.openSettings(p.id)}>
							<Icon name={p.icon} size={16} />
							<span>{p.label}</span>
							{p.id === "archived" && a.archived.length > 0 && <span className="nav-count">{a.archived.length}</span>}
						</button>
					))}
				</nav>
				<div className="settings-body">
					<button className="icon-btn settings-close" onClick={() => app.closeSettings()} title="关闭（Esc）">
						<Icon name="x" />
					</button>
					<div className="settings-scroll">
						{page === "general" && <GeneralPage />}
						{page === "providers" && <ProvidersPage />}
						{page === "archived" && <ArchivedPage />}
						{page === "about" && <AboutPage />}
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="set-section">
			<h3>{title}</h3>
			<div className="set-card">{children}</div>
		</section>
	);
}

function Row({ title, desc, children }: { title: string; desc?: ReactNode; children?: ReactNode }) {
	return (
		<div className="set-row">
			<div className="set-text">
				<div className="set-name">{title}</div>
				{desc && <div className="set-desc">{desc}</div>}
			</div>
			{children && <div className="set-control">{children}</div>}
		</div>
	);
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void }) {
	return (
		<div className="seg set-seg">
			{options.map(([v, label]) => (
				<button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
					{label}
				</button>
			))}
		</div>
	);
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
	return <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)} />;
}

function GeneralPage() {
	const { prefs } = useApp();
	const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);

	const setNotify = async (on: boolean) => {
		if (!on) return app.setPrefs({ notify: false });
		if (typeof Notification === "undefined") return;
		const result = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
		setPermission(result);
		app.setPrefs({ notify: result === "granted" });
	};

	return (
		<>
			<h2 className="set-h2">通用</h2>
			<Section title="外观">
				<Row title="主题" desc="选择界面的明暗外观">
					<Seg
						value={prefs.theme}
						options={[
							["light", <><Icon name="sun" size={14} />浅色</>],
							["dark", <><Icon name="moon" size={14} />深色</>],
							["system", "跟随系统"],
						]}
						onChange={theme => app.setPrefs({ theme })}
					/>
				</Row>
				<Row title="字体大小" desc="调整界面和消息文字大小">
					<Seg value={prefs.fontSize} options={[["s", "S"], ["m", "M"], ["l", "L"], ["xl", "XL"]]} onChange={fontSize => app.setPrefs({ fontSize })} />
				</Row>
				<Row title="正文字体" desc="未安装的字体会自动回退">
					<Seg value={prefs.uiFont} options={[["system", "系统默认"], ["yahei", "微软雅黑"], ["harmony", "鸿蒙黑体"]]} onChange={uiFont => app.setPrefs({ uiFont })} />
				</Row>
				<Row title="代码字体" desc="代码块、工具输出和 diff">
					<Seg value={prefs.codeFont} options={[["jetbrains", "JetBrains"], ["cascadia", "Cascadia"], ["consolas", "Consolas"]]} onChange={codeFont => app.setPrefs({ codeFont })} />
				</Row>
				<Row title="对话宽度" desc="对话和输入框的最大宽度">
					<Seg value={prefs.colWidth} options={[["narrow", "窄"], ["normal", "标准"], ["wide", "宽"]]} onChange={colWidth => app.setPrefs({ colWidth })} />
				</Row>
			</Section>
			<Section title="通知">
				<Row
					title="系统通知"
					desc={permission === "denied" ? "浏览器已拒绝通知权限，请在地址栏的网站设置里允许后再开启" : "页面在后台时，回合完成或有问题等你回答会弹出通知"}
				>
					<Toggle on={prefs.notify && permission === "granted"} disabled={permission === "denied" || permission === "unsupported"} onChange={v => void setNotify(v)} />
				</Row>
			</Section>
			<Section title="对话">
				<Row title="运行中按 Enter" desc="另一种行为用 Alt+Enter">
					<Seg value={prefs.enterWhileRunning} options={[["steer", "插入当前回合"], ["followUp", "排到下一轮"]]} onChange={enterWhileRunning => app.setPrefs({ enterWhileRunning })} />
				</Row>
				<Row title="派发子代理时打开侧栏" desc="在右侧栏的「子代理」页跟踪进度">
					<Toggle on={prefs.autoOpenAgents} onChange={autoOpenAgents => app.setPrefs({ autoOpenAgents })} />
				</Row>
			</Section>
		</>
	);
}

interface About {
	ompVersion: string;
	agentDir: string;
	sessionsRoot: string;
	modelsFile: string;
	dataDir: string;
	testProfile: boolean;
	modelLock: { provider: string; model: string } | null;
}

function useAbout(): About | undefined {
	const [info, setInfo] = useState<About>();
	useEffect(() => {
		void api<About>("/api/about").then(setInfo, () => {});
	}, []);
	return info;
}

async function reveal(target: "models" | "agent" | "data") {
	try {
		await api("/api/reveal", { method: "POST", body: JSON.stringify({ target }) });
	} catch (e) {
		app.notify("error", (e as Error).message);
	}
}

/** One row of the provider form, kept as text so empty means "leave it out". */
interface ModelDraft {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: string;
	maxTokens: string;
}

interface ProviderDraft {
	id: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	authHeader: "" | "on" | "off";
	models: ModelDraft[];
}

const API_SUGGESTIONS = ["openai-completions", "openai-responses", "openai-chat-completions", "anthropic-messages", "google-generative-ai"];

/** Provider details for the row's hover tooltip; the list itself stays one line per provider. */
function providerSummary(provider: ProviderConfig): string {
	return [
		provider.baseUrl,
		provider.api,
		provider.apiKey ? `密钥 ${provider.apiKey}` : "",
		provider.authHeader ? "authHeader" : "",
		provider.models?.length ? `${provider.models.length} 个模型` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

function toDraft(provider?: ProviderConfig): ProviderDraft {
	return {
		id: provider?.id ?? "",
		baseUrl: provider?.baseUrl ?? "",
		api: provider?.api ?? "openai-completions",
		apiKey: provider?.apiKey ?? "",
		authHeader: provider?.authHeader === undefined ? "" : provider.authHeader ? "on" : "off",
		models: (provider?.models ?? []).map(m => ({
			id: m.id,
			name: m.name ?? "",
			reasoning: Boolean(m.reasoning),
			contextWindow: m.contextWindow ? String(m.contextWindow) : "",
			maxTokens: m.maxTokens ? String(m.maxTokens) : "",
		})),
	};
}

/** Only the form's fields are sent; the gateway keeps every other field the file had. */
function toPayload(draft: ProviderDraft): ProviderConfig {
	const models: ProviderModel[] = [];
	for (const row of draft.models) {
		const id = row.id.trim();
		if (!id) continue;
		const model: ProviderModel = { id };
		const name = row.name.trim();
		if (name) model.name = name;
		if (row.reasoning) model.reasoning = true;
		const context = Number(row.contextWindow);
		if (Number.isFinite(context) && context > 0) model.contextWindow = context;
		const max = Number(row.maxTokens);
		if (Number.isFinite(max) && max > 0) model.maxTokens = max;
		models.push(model);
	}
	return {
		id: draft.id.trim(),
		baseUrl: draft.baseUrl.trim(),
		api: draft.api.trim(),
		apiKey: draft.apiKey.trim(),
		authHeader: draft.authHeader === "" ? undefined : draft.authHeader === "on",
		models,
	};
}

function ProvidersPage() {
	const a = useApp();
	const info = useAbout();
	const [view, setView] = useState<ProvidersView>();
	const [error, setError] = useState<string>();
	const [draft, setDraft] = useState<ProviderDraft>();
	const [editingNew, setEditingNew] = useState(false);
	const [confirm, setConfirm] = useState<string>();
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			setView(await api<ProvidersView>("/api/providers"));
			setError(undefined);
		} catch (e) {
			setError((e as Error).message);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (a.models.length > 0 || !a.route) return;
		void app.loadModels(a.route);
	}, [a.route, a.models.length]);

	const save = async () => {
		if (!draft) return;
		setBusy(true);
		try {
			const next = await api<ProvidersView>("/api/providers", { method: "POST", body: JSON.stringify(toPayload(draft)) });
			setView(next);
			setDraft(undefined);
			setEditingNew(false);
			app.notify("info", "已保存到 models.yml（已备份），新打开的会话生效");
		} catch (e) {
			app.notify("error", `保存失败：${(e as Error).message}`);
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: string) => {
		setBusy(true);
		try {
			const next = await api<ProvidersView>(`/api/providers?id=${encodeURIComponent(id)}`, { method: "DELETE" });
			setView(next);
			setConfirm(undefined);
			if (draft?.id === id) setDraft(undefined);
			app.notify("info", `已从 models.yml 移除 ${id}`);
		} catch (e) {
			app.notify("error", `移除失败：${(e as Error).message}`);
		} finally {
			setBusy(false);
		}
	};

	const groups = new Map<string, typeof a.models>();
	for (const m of a.models) {
		let g = groups.get(m.provider);
		if (!g) groups.set(m.provider, (g = []));
		g.push(m);
	}
	const hidden = a.prefs.hiddenModels;

	return (
		<>
			<h2 className="set-h2">模型供应商</h2>
			<Section title="配置">
				<Row title="models.yml" desc={info ? <code className="set-path">{info.modelsFile}</code> : "读取中…"}>
					<button className="btn" onClick={() => void reveal("models")}>
						在资源管理器中显示
					</button>
				</Row>
				<Row
					title="如何修改"
					desc="自定义供应商可以在下面直接增删改；表格以外的字段（headers、compat、modelOverrides 等）会原样保留。密钥建议填环境变量名。每次保存前都会自动备份，新打开的会话生效。"
				/>
				{info?.modelLock && <Row title="当前为测试配置" desc={`所有会话锁定为 ${info.modelLock.provider}/${info.modelLock.model}`} />}
			</Section>

			{error && (
				<div className="set-note danger-text">
					{a.serverStale ? "服务端还是旧版本，这个页面要重启服务后才能用：Ctrl+C 后重新运行 ompweb，或 ompweb --restart" : error}
				</div>
			)}

			{draft ? (
				<Section title={editingNew ? "添加供应商" : `编辑 ${draft.id}`}>
					<div className="set-form">
						<Row title="供应商 ID" desc="models.yml 里的键名，字母数字和 _ . -">
							<input
								className="text-input"
								value={draft.id}
								disabled={!editingNew}
								placeholder="my-provider"
								onChange={e => setDraft({ ...draft, id: e.target.value })}
							/>
						</Row>
						<Row title="Base URL" desc="OpenAI 兼容端点，例如 https://api.example.com/v1">
							<input className="text-input" value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} />
						</Row>
						<Row title="API" desc="按端点类型选择，通常是 openai-completions">
							<>
								<input className="text-input" list="provider-apis" value={draft.api} onChange={e => setDraft({ ...draft, api: e.target.value })} />
								<datalist id="provider-apis">
									{API_SUGGESTIONS.map(v => (
										<option key={v} value={v} />
									))}
								</datalist>
							</>
						</Row>
						<Row title="密钥" desc="填环境变量名（例如 CCTQ_Key），或直接填密钥">
							<input className="text-input" value={draft.apiKey} placeholder="MY_PROVIDER_KEY" onChange={e => setDraft({ ...draft, apiKey: e.target.value })} />
						</Row>
						<Row title="Authorization 请求头" desc="部分网关要求；「默认」表示不写这个字段，交给 omp 决定">
							<Seg value={draft.authHeader} options={[["", "默认"], ["on", "发送"], ["off", "不发送"]]} onChange={authHeader => setDraft({ ...draft, authHeader })} />
						</Row>
					</div>
					<div className="set-model-editor">
						<div className="set-model-head">
							<span>模型 ID</span>
							<span>显示名称</span>
							<span>上下文</span>
							<span>最大输出</span>
							<span>思考</span>
							<span />
						</div>
						{draft.models.map((m, i) => (
							<div className="set-model-row" key={i}>
								<input value={m.id} placeholder="gpt-4o" onChange={e => setDraft({ ...draft, models: draft.models.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)) })} />
								<input value={m.name} placeholder="可选" onChange={e => setDraft({ ...draft, models: draft.models.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
								<input value={m.contextWindow} placeholder="128000" inputMode="numeric" onChange={e => setDraft({ ...draft, models: draft.models.map((x, j) => (j === i ? { ...x, contextWindow: e.target.value } : x)) })} />
								<input value={m.maxTokens} placeholder="8192" inputMode="numeric" onChange={e => setDraft({ ...draft, models: draft.models.map((x, j) => (j === i ? { ...x, maxTokens: e.target.value } : x)) })} />
								<Toggle on={m.reasoning} onChange={reasoning => setDraft({ ...draft, models: draft.models.map((x, j) => (j === i ? { ...x, reasoning } : x)) })} />
								<button className="icon-btn" title="移除这个模型" onClick={() => setDraft({ ...draft, models: draft.models.filter((_, j) => j !== i) })}>
									<Icon name="x" size={13} />
								</button>
							</div>
						))}
						<button className="btn ghost" onClick={() => setDraft({ ...draft, models: [...draft.models, { id: "", name: "", reasoning: false, contextWindow: "", maxTokens: "" }] })}>
							<Icon name="plus" size={14} />
							添加模型
						</button>
						<div className="set-desc">已存在的模型会保留它的 input / compat 等字段；从列表里删掉就等于从 models.yml 里移除。</div>
					</div>
					<div className="set-actions">
						<button className="btn primary" disabled={busy || !draft.id.trim() || !draft.baseUrl.trim()} onClick={() => void save()}>
							保存到 models.yml
						</button>
						<button
							className="btn ghost"
							onClick={() => {
								setDraft(undefined);
								setEditingNew(false);
							}}
						>
							取消
						</button>
					</div>
				</Section>
			) : (
				<Section title="自定义供应商">
					{(view?.providers.length ?? 0) === 0 && <Row title={view ? "models.yml 里还没有自定义供应商" : "读取中…"} desc={view ? "点下面的按钮添加一个 OpenAI 兼容端点" : undefined} />}
					{/* The list stays one line per provider; details live behind 编辑 (and the tooltip). */}
					<div className="set-group">
						{view?.providers.map(p => (
							<div key={p.id} className="set-row" title={providerSummary(p)}>
								<div className="set-text">
									<div className="set-name">{p.id}</div>
								</div>
								<div className="set-control">
									{confirm === p.id ? (
										<>
											<span className="danger-text">从 models.yml 移除？</span>
											<button className="btn ghost" onClick={() => setConfirm(undefined)}>
												取消
											</button>
											<button className="btn danger" disabled={busy} onClick={() => void remove(p.id)}>
												移除
											</button>
										</>
									) : (
										<>
											<button
												className="btn"
												onClick={() => {
													setDraft(toDraft(p));
													setEditingNew(false);
												}}
											>
												编辑
											</button>
											<button className="btn ghost danger-ghost" onClick={() => setConfirm(p.id)}>
												移除
											</button>
										</>
									)}
								</div>
							</div>
						))}
					</div>
					<div className="set-actions">
						<button
							className="btn"
							onClick={() => {
								setDraft(toDraft());
								setEditingNew(true);
							}}
						>
							<Icon name="plus" size={14} />
							添加供应商
						</button>
					</div>
				</Section>
			)}

			<Section title="隐藏的模型">
				{groups.size === 0 ? (
					<Row title="还没有模型列表" desc="打开任意一个会话后会自动读取；隐藏只影响本机这个浏览器的选择菜单。" />
				) : (
					<>
						{[...groups].map(([provider, list]) => (
							<div key={provider} className="set-group">
								<div className="set-group-name">{provider}</div>
								{list.map(m => {
									const key = `${m.provider}/${m.id}`;
									const visible = !hidden.includes(key);
									return (
										<Row
											key={key}
											title={m.name ?? m.id}
											desc={
												<>
													<code className="set-path">{m.id}</code>
													{m.contextWindow ? ` · ${tokens(m.contextWindow)} 上下文` : ""}
													{m.reasoning ? " · 思考" : ""}
												</>
											}
										>
											<Toggle on={visible} onChange={on => app.setModelVisible(key, on)} />
										</Row>
									);
								})}
							</div>
						))}
						<div className="set-actions">
							<span className="set-desc">
								{hidden.length > 0 ? `已隐藏 ${hidden.length} 个模型` : "当前全部显示"}
							</span>
							{hidden.length > 0 && (
								<button className="btn ghost" onClick={() => app.setPrefs({ hiddenModels: [] })}>
									全部显示
								</button>
							)}
						</div>
					</>
				)}
			</Section>
		</>
	);
}

function ArchivedPage() {
	const a = useApp();
	const [query, setQuery] = useState("");
	const [confirm, setConfirm] = useState<string>();
	const [busy, setBusy] = useState<string>();
	const q = query.trim().toLowerCase();
	const list = a.archived.filter(s => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));

	const run = async (path: string, action: () => Promise<void>, label: string) => {
		setBusy(path);
		try {
			await action();
			setConfirm(undefined);
		} catch (e) {
			app.notify("error", `${label}失败：${(e as Error).message}`);
		} finally {
			setBusy(undefined);
		}
	};

	return (
		<>
			<h2 className="set-h2">已归档的会话</h2>
			<p className="set-lead">归档只是在侧栏里隐藏会话，会话文件仍保留在 OMP 中，可以随时恢复。彻底删除会移除会话文件和它的附属目录，无法撤销。</p>
			{a.archived.length > 0 && (
				<label className="set-search">
					<Icon name="search" size={14} />
					<input placeholder="搜索已归档的会话" value={query} onChange={e => setQuery(e.target.value)} />
				</label>
			)}
			{a.archived.length === 0 ? (
				<div className="set-empty">
					<Icon name="archive" size={22} />
					<div>还没有归档的会话</div>
					<div className="muted">在侧栏会话右侧的「…」菜单里选择「归档」</div>
				</div>
			) : (
				<div className="set-card">
					{list.map(s => (
						<div key={s.path} className="set-row archived-row">
							<div className="set-text">
								<div className="set-name">{s.title}</div>
								<div className="set-desc">
									{baseName(s.cwd)} · {relativeTime(s.modified)}
								</div>
							</div>
							<div className="set-control">
								{confirm === s.path ? (
									<>
										<span className="danger-text">无法撤销，确定删除？</span>
										<button className="btn ghost" onClick={() => setConfirm(undefined)}>
											取消
										</button>
										<button className="btn danger" disabled={busy === s.path} onClick={() => void run(s.path, () => app.deleteArchived(s.path), "删除")}>
											删除
										</button>
									</>
								) : (
									<>
										<button className="btn" disabled={busy === s.path} onClick={() => void run(s.path, () => app.setArchived(s.path, false), "恢复")}>
											恢复
										</button>
										<button className="btn ghost danger-ghost" onClick={() => setConfirm(s.path)}>
											彻底删除
										</button>
									</>
								)}
							</div>
						</div>
					))}
					{list.length === 0 && <div className="set-note">没有匹配的会话</div>}
				</div>
			)}
		</>
	);
}

function AboutPage() {
	const info = useAbout();
	return (
		<>
			<h2 className="set-h2">关于</h2>
			<Section title="版本">
				<Row title="Oh My Pi Web" desc="本机 Web 端，只监听 127.0.0.1" />
				<Row title="OMP" desc={info?.ompVersion || "读取中…"} />
			</Section>
			<Section title="数据位置">
				<Row title="OMP 配置目录" desc={<code className="set-path">{info?.agentDir ?? "…"}</code>}>
					<button className="btn" onClick={() => void reveal("agent")}>
						打开
					</button>
				</Row>
				<Row title="Web 数据目录" desc={<code className="set-path">{info?.dataDir ?? "…"}</code>}>
					<button className="btn" onClick={() => void reveal("data")}>
						打开
					</button>
				</Row>
			</Section>
		</>
	);
}
