/** Single WebSocket to the gateway: reconnects, re-attaches sessions, correlates RPC replies. */
import type { ClientMsg, ServerMsg } from "../../../shared/api.ts";

type Listener = (msg: ServerMsg) => void;

class Gateway {
	#ws?: WebSocket;
	#outbox: string[] = [];
	#listeners = new Set<Listener>();
	#pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	#attached = new Set<string>();
	#nextRid = 1;
	#retry = 0;
	connected = false;
	#statusListeners = new Set<() => void>();

	connect(): void {
		const proto = location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${proto}://${location.host}/ws`);
		this.#ws = ws;
		ws.onopen = () => {
			this.#retry = 0;
			this.#setConnected(true);
			for (const key of this.#attached) ws.send(JSON.stringify({ t: "attach", key } satisfies ClientMsg));
			for (const text of this.#outbox.splice(0)) ws.send(text);
		};
		ws.onmessage = ev => {
			const msg = JSON.parse(String(ev.data)) as ServerMsg;
			if (msg.t === "rpc_res") {
				const p = this.#pending.get(msg.rid);
				if (p) {
					this.#pending.delete(msg.rid);
					if (msg.ok) p.resolve(msg.data);
					else p.reject(new Error(msg.error ?? "失败"));
				}
				return;
			}
			if (msg.t === "rekey" && this.#attached.delete(msg.from)) this.#attached.add(msg.to);
			for (const l of this.#listeners) l(msg);
		};
		ws.onclose = () => {
			this.#setConnected(false);
			for (const p of this.#pending.values()) p.reject(new Error("连接已断开"));
			this.#pending.clear();
			const delay = Math.min(5000, 300 * 2 ** this.#retry++);
			setTimeout(() => this.connect(), delay);
		};
	}

	#setConnected(value: boolean): void {
		this.connected = value;
		for (const l of this.#statusListeners) l();
	}

	onStatus(listener: () => void): () => void {
		this.#statusListeners.add(listener);
		return () => this.#statusListeners.delete(listener);
	}

	#send(msg: ClientMsg): void {
		const text = JSON.stringify(msg);
		if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(text);
		else if (msg.t !== "attach") this.#outbox.push(text); // attaches are replayed on open
	}

	on(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** `model` only applies to this attach; reconnects resume whatever the session has saved. */
	attach(key: string, model?: string): void {
		this.#attached.add(key);
		this.#send(model ? { t: "attach", key, model } : { t: "attach", key });
	}

	detach(key: string): void {
		this.#attached.delete(key);
		this.#send({ t: "detach", key });
	}

	rpc<T = unknown>(key: string, cmd: Record<string, unknown>): Promise<T> {
		const rid = `r${this.#nextRid++}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(rid, { resolve, reject });
		this.#send({ t: "rpc", key, rid, cmd });
		return promise as Promise<T>;
	}

	ui(key: string, payload: Record<string, unknown>): void {
		this.#send({ t: "ui", key, payload });
	}
}

export const gateway = new Gateway();

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
	const data = (await res.json()) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? res.statusText);
	return data;
}
