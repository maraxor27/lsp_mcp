import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { open } from "node:fs/promises";
import fs from "node:fs";
import process from "process";
import { spawn } from "node:child_process";
import { glob } from "glob";

export const server = new McpServer({
  name: "clangd-mcp",
  version: "0.1",
});

const SymbolKind = new Map([
	[1, "File"],
	[2, "Module"],
	[3, "Namespace"],
	[4, "Package"],
	[5, "Class"],
	[6, "Method"],
	[7, "Property"],
	[8, "Field"],
	[9, "Constructor"],
	[10, "Enum"],
	[11, "Interface"],
	[12, "Function"],
	[13, "Variable"],
	[14, "Constant"],
	[15, "String"],
	[16, "Number"],
	[17, "Boolean"],
	[18, "Array"],
	[19, "Object"],
	[20, "Key"],
	[21, "Null"],
	[22, "EnumMember"],
	[23, "Struct"],
	[24, "Event"],
	[25, "Operator"],
	[26, "TypeParameter"],
])

class ClangdClient {
  constructor() {
    this.workdir = process.cwd();
  }
  async start() {
    const log_fd = await open(this.log_file, 'a+');
    const log = log_fd.createWriteStream();
    log.write("--- Starting ---\n");
    this.proc = spawn(
      "clangd", 
      [
        "--background-index", 
        `--compile-commands-dir=${this.workdir}`,
        "--log=info" // verbose
      ],
      { 
        cwd: this.workdir, 
        stdio: ['pipe', 'pipe', log] 
      }
    );
    this.proc.stdout.on('data', (data) => { this.receive_message(data) } );
    log.close();
  }

  async reload() {
    if (!this.proc.kill('SIGTERM')) {
      throw "Failed to kill clangd";
    }
    await this.start();
    await this.initialize();
  }

  receive_message(data) {
    const header_regexp = /^Content-Length: (\d+)\r\n\r\n/m;
    const receiver = this.receiver;
    
    receiver.pending = receiver.pending + data.toString();

    let done = false;
    while (!done) {
      if (receiver.pending.length == 0) {
        done = true;
        continue;
      }

      switch (this.receiver.state) {
      case 0: // Header Parsing
        const match = header_regexp.exec(receiver.pending);
        if (match != null && match.length == 2) {
          const content_length = Number(match[1]);
          if (isNaN(content_length)) {
            throw `Invalid Content-Length: ${match[1]}`;
          }
          receiver.pending = receiver.pending.slice(match[0].length);
          receiver.state = 1;
          receiver.content_length = content_length;
        } else {
          console.log(`Couldn't parse: "${receiver.pending}"`);
          done = true
        }
        break;
      case 1:
        if (receiver.pending.length >= receiver.content_length) {
          const msg_json = receiver.pending.slice(0, receiver.content_length);
          receiver.pending = receiver.pending.slice(receiver.content_length);
          
          const msg = JSON.parse(msg_json);
          const promise_resolver = this.pending_requests.get(msg.id);

          if (promise_resolver !== undefined) {
            promise_resolver(msg.result);
            this.pending_requests.delete(msg.id);
          }

          receiver.state = 0;
        } else {
          done = true
        }
        break;
      }
    }
  }
  
  send_message(payload) {
    const serialized = JSON.stringify(payload);
    const header = `Content-Length: ${serialized.length}\r\n\r\n`;
    this.proc.stdin.write(header);
    this.proc.stdin.write(serialized);
  }

  request(method, params={}) { 
    this.send_message({
      jsonrpc: "2.0",
      id: this.current_request_id,
      method,
      params
    });

    return new Promise((resolve) => {
      this.pending_requests.set(this.current_request_id++, resolve); 
    });
  }

  notify(method, params={}) {
    this.send_message({
      jsonrpc: "2.0",
      method,
      params
    })
  }

  async initialize() {
    await this.request("initialize", {
      processId: null,
      clientInfo: {
        name: "clangd-mcp",
        version: "0.1"
      },
      rootUri: this.workdir,
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          implementation: { linkSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true }
        },
        workspace: { 
          symbol: {}
        },
      },
      initializationOptions: {}
    });
    this.notify("initialized");

    const files = await glob(this.workdir + '/**/*.{cpp,cc,c,h}');
    if (files.length == 0) {
      throw "No c or c++ files found"
    }
    
    const file = files[0];
    if (!files[0].startsWith(this.workdir)) {
      throw `Invalid file: ${file} for cwd: ${this.workdir}`
    }

    const relative_file = file.slice(this.workdir.length + 1);
    await this.didOpen(relative_file);
  }

  async didOpen(relative_file, check=false) {
    let data = "";
    const absolute_file = this.workdir + "/" + relative_file;
    try {
      data = await new Promise(
        (resolve, reject) => { 
          fs.readFile(absolute_file, { encoding: 'utf8' }, (err, data) => {
            if (err) {
              reject(err);
            }
            resolve(data);
          })
        });
    } catch (err) {
      console.log(`Failed to read ${absolute_file}:\n${err}`);
      if (check) throw err;
      return;
    }

    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: `file://${this.workdir}/{relative_file}`,
        languageId: "cpp",
        version: 1,
        text: data
      }
    });
  }

  async symbol_search(symbol) {
    const symbols = await this.request("workspace/symbol",{
      query: symbol
    });
    
    const base_uri = `file://${this.workdir}/`;
    const base_uri_length = base_uri.length;
    const local_symbols = Array.prototype.map.call(symbols, (symbol) => {
      const file = symbol.location.uri.slice(base_uri_length);
      const line = symbol.location.range.start.line;
      const character = symbol.location.range.start.character;

      return {
        name: symbol.name, 
        kind: SymbolKind.get(symbol.kind),
        file,
        line,
        character
      }
    })

    return local_symbols;
  }

  async find_all_references(file, line, character) {
    const references = await this.request("textDocument/references",{
      textdocument: { uri: `file://${this.workspace}/${file}` },
      position: {
        line: line,
        character: character
      }
    });

    
    const base_uri = `file://${this.workdir}/`;
    const base_uri_length = base_uri.length;
    const local_references = Array.prototype.map.call(references, (reference) => {
      const file = reference.uri.slice(base_uri_length);
      const line = reference.range.start.line;
      const character = reference.range.start.character;

      return {
        file,
        line,
        character
      }
    })
    return local_references;
  }
  
  workdir;
  proc = undefined;
  pending_requests = new Map();
  current_request_id = 1;
  receiver = {
    state: 0,
    content_length: null,
    pending: ""
  };
  is_initialized = false;
  log_file = "/tmp/clangd.log";
}

const clangd = new ClangdClient();



server.registerTool("symbol-search", {
  title: 'Symbol Search',
  description: "Fuzzy search workspace for symbols. Symbols can be identifers, classes, structs, functions, ...",
  inputSchema: z.object({
    symbol: z.string().describe("Name of the symbol to search"),
  }),
/*
  outputSchema: z.array(z.object({
    name: z.string().describe("Symbol name"),
    kind: z.string().describe("Kind of symbol"),
    file: z.string().describe("Relative filepath of where the symbol is defined"),
    line: z.number().describe("Line number of the symbol is definition"), 
    character: z.number().describe("Character offset of the symbol definition") 
  }).describe("Symbol search result"))
*/
}, async function({symbol}) {
  const symbols = await clangd.symbol_search(symbol);
  
  const fd = await open("/tmp/clangd-mcp.log", 'a+');
  const log = fd.createWriteStream();
  log.write(`<-- symbol-search ("${symbol}")\n`+JSON.stringify(symbols) + "\n");
  fd.close()

  return {
    content: [{ type: 'text', text: JSON.stringify(symbols) }],
    // structuredContent: symbols
  }; 
});

server.registerTool("find-all-references", {
  title: 'Find All References',
  description: "Find all references of a symbol based on its cursor location",
  inputSchema: z.object({
    file: z.string().describe("File of the cursor position"),
    line: z.number().describe("Line number of the cursor"),
    character: z.number().describe("Character offset of the cursor"),
    max_result: z.number().default(30).describe("Set a maximum number of result. Keep low to avoid overwhelming the context window")
  }),
/*
  outputSchema: z.array(z.object({
    file: z.string().describe("Relative filepath of the reference"),
    line: z.number().describe("Line number of the reference"), 
    character: z.number().describe("Character offset of the reference") 
  }).describe("Reference search result"))
*/
}, async function({file, line, character}) {
  const references = await clangd.find_all_references(file, line, character);
  
  return {
    content: [{ type: 'text', text: JSON.stringify(references) }],
    // structuredContent: references
  }; 
});

server.registerTool("reload", {
  description: "Reload the clangd server to use the latest compile_commands.json",
  inputSchema: z.object({}),
  outputSchema: z.object({})
}, async function() {
  await clangd.reload();
});

async function main() {
  await clangd.start();
  await clangd.initialize();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
