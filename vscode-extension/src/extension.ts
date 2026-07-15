import * as vscode from "vscode";
import { DebugController } from "./debug-controller";
import { BridgeServer } from "./http-server";

let bridgeServer: BridgeServer | null = null;
const debugController = new DebugController();

/**
 * Extension activation entry point.
 * Starts the HTTP bridge server and registers debug event listeners.
 * The server runs on a configurable port (default: 7779).
 */
export function activate(context: vscode.ExtensionContext): void {
  debugController.activate(context);

  const startServer = async () => {
    if (bridgeServer) {
      vscode.window.showInformationMessage("Debug MCP Bridge is already running.");
      return;
    }

    const config = vscode.workspace.getConfiguration("debugMcpBridge");
    const port = config.get<number>("port", 7779);

    bridgeServer = new BridgeServer(debugController, port);
    try {
      await bridgeServer.start();
      vscode.window.showInformationMessage(
        `Debug MCP Bridge started on port ${port}`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to start Debug MCP Bridge: ${err}`,
      );
      bridgeServer = null;
    }
  };

  const stopServer = async () => {
    if (!bridgeServer) {
      vscode.window.showInformationMessage("Debug MCP Bridge is not running.");
      return;
    }
    await bridgeServer.stop();
    bridgeServer = null;
    vscode.window.showInformationMessage("Debug MCP Bridge stopped.");
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("debugMcpBridge.start", startServer),
    vscode.commands.registerCommand("debugMcpBridge.stop", stopServer),
  );

  // Auto-start on activation
  startServer();
}

/**
 * Extension deactivation — stops the bridge server.
 */
export function deactivate(): void {
  if (bridgeServer) {
    bridgeServer.stop();
    bridgeServer = null;
  }
}
