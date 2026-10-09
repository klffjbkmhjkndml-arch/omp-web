import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AvailableSlashCommand, ImageContent } from "../../../shared/api.ts";
import { Icon } from "../lib/icons.tsx";
import { commandItems, searchFiles, SuggestMenu, type SuggestItem } from "./SuggestMenu.tsx";

export type SendMode = "prompt" | "steer" | "followUp";

/** One pending image: `dataUrl` drives the thumbnail, `image` is what omp receives. */
interface Attachment {
	id: string;
	dataUrl: string;
	image: ImageContent;
}

interface Trigger {
	kind: "command" | "file";
	query: string;
	/** Range of the trigger text (`/query` or `@query`) to replace on pick. */
	start: number;
	end: number;
}

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Input box. Enter sends; Shift+Enter newline. While a run is active, Enter
 * steers the current run and Alt+Enter queues a follow-up (same as the TUI).
 * With a menu open, Enter/Tab pick an item instead of sending. Images come in
 * by paste, drag-and-drop, or the + button.
 */
export function Composer({
	onSend,
	onStop,
	onNotice,
	running = false,
	disabled = false,
	placeholder,
	left,
	right,
	above,
	autoFocus,
	draftKey,
	commands = [],
	fileCwd,
	modelSupportsImages,
}: {
	onSend: (text: string, mode: SendMode, images?: ImageContent[]) => void | Promise<void>;
	onStop?: () => void;
	/** Surfaces attachment problems (too many, too large) through the host's notice channel. */
	onNotice?: (text: string, level?: "info" | "warning" | "error") => void;
	running?: boolean;
	disabled?: boolean;
	placeholder?: string;
	left?: ReactNode;
	right?: ReactNode;
	above?: ReactNode;
	autoFocus?: boolean;
	/** Drafts survive switching sessions (kept per key in sessionStorage). */
	draftKey?: string;
	/** Slash commands of the open session; empty on the home screen. */
	commands?: AvailableSlashCommand[];
	/** `@` completion searches this directory. */
	fileCwd?: string;
	/** False when the model takes text only; undefined when that is unknown. */
	modelSupportsImages?: boolean;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const filePicker = useRef<HTMLInputElement>(null);
	const storageKey = draftKey ? `omp-web:draft:${draftKey}` : undefined;
	const [text, setText] = useState(() => (storageKey ? (safeGet(storageKey) ?? "") : ""));
	const composing = useRef(false);
	const [trigger, setTrigger] = useState<Trigger>();
	const [fileItems, setFileItems] = useState<SuggestItem[]>([]);
	const [active, setActive] = useState(0);
	/** Query the user dismissed with Esc; a new query reopens the menu. */
	const [dismissed, setDismissed] = useState<string>();
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [dragging, setDragging] = useState(false);
	const held = useRef(0);
	held.current = attachments.length;

	useEffect(() => {
		setText(storageKey ? (safeGet(storageKey) ?? "") : "");
		setTrigger(undefined);
	}, [storageKey]);

	useEffect(() => {
		if (storageKey) safeSet(storageKey, text);
	}, [storageKey, text]);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
	}, [text]);

	useEffect(() => {
		if (autoFocus) ref.current?.focus();
	}, [autoFocus, draftKey]);

	/**
	 * Recompute the trigger from the text before the caret. Reads the DOM value
	 * when none is passed: a `select` event that follows an `input` event would
	 * otherwise see the previous React state and clear the trigger it just set.
	 */
	const detect = (value?: string) => {
		const el = ref.current;
		const current = value ?? el?.value ?? text;
		const caret = el && el.selectionStart !== null ? el.selectionStart : current.length;
		const before = current.slice(0, caret);
		const command = /^\/([^\s/]*)$/.exec(before);
		if (command && commands.length > 0) {
			setTrigger({ kind: "command", query: command[1], start: 0, end: caret });
			return;
		}
		const file = /(?:^|\s)@([^\s@]*)$/.exec(before);
		if (file && fileCwd) {
			setTrigger({ kind: "file", query: file[1], start: caret - file[1].length - 1, end: caret });
			return;
		}
		setTrigger(undefined);
	};

	// `@` file search, debounced so typing does not fire a request per keystroke.
	useEffect(() => {
		if (trigger?.kind !== "file" || !fileCwd) return;
		const { query } = trigger;
		let alive = true;
		const timer = setTimeout(() => {
			void searchFiles(fileCwd, query).then(items => {
				if (!alive) return;
				setFileItems(items);
				setActive(0);
			});
		}, 150);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [trigger?.kind, trigger?.query, fileCwd]);

	const items = useMemo(() => (trigger?.kind === "command" ? commandItems(commands, trigger.query) : trigger?.kind === "file" ? fileItems : []), [trigger, commands, fileItems]);
	const menuOpen = Boolean(trigger) && items.length > 0 && dismissed !== trigger?.query;

	const addFiles = (files: Iterable<File>) => {
		const picked = [...files].filter(file => file.type.startsWith("image/"));
		if (picked.length === 0) return;
		let room = MAX_IMAGES - held.current;
		for (const file of picked) {
			if (room <= 0) {
				onNotice?.(`最多只能附 ${MAX_IMAGES} 张图片`, "warning");
				break;
			}
			if (file.size > MAX_IMAGE_BYTES) {
				onNotice?.(`图片超过 8 MB，已跳过：${file.name || "未命名"}`, "warning");
				continue;
			}
			room--;
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = String(reader.result ?? "");
				const comma = dataUrl.indexOf(",");
				if (comma < 0) return;
				const attachment: Attachment = {
					id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
					dataUrl,
					image: { type: "image", data: dataUrl.slice(comma + 1), mimeType: file.type || "image/png" },
				};
				setAttachments(current => (current.length >= MAX_IMAGES ? current : [...current, attachment]));
			};
			reader.readAsDataURL(file);
		}
	};

	const choose = (item: SuggestItem) => {
		if (!trigger) return;
		const next = text.slice(0, trigger.start) + item.insert + text.slice(trigger.end);
		const caret = trigger.start + item.insert.length;
		setText(next);
		setTrigger(undefined);
		setDismissed(undefined);
		requestAnimationFrame(() => {
			const el = ref.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(caret, caret);
		});
	};

	const submit = (mode: SendMode) => {
		const value = text.trim();
		if (!value || disabled) return;
		const images = attachments.map(a => a.image);
		setText("");
		setAttachments([]);
		setTrigger(undefined);
		void onSend(value, mode, images.length > 0 ? images : undefined);
	};

	return (
		<div
			className={`composer ${dragging ? "dragging" : ""}`}
			onDragOver={e => {
				if (![...(e.dataTransfer?.items ?? [])].some(i => i.kind === "file")) return;
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={e => {
				if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
				setDragging(false);
			}}
			onDrop={e => {
				e.preventDefault();
				setDragging(false);
				addFiles(e.dataTransfer?.files ?? []);
			}}
		>
			{above}
			{attachments.length > 0 && (
				<>
					<div className="attach-row">
						{attachments.map(a => (
							<div key={a.id} className="attach">
								<img src={a.dataUrl} alt="" />
								<button className="rm" title="移除" onClick={() => setAttachments(prev => prev.filter(x => x.id !== a.id))}>
									<Icon name="x" size={11} strokeWidth={2.6} />
								</button>
							</div>
						))}
					</div>
					{modelSupportsImages === false && (
						<div className="attach-note">
							<Icon name="alert" size={12} />
							当前模型不支持图片，OMP 会尝试转成文字描述
						</div>
					)}
				</>
			)}
			{menuOpen && <SuggestMenu items={items} active={active} onHover={setActive} onPick={choose} />}
			<textarea
				ref={ref}
				rows={1}
				value={text}
				disabled={disabled}
				placeholder={placeholder ?? (running ? "补充说明会插入当前回合（Alt+Enter 排到下一轮）" : "输入消息，Enter 发送，Shift+Enter 换行")}
				onChange={e => {
					setText(e.target.value);
					detect(e.target.value);
				}}
				onSelect={() => detect()}
				onPaste={e => {
					const images = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith("image/"));
					if (images.length === 0) return;
					e.preventDefault();
					addFiles(images);
				}}
				onCompositionStart={() => (composing.current = true)}
				onCompositionEnd={() => (composing.current = false)}
				onKeyDown={e => {
					if (menuOpen) {
						if (e.key === "ArrowDown") {
							e.preventDefault();
							setActive(i => (i + 1) % items.length);
							return;
						}
						if (e.key === "ArrowUp") {
							e.preventDefault();
							setActive(i => (i - 1 + items.length) % items.length);
							return;
						}
						if (e.key === "Enter" || e.key === "Tab") {
							e.preventDefault();
							choose(items[active]);
							return;
						}
						if (e.key === "Escape") {
							e.preventDefault();
							setDismissed(trigger?.query);
							return;
						}
					}
					if (e.key !== "Enter" || e.shiftKey || composing.current || e.nativeEvent.isComposing) return;
					e.preventDefault();
					submit(running ? (e.altKey ? "followUp" : "steer") : "prompt");
				}}
			/>
			<div className="composer-bar">
				{left}
				<span className="grow" />
				{right}
				<button className="icon-btn" title="添加图片" onClick={() => filePicker.current?.click()}>
					<Icon name="plus" size={16} />
				</button>
				<input
					ref={filePicker}
					type="file"
					accept="image/*"
					multiple
					hidden
					onChange={e => {
						addFiles(e.target.files ?? []);
						e.target.value = "";
					}}
				/>
				{running && !text.trim() ? (
					<button className="send" onClick={onStop} title="停止（Esc）">
						<Icon name="stop" size={13} strokeWidth={2.4} />
					</button>
				) : (
					<button className="send" disabled={!text.trim() || disabled} onClick={() => submit(running ? "steer" : "prompt")} title="发送">
						<Icon name="arrowUp" size={16} strokeWidth={2.2} />
					</button>
				)}
			</div>
		</div>
	);
}

function safeGet(k: string): string | null {
	try {
		return sessionStorage.getItem(k);
	} catch {
		return null;
	}
}

function safeSet(k: string, v: string): void {
	try {
		if (v) sessionStorage.setItem(k, v);
		else sessionStorage.removeItem(k);
	} catch {
		// unavailable
	}
}
