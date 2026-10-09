/**
 * One `omp --mode rpc-ui` child process.
 *
 * Owns stdio framing: JSONL lines, protocol v2 `rpc_chunk` reassembly, and
 * command/response correlation by `id`. Every other frame is handed to
 * `onFrame` untouched — interpretation lives in the session hub and browser.
 */
import type { Subprocess } from "bun";
import { config } from "./config.ts";

type Frame = Record<string, unknown> & { type: string };

interface PendingRequest {
	resolve: (frame: Frame) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface OmpProcessOptions {
	cwd: string;
	/** Session file to resume; omitted starts a fresh session. */
	resume?: string;
	/** Explicit `--model` selector; skips omp's restore of the session's saved model. */
	model?: string;
	onFrame: (frame: Frame) => void;
	onExit: (code: number | null, stderrTail: string) => void;
}

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

/** Reassembles protocol-v2 chunk sequences (see omp docs/rpc.md "Transport and Framing"). */
export class ChunkDecoder {
	#pending?: { chunkId: string; count: number; byteLength: number; next: number; parts: Uint8Array[]; received: number };

	push(value: Frame): Frame | undefined {
		if (value.type !== "rpc_chunk") {
			if (this.#pending) throw new Error("rpc chunk sequence interrupted");
			return value;
		}
		const { chunkId, index, count, byteLength, data } = value as unknown as {
			chunkId: string;
			index: number;
			count: number;
			byteLength: number;
			data: string;
		};
		if (
			typeof chunkId !== "string" ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			count < 2 ||
			index < 0 ||
			index >= count ||
			byteLength < MAX_FRAME_BYTES ||
			byteLength > MAX_REASSEMBLED_BYTES ||
			typeof data !== "string"
		) {
			throw new Error("invalid rpc chunk metadata");
		}
		if (!this.#pending) {
			if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
			this.#pending = { chunkId, count, byteLength, next: 0, parts: [], received: 0 };
		}
		const p = this.#pending;
		if (p.chunkId !== chunkId || p.count !== count || p.byteLength !== byteLength || p.next !== index) {
			throw new Error("rpc chunk sequence mismatch");
		}
		const bytes = Buffer.from(data, "base64");
		p.parts.push(bytes);
		p.received += bytes.byteLength;
		p.next++;
		if (p.received > p.byteLength) throw new Error("rpc chunk sequence exceeds declared length");
		if (p.next < p.count) return undefined;
		this.#pending = undefined;
		if (p.received !== p.byteLength) throw new Error("rpc chunk sequence length mismatch");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(p.parts));
		return JSON.parse(text) as Frame;
	}
}

export class OmpProcess {
	#proc: Subprocess<"pipe", "pipe", "pipe">;
	#pending = new Map<string, PendingRequest>();
	#nextId = 1;
	#stderr = "";
	#exited = false;
	readonly ready: Promise<void>;

	constructor(private readonly options: OmpProcessOptions) {
		const args = [config.ompBin, "--mode", "rpc-ui"];
		if (options.resume) args.push("--resume", options.resume);
		if (config.modelLock) args.push("--provider", config.modelLock.provider, "--model", config.modelLock.model);
		else if (options.model) args.push("--model", options.model);
		const env: Record<string, string | undefined> = { ...process.env };
		if (config.agentDir) env.PI_CODING_AGENT_DIR = config.agentDir;
		this.#proc = Bun.spawn(args, { cwd: options.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.ready = promise;
		let readySeen = false;

		void this.#readStdout(frame => {
			if (!readySeen && frame.type === "ready") {
				readySeen = true;
				// Must not block the read loop: the handshake responses arrive through it.
				const versions = (frame.supportedProtocolVersions as number[] | undefined) ?? [];
				void (async () => {
					if (versions.includes(2)) await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
					await this.request({ type: "set_event_filter", events: null, messageUpdates: "delta" });
					// One rich card for every question of an `ask` call instead of select+editor per question.
					await this.request({ type: "set_ask_dialog", enabled: true });
					// Lifecycle + aggregated progress frames drive the subagent panel.
					await this.request({ type: "set_subagent_subscription", level: "progress" });
				})().then(resolve, reject);
				return;
			}
			options.onFrame(frame);
		});
		void this.#readStderr();
		void this.#proc.exited.then(code => {
			this.#exited = true;
			const error = new Error(`omp exited (${code})`);
			for (const p of this.#pending.values()) {
				clearTimeout(p.timer);
				p.reject(error);
			}
			this.#pending.clear();
			if (!readySeen) reject(new Error(`omp exited before ready (${code}): ${this.stderrTail()}`));
			options.onExit(code, this.stderrTail());
		});
	}

	get exited(): boolean {
		return this.#exited;
	}

	stderrTail(): string {
		return this.#stderr.slice(-2000);
	}

	/** Send a command and resolve with its `response` frame (success or failure). */
	request(command: Record<string, unknown>, timeoutMs = 120_000): Promise<Frame> {
		if (this.#exited) return Promise.reject(new Error("omp process has exited"));
		const id = `w${this.#nextId++}`;
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`omp command timed out: ${String(command.type)}`));
		}, timeoutMs);
		this.#pending.set(id, { resolve, reject, timer });
		this.write({ ...command, id });
		return promise;
	}

	/** Fire-and-forget inbound frame (extension_ui_response etc.). */
	write(frame: Record<string, unknown>): void {
		if (this.#exited) return;
		this.#proc.stdin.write(`${JSON.stringify(frame)}\n`);
		this.#proc.stdin.flush();
	}

	/** Graceful stop: close stdin so omp drains and exits; kill after a grace period. */
	async stop(graceMs = 3000): Promise<void> {
		if (this.#exited) return;
		try {
			this.#proc.stdin.end();
		} catch {
			// already closed
		}
		const timeout = Bun.sleep(graceMs).then(() => "timeout" as const);
		if ((await Promise.race([this.#proc.exited, timeout])) === "timeout") this.#proc.kill();
	}

	async #readStdout(onFrame: (frame: Frame) => void): Promise<void> {
		const decoder = new ChunkDecoder();
		const text = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.#proc.stdout) {
			buffer += text.decode(chunk, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				if (!line) continue;
				let frame: Frame | undefined;
				try {
					frame = decoder.push(JSON.parse(line) as Frame);
				} catch (error) {
					console.error("[omp] bad frame:", (error as Error).message);
					continue;
				}
				if (!frame) continue;
				if (frame.type === "response" && typeof frame.id === "string") {
					const pending = this.#pending.get(frame.id);
					if (pending) {
						this.#pending.delete(frame.id);
						clearTimeout(pending.timer);
						pending.resolve(frame);
						// prompt responses are also relevant to the UI (prompt_result follows with same id)
						continue;
					}
				}
				onFrame(frame);
			}
		}
	}

	async #readStderr(): Promise<void> {
		const text = new TextDecoder();
		for await (const chunk of this.#proc.stderr) {
			this.#stderr = (this.#stderr + text.decode(chunk, { stream: true })).slice(-20_000);
		}
	}
}
