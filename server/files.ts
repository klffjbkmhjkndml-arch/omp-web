/**
 * Read-only file and git access for the right-hand panel.
 *
 * Every entry point takes a `cwd` the app already knows (validated by the
 * caller) plus a path that must resolve inside it, so `..` cannot escape the
 * project. Git runs as a short-lived child process with optional locks off.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileView, FsTree, GitDiff, GitStatus } from "../shared/api.ts";
import { samePath } from "./session-index.ts";

/** Text previews stop here; the client is told the content was clipped. */
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const NUL_SCAN_BYTES = 8000;

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
};

export interface TreeEntry {
	name: string;
	dir: boolean;
}

export function inside(base: string, target: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedTarget = path.resolve(target);
	if (samePath(resolvedBase, resolvedTarget)) return true;
	const prefix = (resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep).toLowerCase();
	return resolvedTarget.toLowerCase().startsWith(prefix);
}

/** Resolve `rel` against `cwd`, refusing anything that escapes it. */
export function resolveInside(cwd: string, rel: string): string {
	const target = path.resolve(cwd, rel || ".");
	if (!inside(cwd, target)) throw new Error("路径越界");
	return target;
}

function relPath(cwd: string, absolute: string): string {
	return path.relative(path.resolve(cwd), absolute).replace(/\\/g, "/");
}

/** One directory level, directories first, hidden of `.git`/`node_modules`. */
export async function listTree(cwd: string, rel: string): Promise<FsTree> {
	const dir = resolveInside(cwd, rel);
	const dirents = await fs.readdir(dir, { withFileTypes: true });
	const entries = dirents
		.filter(e => !SKIP_DIRS.has(e.name))
		.map(e => ({ name: e.name, dir: e.isDirectory() }))
		.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" }));
	return { path: relPath(cwd, dir), entries };
}

/** Looks like text? Same heuristic as git: a NUL byte in the first few KB. */
function looksBinary(head: Buffer): boolean {
	return head.subarray(0, NUL_SCAN_BYTES).includes(0);
}

export async function readFileView(cwd: string, rel: string): Promise<FileView> {
	const file = resolveInside(cwd, rel);
	const stat = await fs.stat(file);
	if (!stat.isFile()) throw new Error("不是文件");
	const shown = relPath(cwd, file);
	if (IMAGE_TYPES[path.extname(file).toLowerCase()]) return { path: shown, image: true, size: stat.size };
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(Math.min(stat.size, MAX_TEXT_BYTES + 1));
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
		const head = buffer.subarray(0, bytesRead);
		if (looksBinary(head)) return { path: shown, binary: true, size: stat.size };
		const truncated = stat.size > MAX_TEXT_BYTES;
		return { path: shown, text: head.subarray(0, MAX_TEXT_BYTES).toString("utf8"), truncated, size: stat.size };
	} finally {
		await handle.close();
	}
}

/** Content type for `GET /api/fs/raw`, which streams a file unchanged (image preview). */
export function contentTypeFor(cwd: string, rel: string): { file: string; type: string } {
	const file = resolveInside(cwd, rel);
	const type = IMAGE_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
	return { file, type };
}

async function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], {
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
	try {
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		return { code: proc.exitCode ?? -1, stdout };
	} finally {
		clearTimeout(timer);
	}
}

/** Absolute git work-tree root for `cwd`, or undefined when it is not in a repository. */
async function gitRoot(cwd: string): Promise<string | undefined> {
	const res = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (res.code !== 0) return undefined;
	const root = res.stdout.trim();
	return root ? path.resolve(root) : undefined;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
	const root = await gitRoot(cwd);
	if (!root) return { notRepo: true };
	const res = await runGit(root, ["status", "--porcelain=v1", "-z"]);
	if (res.code !== 0) return { notRepo: true };
	const files: { path: string; x: string; y: string }[] = [];
	const parts = res.stdout.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		files.push({ path: entry.slice(3).replace(/\\/g, "/"), x: entry[0], y: entry[1] });
		// A rename/copy carries the original path as the next NUL-separated field.
		if (entry[0] === "R" || entry[0] === "C") i++;
	}
	return { root, files };
}

function clip(diff: string): { diff: string; truncated?: boolean } {
	if (diff.length <= MAX_DIFF_BYTES) return { diff };
	return { diff: diff.slice(0, MAX_DIFF_BYTES), truncated: true };
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.stat(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * `git diff HEAD` for a tracked file; an untracked one is shown as all-new.
 *
 * `rel` is accepted in either spelling: relative to the repository root (what
 * `git status` prints) or to the session cwd (what an edit card hands over),
 * because a session cwd may sit in a subdirectory of the work tree.
 */
export async function gitDiff(cwd: string, rel: string): Promise<GitDiff> {
	const root = await gitRoot(cwd);
	if (!root) throw new Error("此项目不是 Git 仓库");
	const fromRoot = path.resolve(root, rel || ".");
	const target = inside(root, fromRoot) && (await exists(fromRoot)) ? fromRoot : resolveInside(cwd, rel);
	if (!inside(root, target)) throw new Error("路径越界");
	const shown = relPath(root, target);

	const status = await gitStatus(root);
	if ((status.files ?? []).some(f => f.path === shown && f.x === "?")) {
		const text = await fs.readFile(target, "utf8");
		const body = text.split("\n").map(line => `+${line}`);
		return { ...clip([`--- /dev/null`, `+++ b/${shown}`, ...body].join("\n")), untracked: true };
	}
	const res = await runGit(root, ["diff", "HEAD", "--", shown]);
	if (res.code !== 0) {
		const fallback = await runGit(root, ["diff", "--", shown]);
		if (fallback.code !== 0) throw new Error("读取 diff 失败");
		return clip(fallback.stdout);
	}
	return clip(res.stdout);
}
