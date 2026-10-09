/**
 * Pure view-model tests: turn grouping, live steps, active-time accounting.
 * No DOM and no components here.
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "../shared/api.ts";
import { buildTurns, MAX_ACTIVE_GAP_MS, type Step, toolStatus, turnDuration, turnSteps } from "../web/src/lib/turns.ts";

const msg = (value: Record<string, unknown>): AgentMessage => value as unknown as AgentMessage;
const text = (value: string) => [{ type: "text", text: value }];
type ToolStep = Extract<Step, { kind: "tool" }>;

describe("buildTurns", () => {
	test("普通 user 消息开新回合，steering 与 synthetic 不开", () => {
		const turns = buildTurns([
			msg({ role: "user", content: "第一条", timestamp: 1 }),
			msg({ role: "assistant", content: text("回复一"), timestamp: 2 }),
			msg({ role: "user", content: "插一句话", steering: true, timestamp: 3 }),
			msg({ role: "user", content: "合成消息", synthetic: true, timestamp: 4 }),
			msg({ role: "user", content: "第二条", timestamp: 5 }),
		]);
		expect(turns).toHaveLength(2);
		expect(turns[0].user?.text).toBe("第一条");
		expect(turns[1].user?.text).toBe("第二条");
		// steering / synthetic 留在第一个回合里
		expect(turns[0].messages).toHaveLength(3);
		expect(turns[1].messages).toHaveLength(0);
	});

	test("steering 变成 steer 步骤，synthetic 被忽略", () => {
		const turns = buildTurns([
			msg({ role: "user", content: "问题", timestamp: 1 }),
			msg({ role: "assistant", content: text("回复"), timestamp: 2 }),
			msg({ role: "user", content: "插一句话", steering: true, timestamp: 3 }),
			msg({ role: "user", content: "合成消息", synthetic: true, timestamp: 4 }),
		]);
		const steps = turnSteps(turns[0]);
		expect(steps.map(s => s.kind)).toEqual(["text", "steer"]);
		expect(steps[1]).toMatchObject({ kind: "steer", text: "插一句话" });
	});

	test("compactionSummary 产生带 divider 的回合", () => {
		const turns = buildTurns([
			msg({ role: "user", content: "问题一", timestamp: 1 }),
			msg({ role: "assistant", content: text("回复"), timestamp: 2 }),
			msg({ role: "compactionSummary", content: "摘要", timestamp: 3 }),
			msg({ role: "user", content: "问题二", timestamp: 4 }),
		]);
		expect(turns).toHaveLength(3);
		expect(turns[0].divider).toBeUndefined();
		expect(turns[1].divider).toBe("上下文已压缩");
		expect(turns[1].user).toBeUndefined();
		expect(turns[1].messages).toHaveLength(0);
		expect(turns[2].user?.text).toBe("问题二");
	});
});

describe("turnDuration", () => {
	test("中间夹 3 天空闲：只算两段 5 秒活动，加一段封顶的 10 分钟", () => {
		const idle = 3 * 24 * 60 * 60 * 1000;
		const turn = {
			key: "t0",
			user: { text: "开始", images: 0, timestamp: 1 },
			messages: [
				msg({ role: "assistant", content: text("a"), timestamp: 1, duration: 5000 }),
				msg({ role: "assistant", content: text("b"), timestamp: idle + 5000, duration: 5000 }),
			],
		};
		expect(turnDuration(turn)).toBe(10_000 + MAX_ACTIVE_GAP_MS);
	});

	test("没有 user 消息、或只有一个时间点时算不出来", () => {
		expect(turnDuration({ key: "t0", messages: [] })).toBeUndefined();
		expect(turnDuration({ key: "t1", user: { text: "x", images: 0, timestamp: 100 }, messages: [] })).toBeUndefined();
	});
});

describe("turnSteps", () => {
	test("toolCall 与 toolResult 按 id 配对，isError 的结果为 error 状态", () => {
		const turns = buildTurns([
			msg({ role: "user", content: "动手", timestamp: 1 }),
			msg({ role: "assistant", content: [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "/tmp/a.ts" } }], timestamp: 2 }),
			msg({ role: "toolResult", toolCallId: "call1", content: text("文件内容"), timestamp: 3 }),
			msg({ role: "assistant", content: [{ type: "toolCall", id: "call2", name: "bash", arguments: { command: "false" } }], timestamp: 4 }),
			msg({ role: "toolResult", toolCallId: "call2", content: text("失败"), isError: true, timestamp: 5 }),
		]);
		const calls = turnSteps(turns[0]).filter(s => s.kind === "tool") as ToolStep[];
		expect(calls).toHaveLength(2);
		expect(calls[0].key).toBe("call1");
		expect(calls[0].result?.content?.[0]?.text).toBe("文件内容");
		expect(calls[0].exec).toBeUndefined();
		expect(toolStatus(calls[0])).toBe("done");
		expect(toolStatus(calls[1])).toBe("error");
	});

	test("没有结果的 toolCall 仍是 running", () => {
		const turns = buildTurns([
			msg({ role: "user", content: "动手", timestamp: 1 }),
			msg({ role: "assistant", content: [{ type: "toolCall", id: "call1", name: "read", arguments: {} }], timestamp: 2 }),
		]);
		const calls = turnSteps(turns[0]).filter(s => s.kind === "tool") as ToolStep[];
		expect(toolStatus(calls[0])).toBe("running");
	});

	test("上一轮已结束的工具执行不会漏进下一轮", () => {
		const turns = buildTurns([
			msg({ role: "user", content: "第一轮", timestamp: 1 }),
			msg({ role: "assistant", content: [{ type: "toolCall", id: "call1", name: "glob", arguments: { pattern: "**/*.md" } }], timestamp: 2 }),
			msg({ role: "toolResult", toolCallId: "call1", content: text("a.md"), timestamp: 3 }),
			msg({ role: "user", content: "第二轮", timestamp: 4 }),
		]);
		// store 里还留着上一轮的执行（agent_end 之前、或快照回放时）
		const settled = new Map([["call1", { id: "call1", name: "glob", args: { pattern: "**/*.md" }, status: "done" as const, startedAt: 1 }]]);
		expect(turnSteps(turns[1], undefined, settled).filter(s => s.kind === "tool")).toHaveLength(0);

		// 仍在运行、调用块还没到的执行才补成实时步骤
		const running = new Map([["call9", { id: "call9", name: "glob", args: {}, status: "running" as const, startedAt: 2 }]]);
		const live = turnSteps(turns[1], undefined, running).filter(s => s.kind === "tool") as ToolStep[];
		expect(live).toHaveLength(1);
		expect(live[0].exec?.status).toBe("running");
	});
});
