const wap = require('webapi-parser').WebApiParser
const fs = require("fs")

async function main () {
  const raml = fs.readFileSync(`${__dirname}/${process.argv[2]}`, "utf-8")  
  const model = await wap.raml10.parse(raml)
  const report = await wap.raml10.validate(model)
  console.log('Validation errors:', report.toString())
}

main()