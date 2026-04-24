// GitHub Actions workflow linter using actionlint (WASM).
// Runs under Bun. Usage: bun validate-workflows.mjs
import { createLinter } from "actionlint";
import { load } from "js-yaml";

const workflowsDir = ".github/workflows";
const glob = new Bun.Glob("*.{yaml,yml}");
const files = (await Array.fromAsync(glob.scan(workflowsDir))).map(
	(f) => `${workflowsDir}/${f}`,
);
const actionlintConfigPath = ".github/actionlint.yaml";

const lint = await createLinter();
let hasErrors = false;
const allowedRunnerLabels = new Set();

if (await Bun.file(actionlintConfigPath).exists()) {
	const config = load(await Bun.file(actionlintConfigPath).text()) ?? {};
	for (const label of config["self-hosted-runner"]?.labels ?? []) {
		if (typeof label === "string" && label.length > 0) {
			allowedRunnerLabels.add(label);
		}
	}
}

function shouldSuppressRunnerLabelError(err) {
	if (err.kind !== "runner-label") {
		return false;
	}

	for (const label of allowedRunnerLabels) {
		if (err.message.includes(`label "${label}" is unknown`)) {
			return true;
		}
	}

	return false;
}

for (const file of files.sort()) {
	const content = await Bun.file(file).text();
	const errors = lint(content, file).filter((err) => !shouldSuppressRunnerLabelError(err));
	for (const err of errors) {
		console.error(`${err.file}:${err.line}:${err.column} [${err.kind}] ${err.message}`);
		hasErrors = true;
	}
}

if (hasErrors) {
	process.exit(1);
}
console.log(`✓ All ${files.length} workflow files passed actionlint`);
