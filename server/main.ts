import * as fs from "node:fs/promises";
import * as path from "node:path";
import { API_VERSION, type ClientMsg, type ServerMsg } from "../shared/api.ts";
import { archivedKeys, archiveKey, setArchived } from "./archive.ts";
import { config } from "./config.ts";
import { contentTypeFor, gitDiff, gitStatus, inside, listTree, readFileView } from "./files.ts";
import { addProject, listDir, listProjects, removeProject } from "./projects.ts";
import { type ProviderConfig, type ProvidersView, assertProviderId, readProviders, removeProvider, writeProvider } from "./providers.ts";
import { type LiveSession, ModelUnavailableError, SessionHub, type Socket } from "./session-hub.ts";
import { listSessions, samePath } from "./session-index.ts";

const hub = new SessionHub();
/** When this process booted; the launcher compares it with source mtimes. */
const startedAt = Date.now();
/** Sessions each socket is attached to, for cleanup on close. */
const attachments = new WeakMap<Socket, Set<LiveSession>>();
let nextSocketId = 1;

/** An error that carries the HTTP status the client should see. */
class HttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function fail(error: unknown, status = 400): Response {
	return json({ error: error instanceof Error ? error.message : String(error) }, status);
}

async function sessionIndex() {
	const all = await listSessions();
	// Live sessions not yet persisted (fresh, before first message) are omitted by the scan.
	for (const s of all) s.live = hub.liveStatus(s.path);
	const hidden = await archivedKeys();
	const sessions = all.filter(s => !hidden.has(archiveKey(s.path)));
	const archived = all.filter(s => hidden.has(archiveKey(s.path)));
	const projects = await listProjects(sessions);
	return { projects, sessions, archived };
}

async function ensureLive(key: string, model?: string): Promise<LiveSession> {
	const live = hub.find(key);
	if (live) return live;
	const summary = (await listSessions()).find(s => samePath(s.path, key));
	if (!summary) throw new Error("会话不存在或尚未保存");
	return hub.open(summary.path, summary.cwd || path.dirname(summary.path), model);
}

const MAX_SEARCH_RESULTS = 50;
/** Own files considered before giving up, so one query never walks a whole monorepo. */
const MAX_SCANNED_FILES = 3000;
/** Hard stop over everything visited, including skipped folders such as node_modules. */
const MAX_VISITED_PATHS = 20_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

/** Substring search over a project's files for the composer's `@` completion. */
async function searchFiles(cwd: string, query: string): Promise<{ files: string[]; truncated: boolean }> {
	const needle = query.toLowerCase();
	const files: string[] = [];
	let scanned = 0;
	let visited = 0;
	for await (const entry of new Bun.Glob("**/*").scan({ cwd, onlyFiles: true, dot: false, followSymlinks: false })) {
		const rel = entry.replace(/\\/g, "/");
		if (++visited > MAX_VISITED_PATHS) return { files, truncated: true };
		if (rel.split("/").some(part => SKIP_DIRS.has(part))) continue;
		if (++scanned > MAX_SCANNED_FILES) return { files, truncated: true };
		if (needle && !rel.toLowerCase().includes(needle)) continue;
		files.push(rel);
		if (files.length >= MAX_SEARCH_RESULTS) return { files, truncated: true };
	}
	return { files, truncated: false };
}

/** `@` completion may only look inside a directory the app already knows: a project or a session cwd. */
async function knownCwd(cwd: string): Promise<boolean> {
	if (!cwd) return false;
	const { projects, sessions } = await sessionIndex();
	return (
		projects.some(p => samePath(p.path, cwd)) ||
		sessions.some(s => s.cwd && samePath(s.cwd, cwd)) ||
		(hub.sessions.size > 0 && [...hub.sessions.values()].some(l => samePath(l.cwd, cwd)))
	);
}

/** Rename through the gateway: the session may not be running yet, and the hub refreshes the index. */
async function renameSession(file: string, name: string): Promise<{ key: string }> {
	const live = await ensureLive(file);
	const res = await live.command({ type: "set_session_name", name });
	if (!res.success) throw new HttpError(String(res.error ?? "重命名失败"), 400);
	return { key: live.key };
}

/** Write the transcript as standalone HTML under `<dataDir>/exports` and hand back its file name. */
async function exportSession(file: string): Promise<{ name: string }> {
	const live = await ensureLive(file);
	const name = `${path.basename(file).replace(/\.jsonl$/i, "")}.html`;
	const dir = path.join(config.dataDir, "exports");
	await fs.mkdir(dir, { recursive: true });
	const res = await live.command({ type: "export_html", outputPath: path.join(dir, name) });
	if (!res.success) throw new HttpError(String(res.error ?? "导出失败"), 400);
	return { name };
}

/** Hide (or unhide) a session in the web UI. The file itself is not touched. */
async function archiveSession(file: string, archived: boolean): Promise<{ ok: true }> {
	const source = path.resolve(file);
	if (!inside(config.sessionsRoot, source)) throw new HttpError("不是会话文件", 400);
	await setArchived(source, archived);
	hub.indexChanged();
	return { ok: true };
}

/**
 * Permanently delete an archived session: its transcript and the artifact
 * directory next to it. Only archived sessions qualify (two deliberate steps),
 * and never one that is still running.
 */
async function deleteSession(file: string): Promise<{ ok: true }> {
	const source = path.resolve(file);
	if (!inside(config.sessionsRoot, source) || !source.toLowerCase().endsWith(".jsonl")) throw new HttpError("不是会话文件", 400);
	if (!(await archivedKeys()).has(archiveKey(source))) throw new HttpError("只能删除已归档的会话", 409);
	const live = hub.find(source);
	if (live?.state.isStreaming) throw new HttpError("会话正在运行，先停止再删除", 409);
	if (live) await hub.stop(live);
	await fs.rm(source, { force: true });
	const artifacts = source.replace(/\.jsonl$/i, "");
	if (inside(config.sessionsRoot, artifacts) && !samePath(artifacts, config.sessionsRoot)) await fs.rm(artifacts, { recursive: true, force: true });
	await setArchived(source, false);
	hub.indexChanged();
	return { ok: true };
}

let ompVersion: string | undefined;

/** Versions and data locations for the settings "关于" page. */
async function about() {
	if (ompVersion === undefined) {
		try {
			const proc = Bun.spawn([config.ompBin, "--version"], { stdout: "pipe", stderr: "ignore" });
			ompVersion = (await new Response(proc.stdout).text()).trim();
		} catch {
			ompVersion = "";
		}
	}
	const agentDir = path.dirname(config.sessionsRoot);
	return {
		ompVersion,
		agentDir,
		sessionsRoot: config.sessionsRoot,
		modelsFile: path.join(agentDir, "models.yml"),
		dataDir: config.dataDir,
		testProfile: Boolean(config.agentDir),
		modelLock: config.modelLock ?? null,
	};
}

let modelsCache: { at: number; models: unknown[] } | undefined;

/**
 * Model list without a live session (`omp models --json`), for pickers shown
 * before any process runs, e.g. reopening a session whose saved model is gone.
 */
async function listModels(): Promise<{ models: unknown[] }> {
	if (modelsCache && Date.now() - modelsCache.at < 60_000) return { models: modelsCache.models };
	const env: Record<string, string | undefined> = { ...process.env };
	if (config.agentDir) env.PI_CODING_AGENT_DIR = config.agentDir;
	const proc = Bun.spawn([config.ompBin, "models", "--json"], { stdout: "pipe", stderr: "ignore", env });
	const text = await new Response(proc.stdout).text();
	let models: unknown[] = [];
	try {
		const parsed = JSON.parse(text) as { models?: unknown[] };
		models = (parsed.models ?? []).filter(m => (m as { kind?: string }).kind !== "image");
	} catch {
		throw new HttpError("无法读取模型列表", 500);
	}
	modelsCache = { at: Date.now(), models };
	return { models };
}

/** Show a known location in the OS file manager. Only fixed targets, never a client-supplied path. */
async function reveal(target: string): Promise<{ ok: true }> {
	if (process.platform !== "win32") throw new HttpError("仅支持 Windows", 400);
	const info = await about();
	const map: Record<string, { path: string; select: boolean }> = {
		models: { path: info.modelsFile, select: true },
		agent: { path: info.agentDir, select: false },
		data: { path: info.dataDir, select: false },
	};
	const entry = map[target];
	if (!entry) throw new HttpError("未知位置", 400);
	const exists = await fs.stat(entry.path).then(() => true, () => false);
	const args = entry.select && exists ? ["explorer.exe", `/select,${entry.path}`] : ["explorer.exe", exists ? entry.path : path.dirname(entry.path)];
	Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
	return { ok: true };
}

/** Provider edits touch a file the user also edits by hand: never write when it does not parse. */
async function providersView(): Promise<ProvidersView> {
	try {
		return await readProviders();
	} catch (error) {
		throw new HttpError(`models.yml 解析失败，未做任何改动：${(error as Error).message}`, 409);
	}
}

/** Resolve the `cwd` query parameter of a panel endpoint, or refuse it. */
async function cwdParam(url: URL): Promise<string> {
	const raw = url.searchParams.get("cwd") ?? "";
	if (!raw) throw new HttpError("缺少 cwd", 400);
	const cwd = path.resolve(raw);
	if (!(await knownCwd(cwd))) throw new HttpError("未知项目目录", 403);
	return cwd;
}

function sendTo(ws: Socket, msg: ServerMsg): void {
	ws.send(JSON.stringify(msg));
}

async function onClientMessage(ws: Socket, msg: ClientMsg): Promise<void> {
	switch (msg.t) {
		case "attach": {
			sendTo(ws, { t: "proc", key: msg.key, status: "starting" });
			try {
				const live = await ensureLive(msg.key, typeof msg.model === "string" && msg.model ? msg.model : undefined);
				if (!samePath(live.key, msg.key)) sendTo(ws, { t: "rekey", from: msg.key, to: live.key });
				let set = attachments.get(ws);
				if (!set) attachments.set(ws, (set = new Set()));
				set.add(live);
				sendTo(ws, { t: "proc", key: live.key, status: "ready" });
				live.attach(ws);
				hub.indexChanged();
			} catch (error) {
				const lostModel = error instanceof ModelUnavailableError ? error.lostModel : undefined;
				sendTo(ws, { t: "proc", key: msg.key, status: "exited", error: (error as Error).message, lostModel });
			}
			return;
		}
		case "detach": {
			const live = hub.find(msg.key);
			if (!live) return;
			live.detach(ws);
			attachments.get(ws)?.delete(live);
			return;
		}
		case "rpc": {
			try {
				const live = hub.find(msg.key);
				if (!live) throw new Error("会话未运行");
				const res = await live.command(msg.cmd);
				sendTo(ws, res.success ? { t: "rpc_res", rid: msg.rid, ok: true, data: res.data } : { t: "rpc_res", rid: msg.rid, ok: false, error: String(res.error ?? "失败") });
			} catch (error) {
				sendTo(ws, { t: "rpc_res", rid: msg.rid, ok: false, error: (error as Error).message });
			}
			return;
		}
		case "ui": {
			hub.find(msg.key)?.answerUi(msg.payload);
			return;
		}
	}
}

async function api(req: Request, url: URL): Promise<Response> {
	const route = `${req.method} ${url.pathname}`;
	// Exported transcripts: read by file name out of `<dataDir>/exports`.
	if (route.startsWith("GET /api/exports/")) {
		const name = decodeURIComponent(url.pathname.slice("/api/exports/".length));
		if (!/^[A-Za-z0-9._-]+$/.test(name)) return fail("非法文件名");
		const file = Bun.file(path.join(config.dataDir, "exports", name));
		if (!(await file.exists())) return fail("导出文件不存在", 404);
		return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
	}
	try {
		switch (route) {
			case "GET /api/index":
				return json(await sessionIndex());
			case "POST /api/projects": {
				const body = (await req.json()) as { path: string };
				return json({ path: await addProject(body.path) });
			}
			case "DELETE /api/projects": {
				await removeProject(url.searchParams.get("path") ?? "");
				return json({ ok: true });
			}
			case "GET /api/fs":
				return json(await listDir(url.searchParams.get("path") ?? ""));
			case "GET /api/files/search":
				return json(await searchFiles(await cwdParam(url), url.searchParams.get("q") ?? ""));
			case "GET /api/fs/tree":
				return json(await listTree(await cwdParam(url), url.searchParams.get("path") ?? ""));
			case "GET /api/fs/file":
				return json(await readFileView(await cwdParam(url), url.searchParams.get("path") ?? ""));
			case "GET /api/fs/raw": {
				const { file, type } = contentTypeFor(await cwdParam(url), url.searchParams.get("path") ?? "");
				const body = Bun.file(file);
				if (!(await body.exists())) return fail("文件不存在", 404);
				return new Response(body, { headers: { "content-type": type, "cache-control": "no-store" } });
			}
			case "GET /api/git/status":
				return json(await gitStatus(await cwdParam(url)));
			case "GET /api/git/diff":
				return json(await gitDiff(await cwdParam(url), url.searchParams.get("path") ?? ""));
			case "POST /api/sessions": {
				const body = (await req.json()) as { cwd: string };
				const live = await hub.create(path.resolve(body.cwd));
				return json({ key: live.key, cwd: live.cwd });
			}
			case "POST /api/sessions/rename": {
				const body = (await req.json()) as { path: string; name: string };
				return json(await renameSession(path.resolve(body.path), body.name));
			}
			case "POST /api/sessions/export":
				return json(await exportSession(path.resolve(((await req.json()) as { path: string }).path)));
			case "POST /api/sessions/archive": {
				const body = (await req.json()) as { path: string; archived: boolean };
				return json(await archiveSession(body.path, body.archived !== false));
			}
			case "POST /api/sessions/delete":
				return json(await deleteSession(((await req.json()) as { path: string }).path));
			case "GET /api/models":
				return json(await listModels());
			case "GET /api/about":
				return json(await about());
			case "GET /api/providers":
				return json(await providersView());
			case "POST /api/providers": {
				const body = (await req.json()) as ProviderConfig;
				if (!body?.id) return fail("缺少供应商 ID");
				try {
					assertProviderId(body.id);
				} catch (error) {
					throw new HttpError((error as Error).message, 400);
				}
				try {
					return json(await writeProvider(body.id, body));
				} catch (error) {
					throw new HttpError(`写入 models.yml 失败，未做改动：${(error as Error).message}`, 409);
				}
			}
			case "DELETE /api/providers":
				return json(await removeProvider(url.searchParams.get("id") ?? ""));
			case "POST /api/reveal":
				return json(await reveal(((await req.json()) as { target: string }).target));
			case "GET /api/health":
				return json({
					ok: true,
					api: API_VERSION,
					pid: process.pid,
					startedAt,
					live: hub.sessions.size,
					agentDir: config.agentDir ?? null,
					modelLock: config.modelLock ?? null,
				});
		}
		return fail("not found", 404);
	} catch (error) {
		return fail(error, error instanceof HttpError ? error.status : 400);
	}
}

async function staticFile(url: URL): Promise<Response> {
	const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
	const file = path.join(config.distDir, rel);
	if (rel && file.startsWith(config.distDir)) {
		const f = Bun.file(file);
		if (await f.exists()) {
			const immutable = rel.startsWith("assets/");
			return new Response(f, { headers: immutable ? { "cache-control": "public, max-age=31536000, immutable" } : {} });
		}
	}
	const index = Bun.file(path.join(config.distDir, "index.html"));
	if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
	return new Response("前端未构建：请运行 bun run build，或使用 bun run dev。", { status: 503 });
}

const server = Bun.serve<{ id: number }>({
	hostname: config.host,
	port: config.port,
	idleTimeout: 120,
	async fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			if (srv.upgrade(req, { data: { id: nextSocketId++ } })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		}
		if (url.pathname.startsWith("/api/")) return api(req, url);
		return staticFile(url);
	},
	websocket: {
		maxPayloadLength: 32 * 1024 * 1024,
		open(ws) {
			hub.clients.add(ws);
		},
		message(ws, raw) {
			let msg: ClientMsg;
			try {
				msg = JSON.parse(String(raw)) as ClientMsg;
			} catch {
				return;
			}
			void onClientMessage(ws, msg);
		},
		close(ws) {
			hub.clients.delete(ws);
			for (const live of attachments.get(ws) ?? []) live.detach(ws);
			attachments.delete(ws);
		},
	},
});

console.log(`OMP Web  http://${server.hostname}:${server.port}/`);
if (config.agentDir) console.log(`  profile: ${config.agentDir}`);
if (config.modelLock) console.log(`  model lock: ${config.modelLock.provider}/${config.modelLock.model}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void hub.shutdown().finally(() => process.exit(0));
	});
}
