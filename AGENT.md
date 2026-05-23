# LSP MCP Agent Documentation

This repository provides a bridge between the **Model Context Protocol (MCP)** and **Language Server Protocol (LSP)**. It allows AI agents to leverage the powerful code intelligence capabilities of language servers (like `clangd` for C/C++ or `sourcekit-lsp` for Swift) through a standardized MCP interface.

## Overview

The project implements an MCP server that wraps an LSP client. When an agent connects to this server, it gains access to various code intelligence tools that can be used to navigate, understand, and analyze codebases.

## Core Components

- **`lsp_mcp.js`**: The engine of the project.
  - `LSPClient`: Implements a JSON-RPC client to communicate with an LSP server over `stdio`. It handles initialization, message parsing, and provides high-level methods for LSP features.
  - `CreateLSP()`: A factory function that creates an `McpServer` and registers a set of tools mapped to LSP capabilities.
- **`clangd.js`**: An implementation for `clangd`, providing MCP tools for C and C++ development. It automatically detects files and initializes the server.
- **`sourcekit.js`**: An implementation for `sourcekit-lsp`, providing MCP tools for Swift development.

## Exposed MCP Tools

Each language server implementation exposes a set of tools prefixed with the server name (e.g., `clangd_search_symbol` or `sourcekit_search_symbol`):

| Tool Name | Description |
| :--- | :--- |
| `[name]_search_symbol` | Searches for a symbol (class, function, variable, etc.) in the workspace. |
| `[name]_find_all_references` | Finds all references to a symbol at a specific file, line, and character position. |
| `[name]_hover_info` | Provides hover information (documentation, type info, etc.) for a symbol at a specific position. |
| `[name]_goto_definition` | Finds the definition of a symbol at a specific position. |
| `[name]_incoming_function_calls` | Lists functions that call the specified function. |
| `[name]_outgoing_function_calls` | Lists functions called by the specified function. |
| `[name]_reload` | Restarts the LSP server (useful after updating configuration like `compile_commands.json`). |

## Usage for Agents

To use this, an agent should start the appropriate implementation (e/g., `node clangd.js`) as an MCP server. The agent can then use the provided tools to perform deep code analysis, navigate through complex hierarchies, and understand the codebase context much more effectively than with simple text-based tools.
