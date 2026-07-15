# vscode-debug-mcp

Let AI agents drive the VS Code debugger.

A two-part toolkit that gives coding agents (Claude Code, Cursor, Codex, or plain `curl`) full control of VS Code's debugging engine: set breakpoints, launch/attach sessions, step through code, inspect call stacks and variables, and evaluate expressions in the paused frame — all inside the editor the human is already looking at.

```
AI Agent ──(stdio MCP)──> MCP Server ──(HTTP 127.0.0.1:7779)──> VS Code Extension ──> vscode.debug API
   └──────────────(or plain curl, no MCP config needed)──────────────┘
```

| Package | Where | What |
|---|---|---|
| [`laststance.vscode-debug-mcp-bridge`](vscode-extension/) | VS Code Marketplace / Open VSX | Extension exposing `vscode.debug` over a local HTTP bridge |
| [`vscode-debug-mcp`](mcp-server/) | npm | Stdio MCP server translating MCP tool calls to bridge HTTP calls |

Why an editor bridge instead of a standalone DAP client? The debug session lives in the user's VS Code window: breakpoints are visible, the paused file opens at the exact line, and the human can take over the Run and Debug UI at any moment. Agent and human share one debugging surface. This powers live "feature tour" walkthroughs where an agent narrates newly written code while stepping through it in a real app.

## Setup

### 1. Install the VS Code extension

From the Marketplace / Open VSX (search "Debug MCP Bridge"), or from a local build:

```bash
code --install-extension vscode-debug-mcp-bridge-0.1.0.vsix   # cursor --install-extension works too
```

The bridge auto-starts when a window opens and binds `127.0.0.1:7779` (change via the `debugMcpBridge.port` setting). Command Palette: `Debug MCP Bridge: Start Server` / `Stop Server`.

Verify:

```bash
curl http://127.0.0.1:7779/health
# → {"status":"ok","version":"0.1.0"}
```

### 2. Configure the MCP server (optional)

Skip this if you prefer driving the bridge with plain HTTP — see [Zero-config HTTP mode](#zero-config-http-mode).

Claude Code (`~/.claude.json` or project `.mcp.json`):

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

Cursor (`~/.cursor/mcp.json` or project `.cursor/mcp.json`) uses the same shape. Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.vscode-debugger]
command = "npx"
args = ["-y", "vscode-debug-mcp"]
```

Optional: set a custom bridge port with the `VSCODE_DEBUG_PORT` env var (default `7779`).

## MCP tools

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

## Zero-config HTTP mode

Everything the MCP server does is also reachable directly — useful for agents that can run shell commands but have no MCP configuration:

| Purpose | HTTP |
|---|---|
| Health check | `GET /health` |
| Set breakpoint | `POST /breakpoint {"file":"<abs path>","line":N}` (opt: `condition`, `hitCondition`, `logMessage`) |
| Remove breakpoint | `DELETE /breakpoint {"file":"<abs path>","line":N}` |
| List breakpoints | `GET /breakpoints` |
| Launch/attach | `POST /debug/launch {"config":{...}}` or `{"configName":"<launch.json name>"}` |
| Poll state | `GET /state` → `{"state":"stopped","threadId":1,...}` |
| Call stack | `GET /debug/callstack` |
| Variables | `POST /debug/variables {}` |
| Evaluate | `POST /debug/evaluate {"expression":"..."}` |
| Expand variable | `POST /debug/expand {"variablesReference":N}` |
| Continue / step | `POST /debug/continue`, `/debug/stepOver`, `/debug/stepInto`, `/debug/stepOut`, `/debug/pause` |
| Threads | `GET /debug/threads` |
| Detach | `POST /debug/stop` |

Example — attach to a running Chrome and break on a click handler:

```bash
curl -s -X POST http://127.0.0.1:7779/debug/launch -H "Content-Type: application/json" -d '{
  "config": {
    "type": "chrome", "request": "attach", "name": "agent attach",
    "port": 9222, "webRoot": "/abs/path/to/project",
    "urlFilter": "http://localhost:3000/*"
  }
}'
curl -s -X POST http://127.0.0.1:7779/breakpoint -d '{"file":"/abs/path/src/App.tsx","line":42}'
curl -s http://127.0.0.1:7779/state   # poll until "stopped"
```

## Operational notes

- **One window owns the port.** The bridge binds `7779` per VS Code window; with multiple windows open, the first to activate wins. Paused files open in the owning window. Find the owner with `ps -p $(lsof -t -iTCP:7779 -sTCP:LISTEN) -o command=` (the workspace name appears in the process title), then stop/start the bridge via the Command Palette in the window you want.
- **Start the bridge before launching debug sessions.** The DAP tracker only observes sessions created after the bridge is running. If state looks stale after IDE-driven steps, call `GET /state` to re-sync.
- **Single session (current limitation).** Only the active debug session is tracked. Multi-session setups (e.g. Next.js server + client) follow the focused session — see [TODO.md](TODO.md).
- The bridge listens on `127.0.0.1` only and is never exposed externally.

## Development

```bash
pnpm install          # workspace root
pnpm typecheck        # both packages
pnpm build            # both packages
pnpm package          # build the .vsix (vscode-extension/)

# E2E (requires a VS Code window with this repo open and the bridge running)
cd e2e && node e2e-test.mjs
```

## Releasing

```bash
# VS Code Marketplace + Open VSX (PATs injected via 1Password)
pnpm publish:stores:dry-run
pnpm publish:stores

# npm (mcp-server)
pnpm publish:npm
```

`.env.1password` maps `VSCE_PAT` / `OVSX_PAT` to 1Password items (`op run` injects them at publish time). The npm publish uses your logged-in npm account (`npm login` first).

## License

[MIT](LICENSE) © [Laststance.io](https://github.com/laststance)
