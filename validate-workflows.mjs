// GitHub Actions workflow linter using actionlint (WASM).
// Runs under Bun. Usage: bun validate-workflows.mjs
import { createLinter } from "actionlint";

const workflowsDir = ".github/workflows";
const glob = new Bun.Glob("*.{yaml,yml}");
const files = (await Array.fromAsync(glob.scan(workflowsDir))).map(
	(f) => `${workflowsDir}/${f}`,
);

const lint = await createLinter();
let hasErrors = false;

for (const file of files.sort()) {
	const content = await Bun.file(file).text();
	const errors = lint(content, file);
	for (const err of errors) {
		console.error(`${err.file}:${err.line}:${err.column} [${err.kind}] ${err.message}`);
		hasErrors = true;
	}
}

if (hasErrors) {
	process.exit(1);
}
console.log(`✓ All ${files.length} workflow files passed actionlint`);
