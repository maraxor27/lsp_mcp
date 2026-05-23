# LSP MCP

A lightweight Model Context Protocol (MCP) wrapper for various Language Server Protocol (LSP) servers.

This project allows AI agents to interact with powerful code intelligence features provided by language servers. By bridging MCP and LSP, agents can perform advanced code analysis, navigation, and understanding tasks that go far beyond simple text-based searches.

## 🚀 Features

- **Seamless MCP Integration**: Exposes LSP capabilities as standard MCP tools.
- **Multiple Language Support**: Includes implementations for:
  - **C/C++**: via `clangd`
  - **Swift**: via `sourcekit-lsp`
- **Advanced Code Intelligence**:
  - Symbol search in the workspace.
  - Finding all references to a symbol.
  - Getting hover information (types, documentation).
  - Navigating to definitions.
  - Exploring call hierarchies (incoming and outgoing calls).
- **Automatic Initialization**: Automatically detects relevant files (like `.cpp` or `.swift`) to initialize the LSP server.

## 🛠️ How it Works

The core logic resides in `lsp_mcp.js`, which implements an `LSPClient` that communicates with an LSP server via `stdio` using JSON-RPC. The `CreateLSP` utility then wraps these capabilities into an `McpServer`, registering them as tools that an MCP-compliant client (like an AI agent) can call.

## 📦 Supported Language Servers

### Clangd (C/C++)
The `clangd.js` implementation uses `clangd` to provide intelligence for C and C++ projects. It automatically scans for `.cpp`, `.cc`, `.c`, and `.h` files in the current working directory to begin indexing.

### SourceKit-LSP (Swift)
The `sourcekit.js` implementation uses `sourcekit-lsp` to provide intelligence for Swift projects.

## 🚦 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (latest LTS recommended)
- A compatible language server installed on your system (e.g., `clangd` or `sourcekit-lsp`).

### Installation

1. Clone this repository:
   ```bash
   git clone <repository-url>
   cd lsp-mcp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Usage

To run the MCP server for a specific language, execute the corresponding script using `node`.

**For C/C++ (clangd):**
```bash
node clangd.js
```

**For Swift (sourcekit-lsp):**
```bash
node sourcekit.js
```

Once running, you can connect your MCP client to the server's `stdio` input/output.

## 🛠️ Development

### Tools provided to the Agent

Each server implementation provides tools prefixed with the server name. For example, if using `clangd`, the tools will be:

- `clangd_search_symbol`
- `clangd_find_all_references`
- `clangd_hover_info`
- `clangd_goto_definition`
- `clangd_incoming_function_calls`
- `clangd_outgoing_function_calls`
- `clangd_reload`

## 📜 License

ISC
