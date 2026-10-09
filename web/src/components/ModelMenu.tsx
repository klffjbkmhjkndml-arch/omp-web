import { useCallback, useRef, useState } from "react";
import type { ModelOption } from "../../../shared/api.ts";
import { app, useApp } from "../lib/app-store.ts";
import { effortName } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import type { SessionStore } from "../lib/session-store.ts";
import { gateway } from "../lib/ws.ts";
import { Popover } from "./Popover.tsx";

export interface ModelChoice {
	provider: string;
	id: string;
	name?: string;
}

/**
 * Model + thinking level in one chip; popover lists the current provider first,
 * "更多模型" shows the rest. Controlled: the caller decides what a pick means
 * (session: rpc + remember; home: remember only) and rethrows to keep it open.
 */
export function ModelPicker({
	current,
	level,
	efforts,
	models,
	lockedTo,
	hidden = [],
	onOpen,
	onPick,
	onLevel,
}: {
	current?: ModelChoice;
	level?: string;
	efforts: string[];
	models: ModelOption[];
	/** Profile forces one model onto every session: offer it alone, hide "更多模型". */
	lockedTo?: ModelChoice;
	/** `provider/id` keys hidden in settings; the current model always stays offered. */
	hidden?: string[];
	onOpen?: () => void;
	onPick: (m: ModelOption) => void | Promise<void>;
	onLevel: (level: string) => void | Promise<void>;
}) {
	const btn = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [more, setMore] = useState(false);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const close = useCallback(() => {
		setOpen(false);
		setMore(false);
		setQuery("");
	}, []);

	const toggle = () => {
		if (!open) onOpen?.();
		setOpen(o => !o);
	};

	const pick = async (m: ModelOption) => {
		setBusy(true);
		try {
			await onPick(m);
			close();
		} catch {
			// onPick surfaced the error; keep the popover open so a retry is one click away
		} finally {
			setBusy(false);
		}
	};

	const fallback: ModelOption[] = current ? [{ provider: current.provider, id: current.id, name: current.name }] : [];
	const lockedList: ModelOption[] = lockedTo ? [{ provider: lockedTo.provider, id: lockedTo.id, name: lockedTo.name }] : [];
	// Hidden models stay out of every list, but never hide the model in use.
	const usable = hidden.length > 0 ? models.filter(m => !hidden.includes(`${m.provider}/${m.id}`) || `${m.provider}/${m.id}` === (current ? `${current.provider}/${current.id}` : "")) : models;
	const sameProvider = lockedTo
		? lockedList
		: current
			? usable.filter(m => m.provider === current.provider).length
				? usable.filter(m => m.provider === current.provider)
				: fallback
			: [];
	const pool = lockedTo ? lockedList : usable.filter(m => m.provider !== current?.provider);

	const q = query.trim().toLowerCase();
	const filtered = pool.filter(m => !q || `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(q));
	const groups = new Map<string, ModelOption[]>();
	for (const m of filtered) {
		let g = groups.get(m.provider);
		if (!g) groups.set(m.provider, (g = []));
		g.push(m);
	}

	// Without a current model the chip is just an entry point into the list.
	const listOnly = more || !current;
	const hasContent = Boolean(current || lockedTo) || usable.length > 0;

	return (
		<>
			<button ref={btn} className={`chip ${open ? "active" : ""}`} onClick={toggle} disabled={!hasContent}>
				<span className="label">{lockedTo ? (lockedTo.name ?? lockedTo.id) : current ? (current.name ?? current.id) : "默认模型"}</span>
				{level && efforts.length > 0 && <span className="effort">· {effortName(level)}</span>}
				<Icon name="chevronDown" size={13} />
			</button>
			{open && hasContent && (
				<Popover anchor={btn} onClose={close} width={330} align="end" prefer="above">
					{!listOnly ? (
						<>
							<div className="pop-title">{current?.provider.toUpperCase()}</div>
							<div className="pop-list">
								{sameProvider.map(m => (
									<button key={m.id} className="pop-item" disabled={busy} onClick={() => m.id !== current?.id && void pick(m)}>
										<span className="check">{m.id === current?.id && <Icon name="check" size={15} />}</span>
										<span className="main-label">{m.name ?? m.id}</span>
									</button>
								))}
							</div>
							{efforts.length > 0 && (
								<>
									<div className="pop-sep" />
									<div className="seg-row">
										<span>思考</span>
										<div className="seg">
											{efforts.map(e => (
												<button key={e} className={level === e ? "on" : ""} onClick={() => void onLevel(e)}>
													{effortName(e)}
												</button>
											))}
										</div>
									</div>
								</>
							)}
							<div className="pop-note">切换模型或思考等级会让已有的提示词缓存失效。</div>
							{!lockedTo && pool.length > 0 && (
								<>
									<div className="pop-sep" />
									<button className="pop-item" onClick={() => setMore(true)}>
										<Icon name="list" size={15} className="muted" />
										<span className="main-label">更多模型</span>
										<Icon name="chevronRight" size={14} className="muted" />
									</button>
								</>
							)}
							{usable.length === 0 && <div className="pop-note">正在读取模型列表…</div>}
						</>
					) : (
						<>
							{more && (
								<div className="pop-search">
									<button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setMore(false)} title="返回">
										<Icon name="chevronRight" size={14} className="flip" />
									</button>
									<input autoFocus placeholder="搜索模型" value={query} onChange={e => setQuery(e.target.value)} />
								</div>
							)}
							<div className="pop-list" style={{ maxHeight: 360 }}>
								{[...groups].map(([provider, list]) => (
									<div key={provider}>
										<div className="pop-title">{provider.toUpperCase()}</div>
										{list.map(m => (
											<button key={`${m.provider}/${m.id}`} className="pop-item" disabled={busy} onClick={() => void pick(m)}>
												<span className="main-label">{m.name ?? m.id}</span>
												<span className="sub">{m.id}</span>
											</button>
										))}
									</div>
								))}
								{groups.size === 0 && <div className="pop-note">{usable.length === 0 ? "正在读取模型列表…" : "没有匹配的模型"}</div>}
							</div>
						</>
					)}
				</Popover>
			)}
		</>
	);
}

/** Session-bound picker: picking runs rpc and remembers the choice for the next new session. */
export function ModelMenu({ store }: { store: SessionStore }) {
	const a = useApp();
	const model = store.state?.model;
	const level = store.state?.thinkingLevel;
	const efforts = model?.reasoning ? ["off", ...(model.thinking?.efforts ?? [])] : [];
	const current: ModelChoice | undefined = model ? { provider: model.provider, id: model.id, name: model.name } : undefined;

	return (
		<ModelPicker
			current={current}
			level={level}
			efforts={efforts}
			models={a.models}
			hidden={a.prefs.hiddenModels}
			lockedTo={a.modelLock ? { provider: a.modelLock.provider, id: a.modelLock.model } : undefined}
			onOpen={() => {
				if (a.models.length === 0) void app.loadModels(store.key);
			}}
			onPick={async m => {
				try {
					await gateway.rpc(store.key, { type: "set_model", provider: m.provider, modelId: m.id });
				} catch (e) {
					store.notify("error", `切换模型失败：${(e as Error).message}`);
					throw e;
				}
				app.rememberModel({ provider: m.provider, id: m.id, level });
			}}
			onLevel={async l => {
				try {
					await gateway.rpc(store.key, { type: "set_thinking_level", level: l });
				} catch (e) {
					store.notify("error", (e as Error).message);
					throw e;
				}
				if (model) app.rememberModel({ provider: model.provider, id: model.id, level: l });
			}}
		/>
	);
}
