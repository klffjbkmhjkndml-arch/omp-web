export function duration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${Math.max(1, s)} 秒`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} 分 ${s % 60} 秒`;
	return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

export function relativeTime(epochMs: number): string {
	const diff = Date.now() - epochMs;
	const min = Math.floor(diff / 60_000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分钟前`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h} 小时前`;
	const d = Math.floor(h / 24);
	if (d < 30) return `${d} 天前`;
	return new Date(epochMs).toLocaleDateString("zh-CN");
}

export function tokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

const EFFORT_NAMES: Record<string, string> = {
	off: "关闭",
	minimal: "极低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "超高",
	max: "最高",
	auto: "自动",
	inherit: "默认",
};

export function effortName(level: string | undefined): string {
	return level ? (EFFORT_NAMES[level] ?? level) : "";
}
