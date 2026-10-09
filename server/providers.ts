/**
 * Custom provider editing for `<agentDir>/models.yml`.
 *
 * omp owns this file and people hand-tune it (headers, compat, authHeader,
 * extra per-model fields). So edits are surgical: the file is parsed to read and
 * merge, then only the edited provider's own block is regenerated — every other
 * byte, comment included, is left alone. Each write keeps a timestamped backup.
 */
import * as path from "node:path";
import type { ProviderConfig, ProviderModel, ProvidersView } from "../shared/api.ts";
import { config } from "./config.ts";

export type { ProviderConfig, ProviderModel, ProvidersView };

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** `<agentDir>/models.yml` — the file omp reads providers from. */
export function modelsFile(): string {
	return path.join(path.dirname(config.sessionsRoot), "models.yml");
}

export function assertProviderId(id: string): string {
	const trimmed = id.trim();
	if (!ID_PATTERN.test(trimmed)) throw new Error("供应商 ID 只能包含字母、数字、下划线、点和横线");
	return trimmed;
}

async function readText(): Promise<string | undefined> {
	try {
		return await Bun.file(modelsFile()).text();
	} catch {
		return undefined;
	}
}

function parseDocument(text: string | undefined): Record<string, unknown> {
	if (!text) return {};
	const doc = Bun.YAML.parse(text) as unknown;
	return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
}

function parsedProviders(text: string | undefined): Map<string, Record<string, unknown>> {
	const providers = parseDocument(text).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return new Map();
	return new Map(Object.entries(providers as Record<string, Record<string, unknown>>));
}

export async function readProviders(): Promise<ProvidersView> {
	const path = modelsFile();
	const text = await readText();
	const providers = [...parsedProviders(text).entries()].map(([id, value]) => ({ id, ...value }) as ProviderConfig);
	return { path, exists: text !== undefined, providers };
}

interface Located {
	/** Index of the top-level `providers:` line, or -1 when the file has none. */
	providersLine: number;
	/** First and past-the-last line of the provider's block; `start` is -1 when absent. */
	start: number;
	end: number;
	/** Where a brand-new provider goes: the end of the `providers:` mapping. */
	insertAt: number;
}

/** Locate one provider's block by indentation: providers sit at two spaces. */
function locate(lines: string[], id: string): Located {
	let providersLine = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^providers:\s*$/.test(lines[i])) {
			providersLine = i;
			break;
		}
	}
	const located: Located = { providersLine, start: -1, end: lines.length, insertAt: lines.length };
	if (providersLine < 0) return located;
	// End of the mapping (before trailing blanks): the first top-level line after it.
	let insertAt = lines.length;
	for (let i = providersLine + 1; i < lines.length; i++) {
		if (/^\S/.test(lines[i]) && lines[i].trim() !== "") {
			insertAt = i;
			break;
		}
	}
	while (insertAt > providersLine + 1 && lines[insertAt - 1].trim() === "") insertAt--;
	located.insertAt = insertAt;
	for (let i = providersLine + 1; i < insertAt; i++) {
		const line = lines[i];
		const key = /^ {2}(\S.*?):\s*$/.exec(line);
		if (located.start < 0) {
			if (key && key[1] === id) located.start = i;
			continue;
		}
		if (key) {
			located.end = i;
			break;
		}
	}
	return located;
}

const PROVIDER_ORDER = ["baseUrl", "api", "apiKey", "authHeader", "headers", "models"];
const MODEL_ORDER = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "compat"];

function ordered(source: Record<string, unknown>, order: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of order) if (source[key] !== undefined) out[key] = source[key];
	for (const [key, value] of Object.entries(source)) if (!(key in out) && value !== undefined) out[key] = value;
	return out;
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value === undefined || value === null || value === "") delete target[key];
	else target[key] = value;
}

/** Keep whatever the file already had (compat, input, headers…) and apply the form's fields. */
function mergeProvider(existing: Record<string, unknown>, patch: ProviderConfig): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...existing };
	setOrDelete(merged, "baseUrl", patch.baseUrl?.trim());
	setOrDelete(merged, "api", patch.api?.trim());
	setOrDelete(merged, "apiKey", patch.apiKey?.trim());
	if (patch.authHeader === undefined) delete merged.authHeader;
	else merged.authHeader = patch.authHeader;

	const before = Array.isArray(existing.models) ? (existing.models as Record<string, unknown>[]) : [];
	const models = (patch.models ?? []).map(model => {
		const next: Record<string, unknown> = { ...(before.find(b => String(b.id) === model.id) ?? {}) };
		next.id = model.id;
		for (const key of ["name", "reasoning", "contextWindow", "maxTokens"]) setOrDelete(next, key, (model as Record<string, unknown>)[key]);
		return ordered(next, MODEL_ORDER);
	});
	if (models.length > 0) merged.models = models;
	else delete merged.models;
	return ordered(merged, PROVIDER_ORDER);
}

/** The provider's YAML block, indented to sit under `providers:`. */
function emitBlock(id: string, provider: Record<string, unknown>): string[] {
	const key = /^[A-Za-z0-9_.-]+$/.test(id) ? id : JSON.stringify(id);
	return Bun.YAML.stringify({ [key]: provider }, null, 2)
		.replace(/\n+$/, "")
		.split("\n")
		.map(line => `  ${line}`.replace(/[ \t]+$/, ""));
}

async function backup(file: string): Promise<void> {
	try {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		await Bun.write(`${file}.bak-${stamp}`, Bun.file(file));
	} catch {
		// nothing to back up yet (first write)
	}
}

/** Create or replace one provider, leaving the rest of the file untouched. */
export async function writeProvider(id: string, patch: ProviderConfig): Promise<ProvidersView> {
	const providerId = assertProviderId(id);
	const file = modelsFile();
	const text = (await readText()) ?? "";
	const existing = parsedProviders(text).get(providerId) ?? {};
	const block = emitBlock(providerId, mergeProvider(existing, patch));

	const lines = text ? text.split("\n") : [];
	const located = locate(lines, providerId);
	if (located.start >= 0) {
		lines.splice(located.start, located.end - located.start, ...block);
	} else if (located.providersLine >= 0) {
		// Append inside the existing mapping, so the file keeps its own order.
		lines.splice(located.insertAt, 0, ...block);
	} else {
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
		if (lines.length > 0) lines.push("");
		lines.push("providers:", ...block);
	}
	await backup(file);
	await Bun.write(file, `${lines.join("\n").replace(/\n+$/, "")}\n`);
	return readProviders();
}

export async function removeProvider(id: string): Promise<ProvidersView> {
	const providerId = assertProviderId(id);
	const file = modelsFile();
	const text = await readText();
	if (text !== undefined) {
		const lines = text.split("\n");
		const located = locate(lines, providerId);
		if (located.start >= 0) {
			lines.splice(located.start, located.end - located.start);
			await backup(file);
			while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
			await Bun.write(file, `${lines.join("\n")}\n`);
		}
	}
	return readProviders();
}
