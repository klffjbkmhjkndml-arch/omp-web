/**
 * Web-only session archive. omp has no archive concept, so archiving just
 * hides a session file from the sidebar; the list lives in
 * `<dataDir>/archived.json` and the session file is left untouched.
 */
import * as path from "node:path";
import { config } from "./config.ts";

const file = path.join(config.dataDir, "archived.json");

interface Store {
	paths: string[];
}

function key(p: string): string {
	const r = path.resolve(p);
	return process.platform === "win32" ? r.toLowerCase() : r;
}

async function load(): Promise<Store> {
	try {
		const data = (await Bun.file(file).json()) as Partial<Store>;
		return { paths: Array.isArray(data.paths) ? data.paths : [] };
	} catch {
		return { paths: [] };
	}
}

/** Normalized keys of every archived session file. */
export async function archivedKeys(): Promise<Set<string>> {
	return new Set((await load()).paths.map(key));
}

export function archiveKey(p: string): string {
	return key(p);
}

export async function setArchived(sessionFile: string, archived: boolean): Promise<void> {
	const store = await load();
	const k = key(sessionFile);
	store.paths = store.paths.filter(p => key(p) !== k);
	if (archived) store.paths.push(path.resolve(sessionFile));
	await Bun.write(file, JSON.stringify(store, null, 2));
}
