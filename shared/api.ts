/** Gateway ↔ browser contract. OMP's own wire types live in `./rpc-wire.ts` (generated, copied from omp 18.8.6). */
import type {
	AgentMessage,
	AvailableSlashCommand,
	ExtensionUiRequest,
	ImageContent,
	RpcServerFrame,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	SubagentSnapshot,
} from "./rpc-wire.ts";

export type {
	AgentMessage,
	AvailableSlashCommand,
	ExtensionUiRequest,
	ImageContent,
	RpcServerFrame,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	SubagentSnapshot,
};

/**
 * Bumped whenever the gateway gains endpoints the browser needs. `/api/health`
 * reports it, so a page built from newer sources can tell the user to restart a
 * server that is still running the old code instead of failing with a raw 404.
 */
export const API_VERSION = 1;

export interface ProjectInfo {
	path: string;
	name: string;
	pinned: boolean;
	/** Epoch ms of the newest session (or pin time). */
	lastActive: number;
	sessionCount: number;
}

export interface SessionSummary {
	path: string;
	id: string;
	cwd: string;
	title: string;
	created: number;
	/** File mtime: bumped by omp's own bookkeeping writes, so not a usage signal. */
	modified: number;
	/** Timestamp of the newest real message; what "recently used" means. */
	activeAt: number;
	parent?: string;
	/** Live process status, when this session has a running omp. */
	live?: "idle" | "running";
}

/** Trimmed `get_state` (systemPrompt/dumpTools removed by the gateway). */
export interface SessionState {
	model?: {
		provider: string;
		id: string;
		name?: string;
		reasoning?: boolean;
		contextWindow?: number;
		/** Accepted input modalities, e.g. `text`, `image`. */
		input?: string[];
		thinking?: { efforts?: string[] };
	};
	thinkingLevel?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	messageCount: number;
	queuedMessages?: { steering: string[]; followUp: string[] };
	todoPhases?: { name: string; tasks: { content: string; status: string }[] }[];
	contextUsage?: { tokens: number; contextWindow: number; percent: number };
	tokensPerSecond?: number | null;
	cwd: string;
	[key: string]: unknown;
}

export interface ModelOption {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	efforts?: string[];
}

export type ClientMsg =
	/** `model` (`provider/id`) starts the process on that model instead of the session's saved one. */
	| { t: "attach"; key: string; model?: string }
	| { t: "detach"; key: string }
	/** Arbitrary RPC command forwarded to the session's omp. */
	| { t: "rpc"; key: string; rid: string; cmd: Record<string, unknown> }
	/** `extension_ui_response` payload (without `type`). */
	| { t: "ui"; key: string; payload: Record<string, unknown> };

export type ServerMsg =
	| {
			t: "snapshot";
			key: string;
			state: SessionState;
			messages: AgentMessage[];
			/** Frames of the in-flight run that have not settled into `messages` yet; replay in order. */
			inflight: RpcServerFrame[];
			pendingUi: ExtensionUiRequest[];
			/** Slash commands omp last advertised for this session. */
			commands: AvailableSlashCommand[];
			/** Subagents this session spawned, still listed after they finish. */
			subagents: SubagentSnapshot[];
	  }
	| { t: "frame"; key: string; frame: RpcServerFrame }
	| { t: "state"; key: string; state: SessionState }
	| { t: "rpc_res"; rid: string; ok: boolean; data?: unknown; error?: string }
	/** `lostModel`: the session's saved model no longer exists; reopen with an explicit model. */
	| { t: "proc"; key: string; status: "starting" | "ready" | "exited"; error?: string; lostModel?: string }
	/** The session moved to another file (fork/new/switch); re-attach under `to`. */
	| { t: "rekey"; from: string; to: string }
	| { t: "index" };

export interface DirListing {
	path: string;
	parent: string | null;
	dirs: string[];
}

/** One directory level of the file panel. */
export interface FsTree {
	path: string;
	entries: { name: string; dir: boolean }[];
}

/** Preview of one file: text (maybe clipped), an image marker, or a binary marker. */
export interface FileView {
	/** Relative to the project, forward slashes. */
	path: string;
	text?: string;
	truncated?: boolean;
	binary?: boolean;
	image?: boolean;
	size: number;
}

export interface GitStatus {
	/** Set when `cwd` is not inside a git work tree. */
	notRepo?: boolean;
	/** Absolute work-tree root; `files[].path` is relative to it, like `git status`. */
	root?: string;
	files?: { path: string; x: string; y: string }[];
}

export interface GitDiff {
	diff: string;
	/** The file is not tracked yet, so the whole body is rendered as additions. */
	untracked?: boolean;
	truncated?: boolean;
}

/** One model row of a custom provider in `models.yml`. */
export interface ProviderModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	[key: string]: unknown;
}

/**
 * A provider as written in `models.yml`. Only the fields the settings form owns
 * are typed; everything else the file carries is preserved untouched.
 */
export interface ProviderConfig {
	id: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	/** `undefined` leaves the field out, so omp's own default applies. */
	authHeader?: boolean;
	models?: ProviderModel[];
	[key: string]: unknown;
}

export interface ProvidersView {
	/** Absolute path of the `models.yml` the edits apply to. */
	path: string;
	exists: boolean;
	providers: ProviderConfig[];
}
