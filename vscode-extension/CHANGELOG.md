# Changelog

## 0.1.3

- Fix every session-backed endpoint (`call stack`, `variables`, `evaluate`, stepping) failing with `No debugger available, can not send 'stackTrace'` during Chrome and Node debugging. js-debug runs a thread-less parent session plus one child per target and swaps the child on each page navigation, so the single tracked session went stale. Sessions are now tracked in a map, `stopped` events are attributed to the session that emitted them via the tracker's session argument, and `onDidTerminateDebugSession` only forgets the session that actually ended.
- Route DAP requests to the paused session, preferring the one focused in the CALL STACK view, and fall back to a child session so a thread-less js-debug parent is never targeted.
- `stop` now terminates the root session instead of leaving a js-debug parent running after its child is stopped.
- Clear the paused-thread record before sending a resume request rather than after, so a `stopped` event that arrives while `continue`/`next`/`stepIn`/`stepOut` is still in flight is not erased. Previously a stepped-into breakpoint could leave `/state` reporting `running` even though the session was paused.
- `/health` reports the installed extension version instead of a hardcoded `0.1.0`, so it can confirm which build is live after a reinstall.

## 0.1.1

- Add the Debug MCP Bridge extension icon.

## 0.1.0

Initial release.

- **VS Code extension (`laststance.vscode-debug-mcp-bridge`)**: exposes the `vscode.debug` API over a local HTTP bridge (`127.0.0.1:7779`, configurable via `debugMcpBridge.port`). Auto-starts on window launch; manual control via `Debug MCP Bridge: Start Server` / `Stop Server` commands.
- **MCP server (`vscode-debug-mcp` on npm)**: stdio MCP server with 17 tools — breakpoints (set/remove/list, conditions, hit counts, logpoints), session control (launch/attach/stop), stepping (continue/over/into/out/pause), and inspection (state, call stack, variables, expression evaluation, variable expansion, threads).
- Works with any MCP client (Claude Code, Cursor, Codex), or driven directly over HTTP with `curl` — no MCP configuration required.
