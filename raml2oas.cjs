const wap = require('webapi-parser').WebApiParser
const fs = require("fs")

async function main() {
    const raml = fs.readFileSync(`${__dirname}/${process.argv[2]}`, "utf-8")
    const model = await wap.raml10.parse(raml)

    await wap.oas20.generateFile(model, `file://${__dirname}/ros-oas20.json`)
    const oas20 = fs.readFileSync(`${__dirname}/ros-oas20.json`, "utf-8")
    const oas20model = await wap.oas20.parse(oas20)
    const oas20validate = await wap.oas20.validate(oas20model)
    console.log('OAS 2.0 validation errors:', oas20validate.toString())

    await wap.oas30.generateFile(model, `file://${__dirname}/ros-oas30.json`)
    const oas30 = fs.readFileSync(`${__dirname}/ros-oas30.json`, "utf-8")
    const oas30model = await wap.oas30.parse(oas30)
    const oas30validate = await wap.oas30.validate(oas30model)
    console.log('OAS 3.0 validation errors:', oas30validate.toString())
}


main()