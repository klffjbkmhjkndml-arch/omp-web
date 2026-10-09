/**
 * Projects = working directories. Derived from session cwds plus a small
 * user-maintained pin list persisted in `<dataDir>/projects.json`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DirListing, ProjectInfo, SessionSummary } from "../shared/api.ts";
import { config } from "./config.ts";
import { samePath } from "./session-index.ts";

interface Store {
	pinned: { path: string; at: number }[];
	hidden: string[];
}

const storeFile = path.join(config.dataDir, "projects.json");

async function load(): Promise<Store> {
	try {
		const data = (await Bun.file(storeFile).json()) as Partial<Store>;
		return { pinned: data.pinned ?? [], hidden: data.hidden ?? [] };
	} catch {
		return { pinned: [], hidden: [] };
	}
}

async function save(store: Store): Promise<void> {
	await Bun.write(storeFile, JSON.stringify(store, null, 2));
}

function key(p: string): string {
	const r = path.resolve(p);
	return process.platform === "win32" ? r.toLowerCase() : r;
}

export async function listProjects(sessions: SessionSummary[]): Promise<ProjectInfo[]> {
	const store = await load();
	const hidden = new Set(store.hidden.map(key));
	const map = new Map<string, ProjectInfo>();
	for (const pin of store.pinned) {
		map.set(key(pin.path), { path: pin.path, name: path.basename(pin.path) || pin.path, pinned: true, lastActive: pin.at, sessionCount: 0 });
	}
	for (const s of sessions) {
		if (!s.cwd) continue;
		const k = key(s.cwd);
		if (hidden.has(k) && !map.has(k)) continue;
		const p = map.get(k) ?? { path: s.cwd, name: path.basename(s.cwd) || s.cwd, pinned: false, lastActive: 0, sessionCount: 0 };
		p.sessionCount++;
		p.lastActive = Math.max(p.lastActive, s.activeAt);
		map.set(k, p);
	}
	return [...map.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActive - a.lastActive);
}

export async function addProject(dir: string): Promise<string> {
	const resolved = path.resolve(dir);
	const stat = await fs.stat(resolved);
	if (!stat.isDirectory()) throw new Error("不是文件夹");
	const store = await load();
	store.hidden = store.hidden.filter(h => !samePath(h, resolved));
	store.pinned = store.pinned.filter(p => !samePath(p.path, resolved));
	store.pinned.unshift({ path: resolved, at: Date.now() });
	await save(store);
	return resolved;
}

export async function removeProject(dir: string): Promise<void> {
	const store = await load();
	store.pinned = store.pinned.filter(p => !samePath(p.path, dir));
	if (!store.hidden.some(h => samePath(h, dir))) store.hidden.push(path.resolve(dir));
	await save(store);
}

/** Directory listing for the folder picker. Empty path lists drive roots on Windows, `/` elsewhere. */
export async function listDir(dir: string): Promise<DirListing> {
	if (!dir) {
		if (process.platform === "win32") {
			const drives: string[] = [];
			for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
				try {
					await fs.access(`${letter}:\\`);
					drives.push(`${letter}:\\`);
				} catch {
					// no such drive
				}
			}
			return { path: "", parent: null, dirs: drives };
		}
		dir = "/";
	}
	const resolved = path.resolve(dir);
	const entries = await fs.readdir(resolved, { withFileTypes: true });
	const dirs = entries
		.filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && !e.name.startsWith("$"))
		.map(e => e.name)
		.sort((a, b) => a.localeCompare(b, "zh-CN", { sensitivity: "base" }));
	const parent = path.dirname(resolved);
	return { path: resolved, parent: parent === resolved ? (process.platform === "win32" ? "" : null) : parent, dirs };
}
