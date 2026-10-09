import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");

function parseModelLock(value: string | undefined): { provider: string; model: string } | undefined {
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0) return undefined;
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** Explicit OMP profile directory; unset means omp's default `~/.omp/agent`. */
const agentDir = process.env.OMP_WEB_AGENT_DIR ? path.resolve(process.env.OMP_WEB_AGENT_DIR) : undefined;

export const config = {
	root,
	port: Number(process.env.OMP_WEB_PORT ?? 30190),
	host: "127.0.0.1",
	ompBin: process.env.OMP_WEB_OMP_BIN ?? "omp",
	agentDir,
	sessionsRoot: path.join(agentDir ?? path.join(os.homedir(), ".omp", "agent"), "sessions"),
	/** `provider/model` — forces every spawned session onto one model (test profile). */
	modelLock: parseModelLock(process.env.OMP_WEB_MODEL_LOCK),
	dataDir: path.resolve(process.env.OMP_WEB_DATA_DIR ?? path.join(root, ".data", "web")),
	distDir: path.join(root, "dist"),
	/** Idle sessions with no attached browser are stopped after this long. */
	idleStopMs: Number(process.env.OMP_WEB_IDLE_STOP_MS ?? 10 * 60_000),
	/** One-shot model call after the first exchange writes a better session title. */
	autoTitle: process.env.OMP_WEB_AUTO_TITLE !== "0",
};
