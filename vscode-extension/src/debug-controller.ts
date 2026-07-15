import * as vscode from "vscode";

/**
 * Wraps the vscode.debug API to provide a clean interface for external control.
 * Tracks debug session state via event listeners and exposes methods for
 * all debugging operations (breakpoints, stepping, variables, etc.).
 *
 * @example
 * const controller = new DebugController();
 * controller.activate(context);
 * await controller.setBreakpoint("/path/to/file.ts", 42);
 * await controller.launchDebug({ type: "node", request: "launch", program: "app.js" });
 */
export class DebugController {
  private session: vscode.DebugSession | null = null;
  private stoppedThreadId: number | null = null;
  private state: "inactive" | "running" | "stopped" = "inactive";
  private disposables: vscode.Disposable[] = [];

  /**
   * Registers debug event listeners to track session state.
   * Must be called during extension activation.
   */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((s) => {
        this.session = s;
        this.state = "running";
        this.stoppedThreadId = null;
      }),
      vscode.debug.onDidTerminateDebugSession(() => {
        this.session = null;
        this.state = "inactive";
        this.stoppedThreadId = null;
      }),
      vscode.debug.onDidChangeActiveDebugSession((s) => {
        this.session = s ?? null;
      }),
    );

    // Track stopped events via debug adapter tracker
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory("*", {
        createDebugAdapterTracker: () => ({
          onDidSendMessage: (msg: { type: string; event?: string; body?: { threadId?: number } }) => {
            if (msg.type === "event" && msg.event === "stopped") {
              this.state = "stopped";
              this.stoppedThreadId = msg.body?.threadId ?? 1;
            } else if (msg.type === "event" && msg.event === "continued") {
              this.state = "running";
              this.stoppedThreadId = null;
            }
          },
        }),
      }),
    );

    context.subscriptions.push(...this.disposables);

    // Handle the case where a debug session is already active when the extension
    // activates (e.g., user started the bridge AFTER F5). The onDidStartDebugSession
    // event has already fired and won't replay, so we sync state from the live API.
    const existingSession = vscode.debug.activeDebugSession;
    if (existingSession) {
      this.session = existingSession;
      this.state = "running";
      void this.syncStoppedState();
    }
  }

  /**
   * When attaching to an already-running session, detect whether any thread is
   * currently paused (e.g., stopped at a breakpoint). The DAP `stopped` event
   * fired before our tracker was registered, so we probe via `stackTrace` —
   * which only returns frames for paused threads per the DAP spec.
   */
  private async syncStoppedState(): Promise<void> {
    if (!this.session) return;
    try {
      const threadsResponse = await this.session.customRequest("threads", {});
      const threads: Array<{ id: number }> = threadsResponse.threads ?? [];
      for (const thread of threads) {
        try {
          const stackResponse = await this.session.customRequest("stackTrace", {
            threadId: thread.id,
            startFrame: 0,
            levels: 1,
          });
          if (stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
            this.state = "stopped";
            this.stoppedThreadId = thread.id;
            return;
          }
        } catch {
          // Thread isn't paused — try the next one
        }
      }
    } catch {
      // Couldn't fetch threads — keep state as "running"
    }
  }

  /**
   * Returns the current debug state: inactive, running, or stopped (at breakpoint).
   */
  getState(): { state: string; threadId: number | null; sessionName: string | null } {
    return {
      state: this.state,
      threadId: this.stoppedThreadId,
      sessionName: this.session?.name ?? null,
    };
  }

  /**
   * Sets a breakpoint at the given file path and line number.
   * Optionally accepts a condition expression and hit count.
   */
  async setBreakpoint(
    filePath: string,
    line: number,
    options?: { condition?: string; hitCondition?: string; logMessage?: string },
  ): Promise<{ success: boolean }> {
    const uri = vscode.Uri.file(filePath);
    const position = new vscode.Position(line - 1, 0); // VSCode is 0-indexed
    const location = new vscode.Location(uri, position);
    const bp = new vscode.SourceBreakpoint(
      location,
      true,
      options?.condition,
      options?.hitCondition,
      options?.logMessage,
    );
    vscode.debug.addBreakpoints([bp]);
    return { success: true };
  }

  /**
   * Removes all breakpoints at the given file path and line number.
   */
  async removeBreakpoint(filePath: string, line: number): Promise<{ removed: number }> {
    const uri = vscode.Uri.file(filePath);
    const toRemove = vscode.debug.breakpoints.filter((bp) => {
      if (bp instanceof vscode.SourceBreakpoint) {
        return (
          bp.location.uri.fsPath === uri.fsPath &&
          bp.location.range.start.line === line - 1
        );
      }
      return false;
    });
    vscode.debug.removeBreakpoints(toRemove);
    return { removed: toRemove.length };
  }

  /**
   * Lists all currently set breakpoints with their file paths and line numbers.
   */
  listBreakpoints(): {
    breakpoints: Array<{
      file: string;
      line: number;
      enabled: boolean;
      condition?: string;
    }>;
  } {
    const bps = vscode.debug.breakpoints
      .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
      .map((bp) => ({
        file: bp.location.uri.fsPath,
        line: bp.location.range.start.line + 1, // Convert back to 1-indexed
        enabled: bp.enabled,
        condition: bp.condition,
      }));
    return { breakpoints: bps };
  }

  /**
   * Launches a debug session with the given configuration.
   * Accepts either a launch.json config name or an inline debug configuration.
   */
  async launchDebug(
    config: vscode.DebugConfiguration | string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
      let debugConfig: vscode.DebugConfiguration;

      if (typeof config === "string") {
        // Config name — find it from launch.json
        debugConfig = { type: "", name: config, request: "launch" };
        const started = await vscode.debug.startDebugging(folder, config);
        return { success: started };
      } else {
        debugConfig = config;
        const started = await vscode.debug.startDebugging(folder, debugConfig);
        return { success: started };
      }
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Stops the currently active debug session.
   */
  async stopDebugging(): Promise<{ success: boolean }> {
    if (!this.session) {
      return { success: false };
    }
    await vscode.debug.stopDebugging(this.session);
    return { success: true };
  }

  /**
   * Sends a continue request to resume execution.
   */
  async continue_(): Promise<{ success: boolean; error?: string }> {
    return this.sendDapRequest("continue", { threadId: this.stoppedThreadId ?? 1 });
  }

  /**
   * Steps over the next statement in the current function.
   */
  async stepOver(): Promise<{ success: boolean; error?: string }> {
    return this.sendDapRequest("next", { threadId: this.stoppedThreadId ?? 1 });
  }

  /**
   * Steps into the next function call.
   */
  async stepInto(): Promise<{ success: boolean; error?: string }> {
    return this.sendDapRequest("stepIn", { threadId: this.stoppedThreadId ?? 1 });
  }

  /**
   * Steps out of the current function.
   */
  async stepOut(): Promise<{ success: boolean; error?: string }> {
    return this.sendDapRequest("stepOut", { threadId: this.stoppedThreadId ?? 1 });
  }

  /**
   * Pauses execution at the current point.
   */
  async pause(): Promise<{ success: boolean; error?: string }> {
    return this.sendDapRequest("pause", { threadId: this.stoppedThreadId ?? 1 });
  }

  /**
   * Returns the current call stack (list of stack frames) for the stopped thread.
   */
  async getCallStack(): Promise<{
    frames: Array<{
      id: number;
      name: string;
      source?: string;
      line?: number;
      column?: number;
    }>;
    error?: string;
  }> {
    if (!this.session) {
      return { frames: [], error: "No active debug session" };
    }
    try {
      const response = await this.session.customRequest("stackTrace", {
        threadId: this.stoppedThreadId ?? 1,
        startFrame: 0,
        levels: 50,
      });
      const frames = (response.stackFrames ?? []).map(
        (f: { id: number; name: string; source?: { path?: string }; line?: number; column?: number }) => ({
          id: f.id,
          name: f.name,
          source: f.source?.path,
          line: f.line,
          column: f.column,
        }),
      );
      return { frames };
    } catch (err) {
      return { frames: [], error: String(err) };
    }
  }

  /**
   * Returns variables for the given scope in the given frame.
   * If no frameId is provided, uses the top frame.
   * If no scope is specified, returns all scopes.
   */
  async getVariables(
    frameId?: number,
    scopeName?: string,
  ): Promise<{
    variables: Array<{ name: string; value: string; type?: string; variablesReference: number }>;
    error?: string;
  }> {
    if (!this.session) {
      return { variables: [], error: "No active debug session" };
    }
    try {
      // Get top frame if not specified
      let targetFrameId = frameId;
      if (targetFrameId === undefined) {
        const stackResponse = await this.session.customRequest("stackTrace", {
          threadId: this.stoppedThreadId ?? 1,
          startFrame: 0,
          levels: 1,
        });
        targetFrameId = stackResponse.stackFrames?.[0]?.id;
        if (targetFrameId === undefined) {
          return { variables: [], error: "No stack frame available" };
        }
      }

      // Get scopes for the frame
      const scopesResponse = await this.session.customRequest("scopes", {
        frameId: targetFrameId,
      });
      const scopes: Array<{ name: string; variablesReference: number }> = scopesResponse.scopes ?? [];

      // Filter by scope name if specified
      const targetScopes = scopeName
        ? scopes.filter((s) => s.name.toLowerCase().includes(scopeName.toLowerCase()))
        : scopes;

      // Get variables for each scope
      const allVars: Array<{ name: string; value: string; type?: string; variablesReference: number }> = [];
      for (const scope of targetScopes) {
        const varsResponse = await this.session.customRequest("variables", {
          variablesReference: scope.variablesReference,
        });
        const vars = (varsResponse.variables ?? []).map(
          (v: { name: string; value: string; type?: string; variablesReference: number }) => ({
            name: v.name,
            value: v.value,
            type: v.type,
            variablesReference: v.variablesReference,
          }),
        );
        allVars.push(...vars);
      }
      return { variables: allVars };
    } catch (err) {
      return { variables: [], error: String(err) };
    }
  }

  /**
   * Evaluates an expression in the context of the current stopped frame.
   */
  async evaluate(
    expression: string,
    frameId?: number,
    context?: string,
  ): Promise<{ result: string; type?: string; variablesReference?: number; error?: string }> {
    if (!this.session) {
      return { result: "", error: "No active debug session" };
    }
    try {
      let targetFrameId = frameId;
      if (targetFrameId === undefined) {
        const stackResponse = await this.session.customRequest("stackTrace", {
          threadId: this.stoppedThreadId ?? 1,
          startFrame: 0,
          levels: 1,
        });
        targetFrameId = stackResponse.stackFrames?.[0]?.id;
      }

      const response = await this.session.customRequest("evaluate", {
        expression,
        frameId: targetFrameId,
        context: context ?? "repl",
      });
      return {
        result: response.result,
        type: response.type,
        variablesReference: response.variablesReference,
      };
    } catch (err) {
      return { result: "", error: String(err) };
    }
  }

  /**
   * Expands a variable reference to show child properties.
   * Useful for inspecting objects, arrays, and nested structures.
   */
  async expandVariable(
    variablesReference: number,
  ): Promise<{
    variables: Array<{ name: string; value: string; type?: string; variablesReference: number }>;
    error?: string;
  }> {
    if (!this.session) {
      return { variables: [], error: "No active debug session" };
    }
    try {
      const response = await this.session.customRequest("variables", {
        variablesReference,
      });
      const vars = (response.variables ?? []).map(
        (v: { name: string; value: string; type?: string; variablesReference: number }) => ({
          name: v.name,
          value: v.value,
          type: v.type,
          variablesReference: v.variablesReference,
        }),
      );
      return { variables: vars };
    } catch (err) {
      return { variables: [], error: String(err) };
    }
  }

  /**
   * Returns the list of active threads in the debug session.
   */
  async getThreads(): Promise<{
    threads: Array<{ id: number; name: string }>;
    error?: string;
  }> {
    if (!this.session) {
      return { threads: [], error: "No active debug session" };
    }
    try {
      const response = await this.session.customRequest("threads", {});
      return { threads: response.threads ?? [] };
    } catch (err) {
      return { threads: [], error: String(err) };
    }
  }

  private async sendDapRequest(
    command: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.session) {
      return { success: false, error: "No active debug session" };
    }
    try {
      await this.session.customRequest(command, args);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
}
