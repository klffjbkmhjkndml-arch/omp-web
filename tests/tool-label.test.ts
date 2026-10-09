/**
 * Tool labels and file-change extraction. Backslashes and newlines are built
 * with String.fromCharCode so no level of escaping can eat them.
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "../shared/api.ts";
import { buildTurns, editPaths, fileChanges, mergeChanges, type Step, toolLabel, turnSteps } from "../web/src/lib/turns.ts";

const BS = String.fromCharCode(92); // backslash
const LF = String.fromCharCode(10); // newline
const msg = (value: Record<string, unknown>): AgentMessage => value as unknown as AgentMessage;
type ToolStep = Extract<Step, { kind: "tool" }>;

/** An `edit` step whose result carries the given diff details. */
function editStep(id: string, path: string, diff: string, op = "update"): ToolStep {
	return {
		kind: "tool",
		key: id,
		live: false,
		call: { type: "toolCall", id, name: "edit", arguments: { path, input: "" } },
		result: { details: { path, diff, op } },
	};
}

function diff(added: number, removed: number): string {
	return ["--- a/x", "+++ b/x", ...Array(added).fill("+新增"), ...Array(removed).fill("-删除")].join(LF);
}

describe("toolLabel", () => {
	test("bash 把续行合并成一行", () => {
		const command = `echo one ${BS}${LF}   && echo two`;
		const label = toolLabel("bash", { command });
		expect(label.verb).toBe("运行");
		expect(label.target).toBe("echo one && echo two");
	});

	test("write xd://foo 显示为“调用 foo”", () => {
		const label = toolLabel("write", { path: "xd://foo" });
		expect(label.verb).toBe("调用");
		expect(label.target).toBe("foo");
	});

	test("hashline 的 edit 输入能取出路径", () => {
		const input = [`[a.ts#1A2B]`, "@@ -1 +1 @@", "-旧", "+新"].join(LF);
		expect(editPaths("edit", { input })).toEqual(["a.ts"]);
		expect(toolLabel("edit", { input })).toMatchObject({ verb: "编辑", target: "a.ts" });
	});

	test("apply_patch 风格的 edit 输入也能取路径", () => {
		const input = [`*** Update File: src${BS}b.ts`, "@@", "-旧", "+新"].join(LF);
		expect(editPaths("edit", { input })).toEqual([`src${BS}b.ts`]);
	});

	test("没有工具名时显示“准备工具调用”", () => {
		expect(toolLabel(undefined)).toMatchObject({ verb: "准备工具调用", target: "" });
	});
});

describe("fileChanges / mergeChanges", () => {
	const cwd = `E:${BS}work${BS}proj`;

	test("以 cwd 为基准把绝对路径转成相对路径", () => {
		const step = editStep("c1", `${cwd}${BS}src${BS}a.ts`, diff(3, 1));
		expect(fileChanges(step, cwd)).toEqual([{ path: "src/a.ts", diff: diff(3, 1), stat: { added: 3, removed: 1 }, op: "update" }]);
	});

	test("同一文件的相对路径和绝对路径合并成一项", () => {
		const relative = editStep("c1", "src/a.ts", diff(1, 0));
		const absolute = editStep("c2", `${cwd}${BS}src${BS}a.ts`, diff(2, 1));
		const other = editStep("c3", "src/b.ts", diff(1, 1));
		const merged = mergeChanges([relative, absolute, other], cwd);
		expect(merged).toHaveLength(2);
		const a = merged.find(c => c.path === "src/a.ts");
		expect(a).toBeDefined();
		expect(a?.stat).toEqual({ added: 3, removed: 1 });
		expect(a?.diff.split(LF).filter(l => l.startsWith("+") && !l.startsWith("+++"))).toHaveLength(3);
	});

	test("失败的工具调用不产生改动", () => {
		const step: ToolStep = { ...editStep("c1", "src/a.ts", diff(1, 0)), result: { details: { path: "src/a.ts", diff: diff(1, 0) }, isError: true } };
		expect(fileChanges(step, cwd)).toEqual([]);
	});

	test("write 用内容行数作为新增行数", () => {
		const turns = buildTurns([
			msg({ role: "user", content: "写文件", timestamp: 1 }),
			msg({ role: "assistant", content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "notes.md", content: `一${LF}二${LF}三${LF}` } }], timestamp: 2 }),
			msg({ role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "ok" }], timestamp: 3 }),
		]);
		const step = turnSteps(turns[0]).find(s => s.kind === "tool") as ToolStep;
		expect(fileChanges(step, cwd)).toEqual([{ path: "notes.md", diff: "", stat: { added: 3, removed: 0 }, op: "write" }]);
	});
});
