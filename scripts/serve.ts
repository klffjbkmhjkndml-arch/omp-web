/**
 * Start the gateway. `--test` uses the isolated profile in .data/omp-agent
 * (seeded by setup-test-profile.ts), locks sessions to its example model, and
 * listens on port 30191.
 */
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
if (process.argv.includes("--test")) {
	process.env.OMP_WEB_AGENT_DIR ??= path.join(root, ".data", "omp-agent");
	process.env.OMP_WEB_MODEL_LOCK ??= "example/example-small";
	process.env.OMP_WEB_DATA_DIR ??= path.join(root, ".data", "web-test");
	process.env.OMP_WEB_PORT ??= "30191";
	await import("./setup-test-profile.ts");
}
await import("../server/main.ts");
