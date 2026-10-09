/**
 * Read-only index of OMP session files (`<agentDir>/sessions/<encoded-cwd>/*.jsonl`).
 *
 * The head of each file gives the title slot, the `session` header
 * (id/cwd/timestamp/parentSession) and the first user message as a fallback
 * title; the tail gives the newest real message, because a session file is also
 * appended to by lifecycle records (`model_change`, `session_exit`) that would
 * otherwise make an untouched old conversation look like it happened today.
 * Results are cached by (mtime, size).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionSummary } from "../shared/api.ts";
import { config } from "./config.ts";

const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 32 * 1024;

interface CacheEntry {
	mtimeMs: number;
	size: number;
	summary: SessionSummary | null;
}

const cache = new Map<string, CacheEntry>();

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
		.join(" ");
}

export function titleFromText(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function parseLine(line: string): Record<string, unknown> | undefined {
	if (!line.startsWith("{")) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Time of the newest `message` record, read from the file's tail. */
async function lastMessageAt(file: string, size: number): Promise<number | undefined> {
	if (size <= 0) return undefined;
	const start = Math.max(0, size - TAIL_BYTES);
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(size - start);
		await handle.read(buffer, 0, buffer.byteLength, start);
		const lines = buffer.toString("utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const entry = parseLine(lines[i].trim());
			if (entry?.type !== "message" || typeof entry.timestamp !== "string") continue;
			const stamp = Date.parse(entry.timestamp);
			if (Number.isFinite(stamp)) return stamp;
		}
	} finally {
		await handle.close();
	}
	return undefined;
}

async function parseHead(file: string, mtimeMs: number, size: number): Promise<SessionSummary | null> {
	const head = await Bun.file(file).slice(0, HEAD_BYTES).text();
	let title = "";
	let header: { id?: string; cwd?: string; timestamp?: string; parentSession?: string } | undefined;
	let firstUser = "";
	const lines = head.split("\n");
	// Mirror omp's loader: line 0 is the title slot only when it is a full slot
	// (`v: 1` plus `pad`), and the first record after it must be the `session`
	// header. omp refuses to resume anything else, so such files are not listed.
	const slot = parseLine(lines[0] ?? "");
	const slotValid = slot?.type === "title" && slot.v === 1 && typeof slot.title === "string" && typeof slot.updatedAt === "string" && typeof slot.pad === "string";
	if (slotValid) title = slot.title as string;
	const first = slotValid ? 1 : 0;
	const headerEntry = parseLine(lines[first] ?? "");
	if (headerEntry?.type !== "session" || typeof headerEntry.id !== "string") return null;
	header = headerEntry as typeof header;
	for (const line of lines.slice(first + 1)) {
		const entry = parseLine(line);
		if (!entry) continue; // malformed, or the truncated last line of the head window
		if (entry.type === "title" && typeof entry.title === "string") title = entry.title;
		else if (entry.type === "session_info" && typeof entry.name === "string" && entry.name) title = entry.name;
		else if (entry.type === "message" && !firstUser) {
			const message = entry.message as { role?: string; content?: unknown } | undefined;
			if (message?.role === "user") firstUser = textOf(message.content);
		}
		if (header && title && firstUser) break;
	}
	if (!header?.id) return null;
	if (!firstUser && !title.trim()) return null;
	const created = header.timestamp ? Date.parse(header.timestamp) : mtimeMs;
	return {
		path: file,
		id: header.id,
		cwd: header.cwd ?? "",
		title: title.trim() || titleFromText(firstUser) || "新会话",
		created,
		modified: mtimeMs,
		// Falls back to the session's own start when the tail window holds no message.
		activeAt: (await lastMessageAt(file, size)) ?? created,
		parent: header.parentSession,
	};
}

/** All sessions across projects, newest first. Empty sessions (no user message) are skipped unless live. */
export async function listSessions(): Promise<SessionSummary[]> {
	let dirs: string[];
	try {
		dirs = await fs.readdir(config.sessionsRoot);
	} catch {
		return [];
	}
	const files: string[] = [];
	await Promise.all(
		dirs.map(async dir => {
			try {
				for (const name of await fs.readdir(path.join(config.sessionsRoot, dir))) {
					if (name.endsWith(".jsonl")) files.push(path.join(config.sessionsRoot, dir, name));
				}
			} catch {
				// not a directory
			}
		}),
	);
	const seen = new Set(files);
	for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);

	const out: SessionSummary[] = [];
	await Promise.all(
		files.map(async file => {
			try {
				const stat = await fs.stat(file);
				let entry = cache.get(file);
				if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
					entry = { mtimeMs: stat.mtimeMs, size: stat.size, summary: await parseHead(file, stat.mtimeMs, stat.size) };
					cache.set(file, entry);
				}
				if (entry.summary) out.push(entry.summary);
			} catch {
				// vanished mid-scan
			}
		}),
	);
	// Newest real activity first: the file mtime only tracks omp's own bookkeeping writes.
	return out.sort((a, b) => b.activeAt - a.activeAt);
}

export function samePath(a: string, b: string): boolean {
	const norm = (p: string) => {
		const r = path.resolve(p);
		return process.platform === "win32" ? r.toLowerCase() : r;
	};
	return norm(a) === norm(b);
}
