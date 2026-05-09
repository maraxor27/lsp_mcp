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
    this.base_uri = `file://${this.workdir}/`;
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
    
    receiver.pending = Buffer.concat([receiver.pending, data]);

    let done = false;
    while (!done) {
      if (receiver.pending.length == 0) {
        done = true;
        continue;
      }

      switch (this.receiver.state) {
      case 0: { // Header Parsing
        const maybe_header = receiver.pending.subarray(0, 50).toString()
        const match = header_regexp.exec(maybe_header);
        if (match != null && match.length == 2) {
          const content_length = Number(match[1]);
          if (isNaN(content_length)) {
            throw `Invalid Content-Length: ${match[1]}`;
          }

          const byte_length = Buffer.from(match[0], 'utf8').length;
          
          receiver.pending = receiver.pending.subarray(byte_length);
          receiver.state = 1;
          receiver.content_length = content_length;
        } else {
          console.log(`Couldn't parse: "${receiver.pending}"`);
          done = true
        }
        break;
      }
      case 1:
        if (receiver.pending.length >= receiver.content_length) {
          const msg_json = receiver.pending.subarray(0, receiver.content_length);
          receiver.pending = receiver.pending.subarray(receiver.content_length);
          
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
    await this.did_open(relative_file);
  }

  async did_open(relative_file, check=false) {
    let data;
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
        uri: this.file_to_uri(relative_file),
        languageId: "cpp",
        version: 1,
        text: data
      }
    });
  }

  async symbol_search(symbol) {
    const symbols = await this.request("workspace/symbol", {
      query: symbol
    });
    
    if (symbols === null) {
      throw `No symbol found for "${symbol}"`
    }

    const local_symbols = Array.prototype.map.call(symbols, (symbol) => {
      const file = this.uri_to_file(symbol.location.uri);
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
    // Ensure that the file is opened and up to date
    // TODO: Cache the opened files and avoid opening already opened files.
    await this.did_open(file);
  
    const references = await this.request("textDocument/references", {
      textDocument: { uri: this.file_to_uri(file) },
      position: {
        line: line,
        character: character
      }
    });
    
    if (references === null || references === undefined) {
      throw `No references found on ${file}:${line}:${character} `;
    }
    
    const local_references = Array.prototype.map.call(references, (reference) => {
      const file = this.uri_to_file(reference.uri);
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

  async hover(file, line, character) {
    // Ensure that the file is opened and up to date
    // TODO: Cache the opened files and avoid opening already opened files.
    await this.did_open(file);

    return await this.request("textDocument/hover", {
      textDocument: { uri: this.file_to_uri(file) },
      position: { line, character }
    });
  }

  async definition(file, line, character) {
    // Ensure that the file is opened and up to date
    // TODO: Cache the opened files and avoid opening already opened files.
    await this.did_open(file);

    const definition = await this.request("textDocument/definition", {
      textDocument: this.file_to_uri(file),
      position: { line, character }
    });

    return {
      file: this.uri_to_file(definition.uri),
      line: definition.range.start.line,
      character: definition.range.start.character
    };
  }

  async prepare_call_hierarchy(file, line, character) {
    // Ensure that the file is opened and up to date
    // TODO: Cache the opened files and avoid opening already opened files.
    await this.did_open(file);

    const call_hierarchy_items = await this.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri: this.file_to_uri(file) },
      position: { line, character }
    });

    if (call_hierarchy_items === null) {
      return "Couldn't find call hierarchy items";
    }
    
    if (call_hierarchy_items.length > 1) {
      return "Too many call hierarchy items";
    }

    return call_hierarchy_items[0];
  }

  process_call_hierarchy_items_for_mcp(items) {
    return Array.prototype.map.call(items, (item) => {
      if (item.fromRanges.length != 1) {
        throw `call hierarchy item too many from ranges: ${item.fromRanges.length}`;
      }
 
      const name = item.from.name;
      const kind = SymbolKind.get(item.from.kind);
      const details = item.from.details;
      const file = this.uri_to_file(item.from.uri);
      const line = item.from.range.start.line;
      const character = item.from.range.start.character;

      return {
        name,
        kind,
        details,
        file,
        line,
        character
      };
    });
  }

  async incoming_calls(file, line, character) {
    const call_hierarchy_item = await this.prepare_call_hierarchy(file, line, character);
    console.log(call_hierarchy_item)

    const incoming_calls = await this.request("callHierarchy/incomingCalls", { item: call_hierarchy_item });

    return this.process_call_hierarchy_items_for_mcp(incoming_calls);
  }
  
  async outgoing_calls(file, line, character) {
    const call_hierarchy_item = await this.prepare_call_hierarchy(file, line, character);
    console.log(call_hierarchy_item)
    
    const outgoing_calls = await this.request("callHierarchy/outgoingCalls", { item: call_hierarchy_item });

    return this.process_call_hierarchy_items_for_mcp(outgoing_calls);
  }
  
  file_to_uri(file) {
    const uri = this.base_uri + file;
    return uri 
  }

  uri_to_file(uri) {
    const URI_PREFIX = "file://"
    if (uri.startsWith(this.base_uri)) {
      return uri.slice(this.base_uri.length);
    } else if (uri.startsWith(URI_PREFIX)) {
      return uri.slice(URI_PREFIX.length);
    }
    throw `Invalid uri: "${uri}" "`;
  }
  
  workdir;
  base_uri;
  proc = undefined;
  pending_requests = new Map();
  current_request_id = 1;
  receiver = {
    state: 0,
    content_length: 0,
    pending: Buffer.alloc(0)
  };
  is_initialized = false;
  log_file = "/tmp/clangd.log";
}

const clangd = new ClangdClient();

server.registerTool("search-symbol", {
  title: 'Symbol Search Definition',
  description: "Search symbol definition in workspace. Symbol definitions can be identifers, classes, structs, functions, ...",
  inputSchema: z.object({
    symbol: z.string().describe("Name of the symbol to search"),
  }),
}, async function({symbol}) {
  const symbols = await clangd.symbol_search(symbol);

  return {
    content: [{ type: 'text', text: JSON.stringify(symbols) }],
  }; 
});

server.registerTool("find-all-references", {
  title: 'Find All References',
  description: "Find all references of a symbol based on its cursor location",
  inputSchema: z.object({
    file: z.string().describe("Filepath of the cursor position"),
    line: z.number().describe("Line number of the cursor"),
    character: z.number().describe("Character offset of the cursor"),
    max_result: z.number().default(30).describe("Set a maximum number of result. Keep low to avoid overwhelming the context window")
  }),
}, async function({file, line, character}) {
  const references = await clangd.find_all_references(file, line, character);
  
  return {
    content: [{ type: 'text', text: JSON.stringify(references) }],
  }; 
});

server.registerTool("hover-info", {
  title: 'Get Hover Information',
  description: "Get hover information about the symbol at a cusor position.",
  inputSchema: z.object({
    file: z.string().describe("Filepath of the cursor position"),
    line: z.number().describe("Line number of the cursor"),
    character: z.number().describe("Character offset of the cursor"),
  }),
}, async function({file, line, character}) {
  const hover_info = await clangd.hover(file, line, character);
  
  if (hover_info === undefined || hover_info === null) {
    throw "No hover info was found."
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(hover_info.contents.value) }],
  }; 
});

server.registerTool("goto-definition", {
  title: 'Find Definition at Position',
  description: "Find the definition of the symbol at the position.",
  inputSchema: z.object({
    file: z.string().describe("Filepath of the cursor position"),
    line: z.number().describe("Line number of the cursor"),
    character: z.number().describe("Character offset of the cursor"),
  }),
}, async function({file, line, character}) {
  const definition = await clangd.definition(file, line, character);
  
  return {
    content: [{ type: 'text', text: JSON.stringify(definition) }],
  }; 
});

server.registerTool("incoming-function-calls", {
  title: 'Incoming Function Calls',
  description: "List the functions that call the cursor position. Only use on function definitions.",
  inputSchema: z.object({
    file: z.string().describe("Filepath of the cursor position"),
    line: z.number().describe("Line number of the cursor"),
    character: z.number().describe("Character offset of the cursor"),
  }),
}, async function({file, line, character}) {
  const incoming_calls = await clangd.incoming_calls(file, line, character);
  
  return {
    content: [{ type: 'text', text: JSON.stringify(incoming_calls) }],
  }; 
});

server.registerTool("outgoing-function-calls", {
  title: 'Outgoing Function Calls',
  description: "List the functions called in a function definition. Position is the function symbol.",
  inputSchema: z.object({
    file: z.string().describe("Filepath of the cursor position"),
    line: z.number().describe("Line number of the cursor"),
    character: z.number().describe("Character offset of the cursor"),
  }),
}, async function({file, line, character}) {
  const outgoing_calls = await clangd.outgoing_calls(file, line, character);
  
  return {
    content: [{ type: 'text', text: JSON.stringify(outgoing_calls) }],
  }; 
});

server.registerTool("reload", {
  description: "Reload the clangd server to use the latest compile_commands.json",
  inputSchema: z.object({}),
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
