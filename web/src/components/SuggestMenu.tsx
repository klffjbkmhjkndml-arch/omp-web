/**
 * Composer completion menu: slash commands (from `available_commands_update`)
 * and `@` file paths (from the gateway's project file search).
 */
import type { AvailableSlashCommand } from "../../../shared/api.ts";
import { Icon } from "../lib/icons.tsx";
import { api } from "../lib/ws.ts";

export interface SuggestItem {
	key: string;
	label: string;
	sub?: string;
	/** Replaces the trigger text; already ends with a space. */
	insert: string;
}

/** Commands whose name or any alias starts with `query`. */
export function commandItems(commands: AvailableSlashCommand[], query: string): SuggestItem[] {
	const q = query.toLowerCase();
	const out: SuggestItem[] = [];
	for (const c of commands) {
		const names = [c.name, ...(c.aliases ?? [])];
		if (q && !names.some(n => n.toLowerCase().startsWith(q))) continue;
		out.push({ key: c.name, label: `/${c.name}`, sub: c.description, insert: `/${c.name} ` });
	}
	return out.slice(0, 40);
}

/** Project files matching `query`, as `@path ` insertions. Never throws: an unknown cwd just yields none. */
export async function searchFiles(cwd: string, query: string): Promise<SuggestItem[]> {
	try {
		const data = await api<{ files: string[] }>(`/api/files/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`);
		return data.files.map(p => ({ key: p, label: p, insert: `@${p} ` }));
	} catch {
		return [];
	}
}

export function SuggestMenu({ items, active, onHover, onPick }: { items: SuggestItem[]; active: number; onHover: (index: number) => void; onPick: (item: SuggestItem) => void }) {
	return (
		<div className="suggest" role="listbox">
			{items.map((item, i) => (
				<button
					key={item.key}
					role="option"
					aria-selected={i === active}
					className={`suggest-item ${i === active ? "on" : ""}`}
					// Keep focus (and the caret) in the textarea.
					onMouseDown={e => e.preventDefault()}
					onMouseEnter={() => onHover(i)}
					onClick={() => onPick(item)}
				>
					<span className="main-label">{item.label}</span>
					{item.sub && (
						<span className="sub">
							<Icon name="list" size={12} className="muted" />
							{item.sub}
						</span>
					)}
				</button>
			))}
		</div>
	);
}
