/**
 * `ompweb` entry point (shims live in ~/.bun/bin).
 *
 *   ompweb            daily profile (~/.omp/agent), http://127.0.0.1:30190
 *   ompweb --test     isolated example profile, http://127.0.0.1:30191
 *   ompweb --restart  stop a running server first (needed after server/ changes)
 *   ompweb --no-open  start without opening the browser
 *
 * Already running → just open the page, unless that server is older than the
 * files under server/ and shared/ (it would be missing new routes); then say so
 * and wait for `--restart`. Otherwise rebuild the frontend when web sources are
 * newer than dist/, start the gateway in this terminal (Ctrl+C stops it), and
 * open the page once it answers.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { API_VERSION } from "../shared/api.ts";

const root = path.resolve(import.meta.dir, "..");
const test = process.argv.includes("--test");
const noOpen = process.argv.includes("--no-open");
const restart = process.argv.includes("--restart");
const port = Number(process.env.OMP_WEB_PORT ?? (test ? 30191 : 30190));
const url = `http://127.0.0.1:${port}/`;

interface Health {
	api?: number;
	pid?: number;
	startedAt?: number;
}

async function health(): Promise<Health | undefined> {
	try {
		const res = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(800) });
		return res.ok ? ((await res.json()) as Health) : undefined;
	} catch {
		return undefined;
	}
}

async function healthy(): Promise<boolean> {
	return (await health()) !== undefined;
}

function openBrowser(): void {
	if (noOpen) return;
	const cmd = process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
	Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
}

/** Newest mtime under `dir`, skipping nothing (web sources are small). */
async function newest(dir: string): Promise<number> {
	let max = 0;
	for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		const stat = await fs.stat(path.join(entry.parentPath, entry.name));
		max = Math.max(max, stat.mtimeMs);
	}
	return max;
}

async function needsBuild(): Promise<boolean> {
	try {
		const built = (await fs.stat(path.join(root, "dist", "index.html"))).mtimeMs;
		const sources = Math.max(await newest(path.join(root, "web")), await newest(path.join(root, "shared")));
		return sources > built;
	} catch {
		return true;
	}
}

/** Newest source of the gateway itself; a process older than this lacks the latest routes. */
async function newestServerSource(): Promise<number> {
	return Math.max(await newest(path.join(root, "server")), await newest(path.join(root, "shared")));
}

/** True when the running gateway predates this checkout (or another API version). */
async function isStaleServer(current: Health): Promise<boolean> {
	if (current.api !== API_VERSION) return true;
	if (!current.startedAt) return true;
	return (await newestServerSource()) > current.startedAt;
}

async function stopRunning(current: Health): Promise<void> {
	if (!current.pid) {
		console.error("这个服务没有报告进程号，无法自动重启：请在它的终端按 Ctrl+C，然后重新运行 ompweb");
		process.exit(1);
	}
	try {
		process.kill(current.pid);
	} catch (error) {
		console.error(`停止旧服务失败：${(error as Error).message}`);
		process.exit(1);
	}
	for (let i = 0; i < 25; i++) {
		await Bun.sleep(200);
		if (!(await healthy())) {
			console.log(`已停止旧服务（pid ${current.pid}），正在启动新的…`);
			return;
		}
	}
	console.error("旧服务还在监听该端口，请手动停止后重试");
	process.exit(1);
}

const running = await health();
if (running && !(await isStaleServer(running))) {
	console.log(`OMP Web 已在运行：${url}`);
	openBrowser();
	process.exit(0);
}
if (running) {
	if (!restart) {
		console.log(`OMP Web 已在运行，但服务端是旧版本（server/ 或 shared/ 有更新）：${url}`);
		console.log(`重启后即可用上新接口：ompweb${test ? " --test" : ""} --restart`);
		process.exit(1);
	}
	await stopRunning(running);
}

if (await needsBuild()) {
	console.log("前端有更新，正在构建…");
	const build = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
	if ((await build.exited) !== 0) {
		console.error("构建失败，请在 04_Web 目录运行 bun run build 查看错误");
		process.exit(1);
	}
}

process.env.OMP_WEB_PORT = String(port);
void (async () => {
	for (let i = 0; i < 50; i++) {
		await Bun.sleep(200);
		if (await healthy()) {
			openBrowser();
			console.log("按 Ctrl+C 停止服务");
			return;
		}
	}
	console.error(`服务未在 10 秒内就绪，请检查上面的输出（端口 ${port} 是否被占用）`);
})();
await import("./serve.ts");
