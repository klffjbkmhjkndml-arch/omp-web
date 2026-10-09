/**
 * Idempotently prepare the isolated test profile `.data/omp-agent`: an example
 * `models.yml` (key given as an env-var name — replace both with your own
 * provider), the QA dialog extension, and the sandbox project directory.
 * Already-existing files are left untouched.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const agentDir = path.join(root, ".data", "omp-agent");
const extensionsDir = path.join(agentDir, "extensions");
const sandboxDir = path.join(root, ".data", "sandbox");

const modelsYml = `providers:
  example:
    baseUrl: https://api.example.com/v1
    api: openai-completions
    apiKey: EXAMPLE_API_KEY
    models:
      - id: example-small
        name: Example Small
        reasoning: true
        input: [text]
        contextWindow: 128000
        maxTokens: 16384
`;

export function setupTestProfile(): void {
	fs.mkdirSync(extensionsDir, { recursive: true });
	fs.mkdirSync(sandboxDir, { recursive: true });
	const modelsPath = path.join(agentDir, "models.yml");
	// Seed only when missing: the profile is editable from the web UI and by hand,
	// and rewriting it on every start would throw those providers away.
	if (!fs.existsSync(modelsPath) || !fs.readFileSync(modelsPath, "utf8").trim()) {
		fs.writeFileSync(modelsPath, modelsYml);
	}
	const src = path.join(root, "tests", "fixtures", "web-qa-extension.js");
	const dst = path.join(extensionsDir, "web-qa-extension.js");
	fs.copyFileSync(src, dst);
}

setupTestProfile();
