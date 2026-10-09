/**
 * Protocol v2 chunk reassembly: a >1 MiB frame arrives as several `rpc_chunk`
 * records (payload sliced at 256 KiB, base64 in `data`) and must come back
 * byte-identical. Broken sequences must fail loudly instead of silently
 * producing a truncated frame.
 */
import { describe, expect, test } from "bun:test";
import { ChunkDecoder } from "../server/omp-process.ts";

type Frame = Record<string, unknown> & { type: string };

/** OMP's RPC_CHUNK_PAYLOAD_BYTES: raw bytes per chunk before base64. */
const CHUNK_BYTES = 256 * 1024;
/** The decoder only accepts declared lengths of at least this many bytes. */
const MIN_DECLARED_BYTES = 1024 * 1024;

function split(value: unknown, chunkBytes = CHUNK_BYTES, chunkId = "chunk-1"): Frame[] {
	const bytes = Buffer.from(JSON.stringify(value), "utf8");
	const count = Math.ceil(bytes.byteLength / chunkBytes);
	expect(count).toBeGreaterThanOrEqual(2);
	const frames: Frame[] = [];
	for (let index = 0; index < count; index++) {
		const slice = bytes.subarray(index * chunkBytes, Math.min((index + 1) * chunkBytes, bytes.byteLength));
		frames.push({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.byteLength, data: slice.toString("base64") });
	}
	return frames;
}

function decode(frames: Frame[]): Frame[] {
	const decoder = new ChunkDecoder();
	const out: Frame[] = [];
	for (const frame of frames) {
		const done = decoder.push(frame);
		if (done) out.push(done);
	}
	return out;
}

describe("ChunkDecoder", () => {
	test("非分片帧原样返回", () => {
		const frame: Frame = { type: "message_end", messageId: "m1" };
		expect(decode([frame])).toEqual([frame]);
	});

	test("1.5 MiB 的 JSON 分片后能完整还原", () => {
		const big = { type: "response", id: "r1", payload: "x".repeat(1.5 * 1024 * 1024) };
		const frames = split(big);
		expect(frames.length).toBeGreaterThan(2);
		expect(frames[0].byteLength as number).toBeGreaterThanOrEqual(MIN_DECLARED_BYTES);
		// every chunk carries at most 256 KiB of raw bytes
		for (const frame of frames) {
			expect(Buffer.from(String(frame.data), "base64").byteLength).toBeLessThanOrEqual(CHUNK_BYTES);
		}
		expect(decode(frames)).toEqual([big]);
	});

	test("多字节字符跨块切开也能还原", () => {
		const big = { type: "response", id: "r2", text: "中文".repeat(200_000) };
		expect(decode(split(big))).toEqual([big]);
	});

	test("序列中间插入别的帧时抛错", () => {
		const frames = split({ type: "response", id: "r3", payload: "y".repeat(1.2 * 1024 * 1024) });
		const decoder = new ChunkDecoder();
		expect(decoder.push(frames[0])).toBeUndefined();
		expect(() => decoder.push({ type: "message_end" })).toThrow("interrupted");
	});

	test("不是从第 0 块开始时抛错", () => {
		const frames = split({ type: "response", id: "r4", payload: "z".repeat(1.2 * 1024 * 1024) });
		const decoder = new ChunkDecoder();
		expect(() => decoder.push(frames[1])).toThrow("must start at index 0");
	});

	test("index 乱序时抛错", () => {
		const frames = split({ type: "response", id: "r5", payload: "w".repeat(1.2 * 1024 * 1024) });
		const decoder = new ChunkDecoder();
		expect(decoder.push(frames[0])).toBeUndefined();
		expect(() => decoder.push(frames[2])).toThrow("mismatch");
	});

	test("chunkId 或 count 变化时抛错", () => {
		const frames = split({ type: "response", id: "r6", payload: "v".repeat(1.2 * 1024 * 1024) });
		const decoder = new ChunkDecoder();
		expect(decoder.push(frames[0])).toBeUndefined();
		expect(() => decoder.push({ ...frames[1], chunkId: "other" })).toThrow("mismatch");
	});

	test("byteLength 与实际字节数不符时抛错", () => {
		const frames = split({ type: "response", id: "r7", payload: "u".repeat(1.2 * 1024 * 1024) });
		const wrong = frames.map(f => ({ ...f, byteLength: (f.byteLength as number) + 1 }));
		expect(() => decode(wrong)).toThrow("length mismatch");
	});

	test("声明的 byteLength 小于 1 MiB 时抛错", () => {
		const frames = split({ type: "response", id: "r8", payload: "t".repeat(1.2 * 1024 * 1024) });
		const small = frames.map(f => ({ ...f, byteLength: 1024 }));
		expect(() => decode(small)).toThrow("invalid rpc chunk metadata");
	});
});
