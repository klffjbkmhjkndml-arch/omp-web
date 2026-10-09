/**
 * Session index reads JSONL heads. `config` snapshots `OMP_WEB_AGENT_DIR` at
 * import time, so the env var must be set before the dynamic import.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = path.join(os.tmpdir(), `omp-web-index-${process.pid}-${Date.now()}`);
const previousAgentDir = process.env.OMP_WEB_AGENT_DIR;

let listSessions: (typeof import("../server/session-index.ts"))["listSessions"];
let titleFromText: (typeof import("../server/session-index.ts"))["titleFromText"];

function jsonl(entries: Record<string, unknown>[]): string {
	return `${entries.map(e => JSON.stringify(e)).join("\n")}\n`;
}

/** A real omp title slot (omp only recognizes it with `v`, `updatedAt` and `pad`). */
function slot(title: string): Record<string, unknown> {
	return { type: "title", v: 1, title, updatedAt: "2026-01-01T00:00:00.000Z", pad: "" };
}

async function writeSession(name: string, entries: Record<string, unknown>[]): Promise<string> {
	const file = path.join(root, "sessions", "proj", name);
	await fs.writeFile(file, jsonl(entries));
	return file;
}

beforeAll(async () => {
	await fs.mkdir(path.join(root, "sessions", "proj"), { recursive: true });
	// title 槽为空：标题回退到首条 user 消息
	await writeSession("fallback.jsonl", [
		slot(""),
		{ type: "session", id: "sess-fallback", cwd: "E:\\work\\proj", timestamp: "2026-01-02T03:04:05.000Z" },
		{ type: "message", message: { role: "assistant", content: "先说话的是助手" } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "回退用的第一条消息" }] } },
	]);
	// title 槽有内容
	await writeSession("titled.jsonl", [
		slot("标题槽里的标题"),
		{ type: "session", id: "sess-titled", cwd: "E:\\work\\proj", timestamp: "2026-01-03T03:04:05.000Z" },
		{ type: "message", message: { role: "user", content: "不该被用到的消息" } },
	]);
	// 没有 user 消息也没有标题：整条跳过
	await writeSession("empty.jsonl", [{ type: "session", id: "sess-empty", cwd: "E:\\work\\proj", timestamp: "2026-01-04T03:04:05.000Z" }]);
	process.env.OMP_WEB_AGENT_DIR = root;
	const mod = await import("../server/session-index.ts");
	// bun shares one module registry across test files, so another file may have
	// imported config.ts first (and captured the default root). Pin it explicitly
	// so this file never depends on import order — or reads the real agent dir.
	const { config } = await import("../server/config.ts");
	config.sessionsRoot = path.join(root, "sessions");
	listSessions = mod.listSessions;
	titleFromText = mod.titleFromText;
});

afterAll(async () => {
	if (previousAgentDir === undefined) delete process.env.OMP_WEB_AGENT_DIR;
	else process.env.OMP_WEB_AGENT_DIR = previousAgentDir;
	await fs.rm(root, { recursive: true, force: true });
});

describe("listSessions", () => {
	test("标题回退到首条 user 消息，没有 user 消息的会话被跳过", async () => {
		const sessions = await listSessions();
		expect(sessions).toHaveLength(2);
		expect(sessions.map(s => s.id).sort()).toEqual(["sess-fallback", "sess-titled"]);

		const fallback = sessions.find(s => s.id === "sess-fallback");
		expect(fallback?.title).toBe("回退用的第一条消息");
		expect(fallback?.cwd).toBe("E:\\work\\proj");
		expect(fallback?.created).toBe(Date.parse("2026-01-02T03:04:05.000Z"));

		const titled = sessions.find(s => s.id === "sess-titled");
		expect(titled?.title).toBe("标题槽里的标题");
	});

	test("omp 打不开的文件（标题槽缺 pad、首条不是 session 头）不列出", async () => {
		const file = await writeSession("bad-slot.jsonl", [
			{ type: "title", v: 1, title: "手写的假槽", updatedAt: "2026-01-06T00:00:00.000Z" },
			{ type: "session", id: "sess-bad-slot", cwd: "E:\\work\\proj", timestamp: "2026-01-06T00:00:00.000Z" },
			{ type: "message", message: { role: "user", content: "打不开" } },
		]);
		const sessions = await listSessions();
		expect(sessions.some(s => s.id === "sess-bad-slot")).toBe(false);
		await fs.rm(file, { force: true });
	});

	test("跳过损坏的 JSON 行，不影响其它会话", async () => {
		const file = path.join(root, "sessions", "proj", "broken.jsonl");
		await fs.writeFile(
			file,
			`${JSON.stringify({ type: "session", id: "sess-broken", cwd: "E:\\work\\proj", timestamp: "2026-01-05T03:04:05.000Z" })}\n{ 不是合法 JSON\n${JSON.stringify({ type: "message", message: { role: "user", content: "坏行之后的消息" } })}\n`,
		);
		const sessions = await listSessions();
		expect(sessions.find(s => s.id === "sess-broken")?.title).toBe("坏行之后的消息");
		await fs.rm(file, { force: true });
	});
});

describe("titleFromText", () => {
	test("压缩空白并在 60 个字符处截断", () => {
		expect(titleFromText("  多个   空格  ")).toBe("多个 空格");
		const long = "字".repeat(80);
		const title = titleFromText(long);
		expect(title).toHaveLength(61);
		expect(title.endsWith("…")).toBe(true);
	});
});
