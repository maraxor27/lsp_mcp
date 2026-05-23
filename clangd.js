import { CreateLSP } from "./lsp_mcp.js";
import process from "process";
import { glob } from "glob";

const NAME = "clangd";
const VERSION = "0.1";

const BINARY = "clangd";
const ARGS = [
  "--background-index", 
  `--compile-commands-dir=${process.cwd()}`,
  "--log=info" // warning, info, verbose
];

async function main() {
  const {client: clangd, server, transport} = CreateLSP(NAME, VERSION, "cpp");

  clangd.post_initialization_callback = async function(_init_response) {
    console.log(_init_response); 
    const files = await glob(this.workdir + '/**/*.{cpp,cc,c,h}');
    if (files.length == 0) {
      throw "No c or c++ files found"
    }
    
    const file = files[0];
    // const file = "/Users/simonlaureti/repos/v8/v8/src/maglev/maglev-graph-builder.h";

    if (!file.startsWith(this.workdir)) {
      throw `Invalid file: ${file} for cwd: ${this.workdir}`
    }

    console.log(`didOpen -> ${file}`);
    const relative_file = file.slice(this.workdir.length + 1);
    await this.did_open(relative_file);
  }
  
  await clangd.start(BINARY, ARGS);
 
  server.connect(transport); 
}

main();
