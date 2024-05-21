# restraml
RouterOS REST API "Schema Tools"

## Generating the RAML file

1. Install [Bun](https://bun.sh/)
2. Clone this repository
3. Install `js-yaml`:  
  `bun install js-yaml`
4. Run `rest2raml.js` like so:
   ```sh
   URLBASE=https://<IP or DNS name>/rest BASICAUTH=<user>:<pass> bun rest2raml.js
   # Example:
   URLBASE=https://192.168.88.1/rest BASICAUTH=admin:h3llow0rld bun rest2raml.js
   ```
    Wait a while as for this code to run. It could take as long as an hour to process the entire schema.
5. Open a pull request to add the RAML file to this repository if it's missing 😉

## Generating the HTML page

1. Follow steps 1-2 above, or 1-4 if this repository doesn't currently contain a RAML file for your RouterOS version.
2. Install `raml2html` and `raml2html-slate-theme`:  
  `bun install raml2html raml2html-slate-theme`
3. Generate the HTML page with `raml2html`:
  ```sh
  raml2html --theme raml2html-slate-theme <RAML file> > <HTML file>
  # Example:
  raml2html --theme raml2html-slate-theme ros-rest-all.raml > ros-rest.all.html
  ```
