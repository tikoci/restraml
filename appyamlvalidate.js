// appyamlvalidate.js
// Validates RouterOS /app YAML schemas and built-in /app YAMLs.
// Generates per-version schema files under docs/<version>/.
//
// Usage:
//   bun appyamlvalidate.js <version>
//   URLBASE=http://localhost:9180/rest BASICAUTH=admin: bun appyamlvalidate.js 7.22
//   bun appyamlvalidate.js <version> --no-schema-write --app-json docs/nightly/extra/app.json
//
// Offline nightly example (no live CHR, no per-version schemas):
//   bun appyamlvalidate.js nightly --no-schema-write --app-json docs/nightly/extra/app.json
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
const path = require("path")
const YAML = require("js-yaml")
const Ajv = require("ajv")
const addFormats = require("ajv-formats")

const SINGLE_SCHEMA_PATH = process.env.APP_YAML_SCHEMA || "docs/routeros-app-yaml-schema.latest.json"
const STORE_SCHEMA_PATH = "docs/routeros-app-yaml-store-schema.latest.json"
const FAILURES_FILE = process.env.APP_YAML_FAILURES_FILE || "app-yaml-failures.txt"
const VERSION_SEGMENT_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/

function assertSafeVersion(version) {
  if (!VERSION_SEGMENT_RE.test(version)) {
    throw new Error(
      `Invalid version '${version}'. Only letters, numbers, dot, underscore, and dash are allowed.`
    )
  }
  return version
}

function resolveDocsPath(version, fileName) {
  const docsRoot = path.resolve("docs")
  const versionRoot = path.resolve(docsRoot, version)
  const targetPath = fileName ? path.resolve(versionRoot, fileName) : versionRoot
  const docsPrefix = `${docsRoot}${path.sep}`

  if (targetPath !== docsRoot && !targetPath.startsWith(docsPrefix)) {
    throw new Error(`Refusing to write outside docs/: ${targetPath}`)
  }

  return targetPath
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeTextFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function sanitizeFailureField(value) {
  const withoutControls = Array.from(String(value), (char) => {
    const code = char.charCodeAt(0)
    return code < 32 || code === 127 ? " " : char
  }).join("")
  return withoutControls.replace(/\s+/g, " ").trim()
}

function assertAppList(value) {
  if (!Array.isArray(value)) {
    throw new Error("Expected GET /rest/app to return an array")
  }

  for (const [index, app] of value.entries()) {
    if (!app || typeof app !== "object" || Array.isArray(app)) {
      throw new Error(`Expected app entry ${index} to be an object`)
    }
  }

  return value
}

function printUsageAndExit(code = 0) {
  console.log(
    [
      "Usage: bun appyamlvalidate.js <version> [options]",
      "",
      "  <version>                    RouterOS version (e.g. 7.22, 7.24rc4, nightly)",
      "",
      "Options:",
      "  --no-schema-write            Skip writing per-version schemas to docs/<version>/",
      "                               (validates base schemas in place; use for nightly)",
      "  --app-json <path>            Validate apps from a JSON file instead of GET /rest/app",
      "                               (offline mode; e.g. docs/nightly/extra/app.json)",
      "  --help                       Show this help",
      "",
      "Examples:",
      "  bun appyamlvalidate.js 7.22",
      "  URLBASE=http://localhost:9180/rest BASICAUTH=admin: bun appyamlvalidate.js 7.22",
      "  bun appyamlvalidate.js nightly --no-schema-write --app-json docs/nightly/extra/app.json",
    ].join("\n")
  )
  process.exit(code)
}

async function main() {
  const rawArgs = Bun.argv.slice(2)

  // --- Flag parsing (positional <version> + --no-schema-write + --app-json) ---
  let versionArg = null
  let noSchemaWrite = false
  let appJsonPath = null
  let help = false

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a === "--help" || a === "-h") {
      help = true
    } else if (a === "--no-schema-write") {
      noSchemaWrite = true
    } else if (a === "--app-json") {
      const next = rawArgs[i + 1]
      if (!next || next.startsWith("-")) {
        console.error("Error: --app-json requires a file path")
        process.exit(1)
      }
      appJsonPath = next
      i++
    } else if (a.startsWith("--app-json=")) {
      appJsonPath = a.slice("--app-json=".length)
      if (!appJsonPath) {
        console.error("Error: --app-json requires a file path")
        process.exit(1)
      }
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`)
      console.error("Usage: bun appyamlvalidate.js <version> [--no-schema-write] [--app-json <path>]")
      process.exit(1)
    } else if (versionArg === null) {
      versionArg = a
    } else {
      console.error(`Unexpected argument: ${a}`)
      console.error("Usage: bun appyamlvalidate.js <version> [--no-schema-write] [--app-json <path>]")
      process.exit(1)
    }
  }

  if (help) printUsageAndExit(0)

  if (!versionArg) {
    console.error("Usage: bun appyamlvalidate.js <version> [--no-schema-write] [--app-json <path>]")
    process.exit(1)
  }

  const version = assertSafeVersion(versionArg)

  // Allow --app-json to point anywhere; validate that the path stays readable.
  // No path-traversal guard needed beyond existence check — it is a read, not a write.

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

  // --- Write per-version schemas to docs/<version>/ (unless --no-schema-write) ---
  if (!noSchemaWrite) {
    const docsPath = resolveDocsPath(version)
    fs.mkdirSync(docsPath, { recursive: true })
    const singleOutputPath = resolveDocsPath(version, "routeros-app-yaml-schema.json")
    const storeOutputPath = resolveDocsPath(version, "routeros-app-yaml-store-schema.json")
    writeJsonFile(singleOutputPath, versionedSingleSchema)
    writeJsonFile(storeOutputPath, versionedStoreSchema)
    console.log(`Written: ${singleOutputPath}`)
    console.log(`Written: ${storeOutputPath}`)
  } else {
    console.log("Skipping per-version schema write (--no-schema-write)")
  }

  // --- Part 1: Validate schemas against JSON Schema meta-schema ---
  console.log("\n=== Part 1: JSON Schema meta-validation ===")

  // strict:false allows patterns that are valid JSON Schema but may look unusual to AJV
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)

  let schemaErrors = false

  // When --no-schema-write, validate the base schemas directly (no versioned $id needed).
  // Otherwise validate the versioned schemas as before.
  const singleToValidate = noSchemaWrite ? singleSchema : versionedSingleSchema
  const storeToValidate = noSchemaWrite ? storeSchemaBase : versionedStoreSchema

  const singleValid = ajv.validateSchema(singleToValidate)
  if (!singleValid) {
    console.error(
      "✗ routeros-app-yaml-schema.json is NOT valid JSON Schema:"
    )
    console.error(JSON.stringify(ajv.errors, null, 2))
    schemaErrors = true
  } else {
    console.log("✓ routeros-app-yaml-schema.json is valid JSON Schema")
  }

  // Add the single schema so the store schema's $ref can resolve.
  // Use the matching variant (base vs versioned) consistently.
  ajv.addSchema(noSchemaWrite ? singleSchema : versionedSingleSchema)
  const storeValid = ajv.validateSchema(storeToValidate)
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
  // Offline file takes precedence over live fetch; both paths share the same validator.
  const urlbase = process.env.URLBASE
  const basicauth = process.env.BASICAUTH

  // Choose validator schema consistently with Part 1 (base vs versioned)
  const validateSchema = noSchemaWrite ? singleSchema : versionedSingleSchema

  if (appJsonPath) {
    console.log(`\n=== Part 2: Validating /app YAMLs from file: ${appJsonPath} ===`)
    let apps
    try {
      const raw = fs.readFileSync(appJsonPath, "utf8")
      apps = assertAppList(JSON.parse(raw))
      console.log(`Loaded ${apps.length} /app entries from ${appJsonPath}`)
    } catch (err) {
      console.error(`Failed to read --app-json file '${appJsonPath}': ${err.message}`)
      process.exit(1)
    }

    const validate = ajv.compile(validateSchema)
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
        `\n${failures.length} /app YAML(s) failed schema validation (from ${appJsonPath}):`
      )
      for (const f of failures) {
        console.error(`  - ${f.name}: ${f.summary}`)
      }
      const failureLines = failures
        .map(
          (f) =>
            `- \`${sanitizeFailureField(f.name)}\`: ${sanitizeFailureField(f.summary)}`
        )
        .join("\n")
      const failureFilePath = path.resolve(FAILURES_FILE)
      writeTextFile(failureFilePath, `${failureLines}\n`)
      console.error(`Failure details written to ${failureFilePath}`)
      process.exit(2)
    }

    console.log(
      `\n✓ All ${apps.length} /app YAMLs from ${appJsonPath} validated successfully`
    )
    process.exit(0)
  }

  if (!urlbase) {
    console.log(
      "\n=== Part 2: Skipped (URLBASE not set and --app-json not provided — no live router available) ==="
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
    apps = assertAppList(await resp.json())
    console.log(`Fetched ${apps.length} built-in /app entries from router`)

    // Save raw /app JSON to docs/<version>/app.json for reference and debugging
    // (skip when --no-schema-write? No — offline nightly already has the file;
    // live path still writes as before unless suppressed.)
    if (!noSchemaWrite) {
      const appJsonPathLive = resolveDocsPath(version, "app.json")
      writeJsonFile(appJsonPathLive, apps)
      console.log(`Written: ${appJsonPathLive}`)
    } else {
      console.log(`Skipping app.json write (--no-schema-write) — ${apps.length} entries fetched`)
    }
  } catch (err) {
    console.error(`::warning::Failed to fetch /app list: ${err.message}`)
    console.log("Skipping live /app YAML validation due to fetch error")
    process.exit(0)
  }

  const validate = ajv.compile(validateSchema)
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
      .map(
        (f) =>
          `- \`${sanitizeFailureField(f.name)}\`: ${sanitizeFailureField(f.summary)}`
      )
      .join("\n")
    const failureFilePath = path.resolve(FAILURES_FILE)
    writeTextFile(failureFilePath, `${failureLines}\n`)
    console.error(`Failure details written to ${failureFilePath}`)
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
