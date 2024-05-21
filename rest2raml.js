const fs = require("fs")
const YAML = require("js-yaml")

const rosSchemaFilename = "./ros-inspect"
const ramlSchemaFilename = "./ros-rest"

import { parseArgs } from "util";
const argPath = process.argv.slice(2)

async function main() {
  // STEP ZERO: calling the script "manually"...
  //    a. install bun (on MacOS, "brew install oven-sh/bun/bun")
  //    b. save script this to a new directory, like ~/rest2raml/...
  //    c. install YAML parse, "bun install js-yaml"
  //    d. Router's IP and authentication are provided by env variables that are provide in shell:
  //       >  URLBASE=https://change.me/rest BASICAUTH=admin:changeme bun rest2raml.js
  //    e. Wait a while as for this code to run – may take an HOUR for entire schema to process
  //    f. Optionally, rest2raml.js takes args with path to start out, seperated by *spaces*:
  //       >  bun rest2raml.js ip address
  //  So, assuming, done getting version for router should work...
  const ver = await fetchVersion()
  const {opts, argPath} = parseArguments()
  if (opts && opts.version) {
    console.log(ver)
    return 0
  }
  console.log(`Using version ${ver}...`)

  // STEP ONE: use REST to traverse router's /console/inspect output (save to )
  let rosSchema = {}
  if (process.env.INSPECTFILE) {
    rosSchema = JSON.parse(fs.readFileSync(process.env.INSPECTFILE, { encoding: "utf-8" }))
  } else {
    rosSchema = await parseChildren(argPath)
    const rosSchemaPath = `${rosSchemaFilename}-${argPath.join("+") || "all"
      }.json`
    fs.writeFileSync(rosSchemaPath, JSON.stringify(rosSchema))
    console.log(`Fetching /console/inspect data written to: ${rosSchemaPath}`)
  }

  // STEP TWO: process capture data into RAML for endpoints
  const ramlSchema = parse(arrayToNestedObject(argPath, rosSchema))

  // STEP THREE: add RAML boilerplate and output to
  const ramlPath = `${ramlSchemaFilename}-${argPath.join("+") || "all"}.raml`
  fs.writeFileSync(
    ramlPath,
    "#%RAML 1.0\n" +
    YAML.dump({
      ...generateRAMLPrefix(ver, argPath.join("+") || "all"),
      ...ramlSchema,
    })
  )

  console.log(`Done, exported ${ramlPath}`)
}

function parseArguments() {
  const { values, positionals } = parseArgs({
    args: Bun.argv,
    options: {
      "version": {
        type: "boolean",
        short: "v"
      },
    },
    strict: true,
    allowPositionals: true,
  })
  const [, , ...argPath] = positionals
  const opts = values
  return { opts, argPath }
}

function generateRAMLPrefix(ver = "7.0", tag = "dev") {
  const verString = `v${ver}.${Math.round(Date.now() / 1000 / 60)}-${tag}`
  return {
    title: `RouterOS REST Schema (${verString})`,
    version: verString,
    protocols: ["HTTPS", "HTTP"],
    mediaType: ["application/json"],
    securitySchemes: {
      basic: {
        description:
          "Mikrotik REST API only supports Basic Authentication, secured by HTTPS\n",
        type: "Basic Authentication",
      },
    },
    securedBy: ["basic"],
    baseUri: "https://{host}:{port}/rest",
    baseUriParameters: {
      host: {
        description: "RouterOS device IP or host name",
        default: "192.168.88.1",
      },
      port: {
        description: "RouterOS https port to use",
        default: "443",
      },
    },
    documentation: [
      {
        title: "RouterOS RAML Schema for REST API",
        content:
          "Schema is generated using `/console/inspect` from a RouterOS device, and\ninterpreted into a schema based on the rules in\n[Mikrotik REST documentation](https://help.mikrotik.com)\n",
      },
    ],
  }
}

function arrayToNestedObject(arr, lastValue = {}, initialValue = {}) {
  let current = initialValue

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i]
    if (i === arr.length - 1) {
      current[item] = lastValue
    } else {
      current[item] = {}
      current = current[item]
    }
  }
  if (arr.length == 0) {
    return lastValue
  }

  return initialValue
}

async function fetchPost(url, body) {
  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(process.env.BASICAUTH)}`,
    },
  })
  return await response.json()
}

async function fetchVersion() {
  const resturl = `${process.env.URLBASE}/system/resource/get`
  const body = {
    "value-name": "version",
  }
  let resp = await fetchPost(resturl, body)
  return resp.ret.split(" ")[0]
}

async function fetchInspect(what, path, input = "") {
  const resturl = `${process.env.URLBASE}/console/inspect`
  const body = {
    request: what,
    path: path,
  }
  console.log(`Inspecting... ${path} (${what})`)
  return await fetchPost(resturl, body)
}

async function fetchSyntax(path = []) {
  return await fetchInspect("syntax", path.toString())
}

async function fetchChild(path = []) {
  return await fetchInspect("child", path.toString())
}

async function parseChildren(rpath = [], memo = {}) {
  let start = memo
  let children = await fetchChild(rpath)
  for (const child of children) {
    if (child.type == "child") {
      const newpath = [...rpath, child.name]
      memo[child.name] = { type: child["node-type"] }
      // try {
      if (child["node-type"] == "arg") {
        if (
          newpath.includes("where") ||
          newpath.includes("do") ||
          newpath.includes("else") ||
          newpath.includes("rule") ||
          newpath.includes("command") ||
          newpath.includes("on-error")
        ) {
          // these crash the REST server, skipping
        } else {
          const syntax = await fetchSyntax(newpath)
          if (syntax.length == 1 && syntax[0].text.length > 0) {
            memo[child.name].desc = syntax[0].text
          }
        }
      }
      //catch (e) {
      //console.error("error", e)
      //}
      await parseChildren(Array.from(newpath), memo[child.name])
    }
  }
  return start
}

function ramlRestResponses(successJsonType = "any") {
  return {
    200: {
      description: "Success",
      body: { "application/json": { type: successJsonType } },
    },
    400: {
      description: "Bad command or error",
      body: { "application/json": { type: "object" } },
    },
    401: {
      description: "Unauthorized",
      body: { "application/json": { type: "object" } },
    },
  }
}

function cmdToGetQueryParams(obj) {
  var props = {}
  Object.entries(obj)
    .filter((i) => i[1].type == "arg")
    .map((j) => {
      props[j[0]] = {
        type: "any",
        required: false,
        description: j[1].description,
      }
    })
  return props
}

function cmdToPostSchema(obj) {
  let op = {}
  op.description = obj.desc
  op.body = {}
  op.body["application/json"] = { type: "object" }
  let props = (op.body["application/json"].properties = {})
  Object.entries(obj)
    .filter((i) => i[1].type == "arg")
    .map((j) => {
      props[j[0]] = {
        type: "any",
        required: false,
        description: j[1].description,
      }
      //delete obj[j[0]]
      //delete obj.type
    })
  op.responses = ramlRestResponses()
  return op
}

function parse(obj) {
  function parser(currentObj) {
    for (const key in currentObj) {
      const prev = currentObj[key]
      if (currentObj[key].type == "cmd") {
        if (typeof currentObj[`/${key}`] !== "object")
          currentObj[`/${key}`] = {}
        /* TODO: uriParameters, i believe, should be top level... it may just assume string, dunno. 
        uriParameters: {
          id: { type: "string" },
        }, */

        currentObj[`/${key}`].post = cmdToPostSchema(prev)
        currentObj[`/${key}`].post.body["application/json"].properties[".proplist"] =
        {
          type: "any",
          required: false,
        }
        currentObj[`/${key}`].post.body["application/json"].properties[".query"] = {
          type: "array",
          required: false,
        }
        if (key == "get") {
          const getqueryparams = cmdToGetQueryParams(currentObj["get"])
          currentObj["get"] = {
            queryParameters: getqueryparams,
            responses: ramlRestResponses("array")
          }
          if (typeof currentObj["/{id}"] !== "object") currentObj["/{id}"] = {}
          currentObj["/{id}"].get = {
            responses: ramlRestResponses(),
          }
        }
        if (key == "set") {
          if (typeof currentObj["/{id}"] !== "object") currentObj["/{id}"] = {}
          currentObj["/{id}"].patch = {
            ...cmdToPostSchema(currentObj[key])
          }
        }
        if (key == "add") {
          currentObj.put = cmdToPostSchema(currentObj[key])
        }
        if (key == "remove") {
          if (typeof currentObj["/{id}"] !== "object") currentObj["/{id}"] = {}
          currentObj["/{id}"].delete = {
            ...cmdToPostSchema(currentObj[key])
          }
        }
        if (key != "get") delete currentObj[key]
      } else if (typeof currentObj[key] === "object") {
        const src = currentObj[key]
        currentObj[`/${key}`] = currentObj[key]
        if (
          currentObj[`/${key}`].type == "path" ||
          currentObj[`/${key}`].type == "dir"
        ) {
          delete currentObj[`/${key}`].type
        }
        parser(currentObj[`/${key}`])
        delete currentObj[key]
      }
    }
    return currentObj
  }

  return parser(obj)
}

await main()

// To build with bun...
//   bun build ros2raml.js --compile --outfile ros2raml

// To general HTML from RAML...
//   bun install raml2html raml2html-slate-theme
//   raml2html --theme raml2html-slate-theme ros-rest-all.raml > ros-rest.all.html
