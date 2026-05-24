import { CreateLSP } from "./lsp_mcp.js";

import { glob } from "glob";
import levenshtein from 'js-levenshtein';

const NAME = "sourcekit";
const VERSION = "0.1";

const BINARY = "sourcekit-lsp";
const ARGS = [
];

async function main() {
  const {client: sourcekit, server, transport} = CreateLSP(NAME, VERSION, "swift");
  
  sourcekit.post_initialization_callback = async function(_init_response) {
    const files = await glob(this.workdir + '/**/*.swift');
    if (files.length == 0) {
      throw "No swift files found"
    }
    
    const file = files[0]; 
    if (file == undefined) {
      throw "Couldn't find suitable .swift file"
    }
    if (!file.startsWith(this.workdir)) {
      throw `Invalid file: ${file} for cwd: ${this.workdir}`
    }

    const relative_file = file.slice(this.workdir.length + 1);
    await this.did_open(relative_file, "swift");
  }

  sourcekit.symbol_search_post_processing = async function(query, symbols) {
    const closeness = symbols.map((symbol, index) => {
      return {value: levenshtein(query, symbol.name), index}
    });
    
    closeness.sort((a, b) => a.value - b.value);
    
    const sorted_symbols = new Array(closeness.length);
    closeness.forEach((value, index) => {
      sorted_symbols[index] = symbols[value.index];
    });

    return sorted_symbols
  } 
  
  sourcekit.initializationOptions = {
    "backgroundIndexing": true,  
    "backgroundPreparationMode": "enabled" 
  }

  await sourcekit.start(BINARY, ARGS);
  
  server.connect(transport); 
}

main();
