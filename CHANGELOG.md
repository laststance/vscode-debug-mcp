# Changelog

## 0.1.0

Initial release.

- **VS Code extension (`laststance.vscode-debug-mcp-bridge`)**: exposes the `vscode.debug` API over a local HTTP bridge (`127.0.0.1:7779`, configurable via `debugMcpBridge.port`). Auto-starts on window launch; manual control via `Debug MCP Bridge: Start Server` / `Stop Server` commands.
- **MCP server (`vscode-debug-mcp` on npm)**: stdio MCP server with 17 tools — breakpoints (set/remove/list, conditions, hit counts, logpoints), session control (launch/attach/stop), stepping (continue/over/into/out/pause), and inspection (state, call stack, variables, expression evaluation, variable expansion, threads).
- Works with any MCP client (Claude Code, Cursor, Codex), or driven directly over HTTP with `curl` — no MCP configuration required.
