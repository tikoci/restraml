const wap = require('webapi-parser').WebApiParser
const fs = require("fs")

async function main() {
    console.log("Parsing YAML RAML file: ", process.argv[2])
    const raml = fs.readFileSync(`${__dirname}/${process.argv[2]}`, "utf-8")
    const model = await wap.raml10.parse(raml)

    console.log("Generation OAS 2.0")
    await wap.oas20.generateFile(model, `file://${__dirname}/ros-oas20.json`)
    console.log("Validating OAS 2.0")
    const oas20model = await wap.oas20.parse(`file://${__dirname}/ros-oas20.json`)
    const oas20validate = await wap.oas20.validate(oas20model)
    console.log('OAS 2.0 validation', oas20validate.toString())

    // OAS 3.0 DOES NOT VALIDATE
    // while it does import to postman... there are 3K+ validation errors
    // comment out since OAS 2.0 should be fine
    /*
    console.log("Generation OAS 3.0")
    await wap.oas30.generateFile(model, `file://${__dirname}/ros-oas30.json`)
    console.log("Validating OAS 3.0")
    const oas30model = await wap.oas30.parse(`file://${__dirname}/ros-oas30.json`)
    const oas30validate = await wap.oas30.validate(oas30model)
    console.log('OAS 3.0 validation:', oas30validate.toString())
    */
}


main()