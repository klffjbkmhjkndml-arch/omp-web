/**
 * QA extension for the OMP Web test profile: triggers the four extension UI
 * dialogs without calling any model. Loaded from `.data/omp-agent/extensions/`
 * by `scripts/setup-test-profile.ts`.
 */
export default function webQa(pi) {
	pi.registerCommand("web-qa-confirm", {
		description: "测试：确认弹窗",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Web 验收确认", "确认这项本地测试操作？");
			ctx.ui.notify(ok ? "已确认" : "已拒绝", "info");
		},
	});
	pi.registerCommand("web-qa-select", {
		description: "测试：选择弹窗",
		handler: async (_args, ctx) => {
			const v = await ctx.ui.select("选一个方案", ["方案 A", "方案 B", "方案 C"]);
			ctx.ui.notify(`选择：${v ?? "取消"}`, "info");
		},
	});
	pi.registerCommand("web-qa-input", {
		description: "测试：输入弹窗",
		handler: async (_args, ctx) => {
			const v = await ctx.ui.input("输入名字", "例如 Rain");
			ctx.ui.notify(`输入：${v ?? "取消"}`, "info");
		},
	});
	pi.registerCommand("web-qa-editor", {
		description: "测试：编辑器弹窗",
		handler: async (_args, ctx) => {
			const v = await ctx.ui.editor("编辑一段文字", "第一行\n第二行");
			ctx.ui.notify(`编辑后长度：${v?.length ?? 0}`, "info");
		},
	});
}
