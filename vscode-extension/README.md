# Debug MCP Bridge

Let AI agents drive the VS Code debugger. This extension exposes VS Code's debug engine (`vscode.debug`) over a local HTTP bridge on `127.0.0.1:7779`, so coding agents — Claude Code, Cursor, Codex, or anything that can run `curl` — can set breakpoints, launch/attach sessions, step, and inspect runtime state inside the editor you're already looking at.

Breakpoints appear in your editor, paused files open at the exact line, and you can take over the Run and Debug UI at any moment: agent and human share one debugging surface.

## How it works

```
AI Agent ──(stdio MCP)──> vscode-debug-mcp server ──(HTTP :7779)──> this extension ──> vscode.debug API
   └────────────────(or plain curl, no MCP config needed)────────────────┘
```

Pair it with the [`vscode-debug-mcp`](https://www.npmjs.com/package/vscode-debug-mcp) MCP server for tool-based access, or call the HTTP API directly — the endpoint table lives in the [repository README](https://github.com/laststance/vscode-debug-mcp#zero-config-http-mode).

## Quick start

1. Install this extension — the bridge auto-starts when a window opens.
2. Verify: `curl http://127.0.0.1:7779/health` → `{"status":"ok"}`
3. Point your agent at it:

```json
{
  "mcpServers": {
    "vscode-debugger": {
      "command": "npx",
      "args": ["-y", "vscode-debug-mcp"]
    }
  }
}
```

## Commands

- `Debug MCP Bridge: Start Server`
- `Debug MCP Bridge: Stop Server`

## Settings

- `debugMcpBridge.port` — port for the HTTP bridge server (default `7779`)

## Notes

- The server listens on `127.0.0.1` only; nothing is exposed externally.
- One window owns the port: with multiple VS Code windows open, the first to activate binds `7779`. Stop/start the bridge from the Command Palette in the window you want to control.
- Start the bridge before launching a debug session — sessions created earlier are re-synced on a best-effort basis.

## License

[MIT](https://github.com/laststance/vscode-debug-mcp/blob/main/LICENSE) © Laststance.io
