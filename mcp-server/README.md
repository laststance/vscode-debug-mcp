# vscode-debug-mcp

MCP server that lets AI agents control the VS Code debugger — set breakpoints, launch/attach debug sessions, step through code, inspect call stacks and variables, and evaluate expressions in the paused frame.

Works as a pair with the [Debug MCP Bridge](https://github.com/laststance/vscode-debug-mcp) VS Code extension:

```
AI Agent ──(stdio MCP)──> vscode-debug-mcp ──(HTTP 127.0.0.1:7779)──> VS Code extension ──> vscode.debug API
```

## Setup

1. Install the **Debug MCP Bridge** extension in VS Code (Marketplace / Open VSX: `laststance.vscode-debug-mcp-bridge`). It auto-starts and binds `127.0.0.1:7779`.
2. Register this server with your MCP client:

Claude Code (`~/.claude.json` or project `.mcp.json`) / Cursor (`~/.cursor/mcp.json`):

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

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.vscode-debugger]
command = "npx"
args = ["-y", "vscode-debug-mcp"]
```

If the bridge runs on a custom port, set `VSCODE_DEBUG_PORT` in the server's env.

## Tools

| Tool | Description |
|------|-------------|
| `set_breakpoint` | Set a breakpoint (optional condition / hit count / logpoint) |
| `remove_breakpoint` | Remove breakpoints at a file:line |
| `list_breakpoints` | List all breakpoints |
| `launch_debug` | Start a debug session (inline config or launch.json name) |
| `stop_debugging` | Stop the active debug session |
| `debug_continue` | Continue execution |
| `debug_step_over` | Step over next statement |
| `debug_step_into` | Step into function call |
| `debug_step_out` | Step out of current function |
| `debug_pause` | Pause execution |
| `get_debug_state` | Get current state (inactive/running/stopped) |
| `get_call_stack` | Get call stack frames |
| `get_variables` | Get variables in scope |
| `evaluate_expression` | Evaluate an expression in the paused frame |
| `expand_variable` | Expand object/array children by variablesReference |
| `get_threads` | List active threads |

Prefer zero configuration? The bridge extension also accepts plain HTTP (`curl 127.0.0.1:7779`) — see the [endpoint table](https://github.com/laststance/vscode-debug-mcp#zero-config-http-mode).

## License

[MIT](https://github.com/laststance/vscode-debug-mcp/blob/main/LICENSE) © Laststance.io
