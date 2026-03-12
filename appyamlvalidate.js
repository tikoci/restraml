// appyamlvalidate.js
// Validates RouterOS /app YAML schemas and built-in /app YAMLs.
// Generates per-version schema files under docs/<version>/.
//
// Usage:
//   bun appyamlvalidate.js <version>
//   URLBASE=http://localhost:9180/rest BASICAUTH=admin: bun appyamlvalidate.js 7.22
//
// Environment variables:
//   URLBASE     - RouterOS REST API base URL (enables live /app validation)
//   BASICAUTH   - RouterOS credentials in "user:pass" format
//
// Exit codes:
//   0 - All validations passed (or live validation skipped)
//   1 - JSON Schema meta-validation failed
//   2 - One or more built-in /app YAML entries failed schema validation

const fs = require("fs")
const YAML = require("js-yaml")
const Ajv = require("ajv")
const addFormats = require("ajv-formats")

const SINGLE_SCHEMA_PATH = process.env.APP_YAML_SCHEMA || "docs/routeros-app-yaml-schema.latest.json"
const STORE_SCHEMA_PATH = "docs/routeros-app-yaml-store-schema.latest.json"
const FAILURES_FILE = "/tmp/app-yaml-failures.txt"

async function main() {
  const args = Bun.argv.slice(2)
  const version = args[0]

  if (!version) {
    console.error("Usage: bun appyamlvalidate.js <version>")
    process.exit(1)
  }

  // --- Load base schemas ---
  const singleSchema = JSON.parse(fs.readFileSync(SINGLE_SCHEMA_PATH, "utf8"))
  const storeSchemaBase = JSON.parse(
    fs.readFileSync(STORE_SCHEMA_PATH, "utf8")
  )

  // --- Create per-version schemas with version-specific $id and $ref ---
  const versionedSingleSchema = {
    ...singleSchema,
    $id: `https://tikoci.github.io/restraml/${version}/routeros-app-yaml-schema.json`,
  }
  const versionedStoreSchema = {
    ...storeSchemaBase,
    $id: `https://tikoci.github.io/restraml/${version}/routeros-app-yaml-store-schema.json`,
    // Point items.$ref at the per-version single schema
    items: {
      $ref: `https://tikoci.github.io/restraml/${version}/routeros-app-yaml-schema.json`,
    },
  }

  // --- Write per-version schemas to docs/<version>/ ---
  const docsPath = `docs/${version}`
  fs.mkdirSync(docsPath, { recursive: true })
  const singleOutputPath = `${docsPath}/routeros-app-yaml-schema.json`
  const storeOutputPath = `${docsPath}/routeros-app-yaml-store-schema.json`
  fs.writeFileSync(
    singleOutputPath,
    JSON.stringify(versionedSingleSchema, null, 2)
  )
  fs.writeFileSync(
    storeOutputPath,
    JSON.stringify(versionedStoreSchema, null, 2)
  )
  console.log(`Written: ${singleOutputPath}`)
  console.log(`Written: ${storeOutputPath}`)

  // --- Part 1: Validate schemas against JSON Schema meta-schema ---
  console.log("\n=== Part 1: JSON Schema meta-validation ===")

  // strict:false allows patterns that are valid JSON Schema but may look unusual to AJV
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)

  let schemaErrors = false

  const singleValid = ajv.validateSchema(versionedSingleSchema)
  if (!singleValid) {
    console.error(
      "✗ routeros-app-yaml-schema.json is NOT valid JSON Schema:"
    )
    console.error(JSON.stringify(ajv.errors, null, 2))
    schemaErrors = true
  } else {
    console.log("✓ routeros-app-yaml-schema.json is valid JSON Schema")
  }

  // Add the single schema so the store schema's $ref can resolve
  ajv.addSchema(versionedSingleSchema)
  const storeValid = ajv.validateSchema(versionedStoreSchema)
  if (!storeValid) {
    console.error(
      "✗ routeros-app-yaml-store-schema.json is NOT valid JSON Schema:"
    )
    console.error(JSON.stringify(ajv.errors, null, 2))
    schemaErrors = true
  } else {
    console.log("✓ routeros-app-yaml-store-schema.json is valid JSON Schema")
  }

  if (schemaErrors) {
    process.exit(1)
  }

  // --- Part 2: Validate built-in RouterOS /app YAMLs against schema ---
  const urlbase = process.env.URLBASE
  const basicauth = process.env.BASICAUTH

  if (!urlbase) {
    console.log(
      "\n=== Part 2: Skipped (URLBASE not set — no live router available) ==="
    )
    process.exit(0)
  }

  console.log(
    `\n=== Part 2: Validating built-in RouterOS /app YAMLs against schema ===`
  )

  let apps
  try {
    const appUrl = `${urlbase}/app`
    const headers = {}
    if (basicauth) {
      headers["Authorization"] =
        "Basic " + Buffer.from(basicauth).toString("base64")
    }
    const resp = await fetch(appUrl, { headers })
    if (resp.status === 404 || resp.status === 400) {
      console.log(
        `::notice::/app endpoint returned ${resp.status} — this RouterOS version may not include /app (skipping live validation)`
      )
      process.exit(0)
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
    }
    apps = await resp.json()
    console.log(`Fetched ${apps.length} built-in /app entries from router`)
  } catch (err) {
    console.error(`::warning::Failed to fetch /app list: ${err.message}`)
    console.log("Skipping live /app YAML validation due to fetch error")
    process.exit(0)
  }

  const validate = ajv.compile(versionedSingleSchema)
  const failures = []

  for (const app of apps) {
    const appName = app.name || app[".id"] || "unknown"
    const yamlStr = app.yaml
    if (!yamlStr) {
      console.log(`  ⚠ ${appName}: no 'yaml' field found, skipping`)
      continue
    }

    let parsed
    try {
      parsed = YAML.load(yamlStr)
    } catch (err) {
      const msg = `YAML parse error: ${err.message}`
      console.error(`  ✗ ${appName}: ${msg}`)
      failures.push({ name: appName, summary: msg })
      continue
    }

    const valid = validate(parsed)
    if (!valid) {
      const errSummary = (validate.errors || [])
        .map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join("; ")
      console.error(`  ✗ ${appName}: ${errSummary}`)
      failures.push({ name: appName, summary: errSummary })
    } else {
      console.log(`  ✓ ${appName}`)
    }
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} built-in /app YAML(s) failed schema validation:`
    )
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.summary}`)
    }
    // Write failure details to a file for GitHub issue creation in the workflow
    const failureLines = failures
      .map((f) => `- \`${f.name}\`: ${f.summary}`)
      .join("\n")
    fs.writeFileSync(FAILURES_FILE, failureLines)
    process.exit(2)
  }

  console.log(
    `\n✓ All ${apps.length} built-in /app YAMLs validated successfully against the schema`
  )
  process.exit(0)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
