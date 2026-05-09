# Clangd MCP

A simple, sort of lite weight mcp wrapper around the clangd lsp server.

## Features

### Auto Initialization
Some specific request like `workspace/symbols` require at least one file to be opened. 
`clangd-mcp` automatically finds any c / c++ file within the repository and opens it to quick off the initialization.
This initialization also start off the clangd background index.

