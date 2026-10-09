/**
 * Subagent bookkeeping shared by the gateway and the browser store: both fold
 * the same `subagent_lifecycle` / `subagent_progress` frames into one map.
 */
import type { SubagentLifecyclePayload, SubagentProgressPayload, SubagentSnapshot } from "./rpc-wire.ts";

/** Progress frames carry only the index, so an entry may start life without an id. */
export function progressKey(index: number): string {
	return `index:${index}`;
}

export function applySubagentLifecycle(all: Map<string, SubagentSnapshot>, payload: SubagentLifecyclePayload): void {
	const previous = all.get(payload.id);
	// A progress frame may have created an index-keyed placeholder before its lifecycle arrived.
	all.delete(progressKey(payload.index));
	all.set(payload.id, {
		id: payload.id,
		index: payload.index,
		agent: payload.agent,
		agentSource: payload.agentSource,
		status: payload.status === "started" ? "running" : payload.status,
		lastUpdate: Date.now(),
		description: payload.description ?? previous?.description,
		task: previous?.task,
		assignment: previous?.assignment,
		sessionFile: payload.sessionFile ?? previous?.sessionFile,
		progress: previous?.progress,
		parentToolCallId: payload.parentToolCallId ?? previous?.parentToolCallId,
	});
}

export function applySubagentProgress(all: Map<string, SubagentSnapshot>, payload: SubagentProgressPayload): void {
	// The raw AgentProgress record carries the subagent id; fall back to the index only when it does not
	// (indices restart per batch, so then bind to the most recently touched entry with that index).
	const progressId = typeof payload.progress?.id === "string" ? payload.progress.id : undefined;
	const existing = progressId
		? (all.get(progressId) ?? all.get(progressKey(payload.index)))
		: [...all.values()].filter(s => s.index === payload.index).sort((a, b) => b.lastUpdate - a.lastUpdate)[0];
	const id = progressId ?? existing?.id ?? progressKey(payload.index);
	if (existing && existing.id !== id) all.delete(existing.id);
	const progressStatus = payload.progress?.status as SubagentSnapshot["status"] | undefined;
	all.set(id, {
		id,
		index: payload.index,
		agent: payload.agent,
		agentSource: payload.agentSource,
		// Lifecycle frames own terminal states; progress may only report a live one.
		status: existing && existing.status !== "running" && existing.status !== "pending" ? existing.status : (progressStatus ?? existing?.status ?? "running"),
		lastUpdate: Date.now(),
		description: existing?.description,
		task: payload.task,
		assignment: payload.assignment,
		sessionFile: payload.sessionFile ?? existing?.sessionFile,
		progress: payload.progress,
		parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
	});
}
