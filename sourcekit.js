import { CreateLSP } from "./lsp_mcp.js";
import { glob } from "glob";

const NAME = "sourcekit";
const VERSION = "0.1";

const BINARY = "sourcekit-lsp";
const ARGS = [
];

async function main() {
  const {client: sourcekit, server, transport} = CreateLSP(NAME, VERSION);
  
  sourcekit.post_initialization_callback = async function(_init_response) {
    console.log(_init_response);
    const files = await glob(this.workdir + '/**/*.swift');
    if (files.length == 0) {
      throw "No swift files found"
    }
    
    let search_index = 0;
    let file = files[search_index];
    while (file != undefined && file.endsWith("Package.swift")) {
      file = files[++search_index];
    }

    if (file == undefined) {
      throw "Couldn't find suitable .swift file"
    }
    console.log("file to open", file);
    file = `${this.workdir}/Sources/Fuzzilli/FuzzIL/TypeSystem.swift`;
    console.log("other", file);
    if (!file.startsWith(this.workdir)) {
      throw `Invalid file: ${file} for cwd: ${this.workdir}`
    }

    console.log(`didOpen -> ${file}`);
    const relative_file = file.slice(this.workdir.length + 1);
    await this.did_open(relative_file);
  }
  
  sourcekit.initializationOptions = {
    "backgroundIndexing": true,  
    "backgroundPreparationMode": "enabled" 
  }

  await sourcekit.start(BINARY, ARGS);
 
  await (new Promise(resolve => setTimeout(resolve, 1000)));

  console.log(await sourcekit.symbol_search("ILType", {}))

  server.connect(transport); 
}

main();
