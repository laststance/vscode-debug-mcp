import * as vscode from "vscode";

/** DAP requests that resume execution, so the target session stops being paused. */
type ResumeCommand = "continue" | "next" | "stepIn" | "stepOut";

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
  /**
   * Every live debug session, keyed by session id.
   *
   * js-debug (Chrome and Node) never runs a single session: it starts a
   * thread-less parent plus one child session per debug target, and every page
   * navigation terminates the old child and starts a new one. Holding one
   * session in a field goes stale within seconds of real use, which makes
   * `customRequest` fail with "No debugger available".
   */
  private sessions = new Map<string, vscode.DebugSession>();

  /** Thread each paused session stopped on. A missing entry means that session is running. */
  private stoppedThreads = new Map<string, number>();

  /** Session VS Code currently focuses. In js-debug this is often the thread-less parent. */
  private activeSessionId: string | null = null;

  /** Most recently started session, used when nothing is paused and nothing is focused. */
  private latestSessionId: string | null = null;

  private disposables: vscode.Disposable[] = [];

  /**
   * Registers debug event listeners to track session state.
   * Must be called during extension activation.
   */
  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((s) => {
        this.sessions.set(s.id, s);
        this.latestSessionId = s.id;
      }),
      vscode.debug.onDidTerminateDebugSession((s) => {
        // Only forget the session that actually ended. Dropping every session
        // here would discard a live child whenever a sibling target closes.
        this.forgetSession(s.id);
      }),
      vscode.debug.onDidChangeActiveDebugSession((s) => {
        this.activeSessionId = s?.id ?? null;
        if (s) this.sessions.set(s.id, s);
      }),
    );

    // Track stopped events per session. The tracker factory hands us the owning
    // session, so a `stopped` event is attributed to the session that emitted it
    // instead of whichever session happened to be focused at the time.
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory("*", {
        createDebugAdapterTracker: (session: vscode.DebugSession) => {
          this.sessions.set(session.id, session);
          return {
            onDidSendMessage: (msg: {
              type: string;
              event?: string;
              body?: { threadId?: number };
            }) => {
              if (msg.type === "event" && msg.event === "stopped") {
                this.stoppedThreads.set(session.id, msg.body?.threadId ?? 1);
              } else if (msg.type === "event" && msg.event === "continued") {
                this.stoppedThreads.delete(session.id);
              }
            },
            onWillStopSession: () => this.forgetSession(session.id),
          };
        },
      }),
    );

    context.subscriptions.push(...this.disposables);

    // Handle the case where a debug session is already active when the extension
    // activates (e.g., user started the bridge AFTER F5). The onDidStartDebugSession
    // event has already fired and won't replay, so we sync state from the live API.
    const existingSession = vscode.debug.activeDebugSession;
    if (existingSession) {
      this.activeSessionId = existingSession.id;
      this.latestSessionId = existingSession.id;
      // Walk up the chain so the parent is reachable too; children started before
      // activation are not enumerable, but the active session is the paused one.
      for (
        let session: vscode.DebugSession | undefined = existingSession;
        session;
        session = session.parentSession
      ) {
        this.sessions.set(session.id, session);
      }
      void this.syncStoppedState();
    }
  }

  /** Drops a session and any paused state recorded for it. */
  private forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.stoppedThreads.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
    if (this.latestSessionId === sessionId) this.latestSessionId = null;
  }

  /**
   * Picks the session and thread that DAP requests should target.
   *
   * A paused session always wins, because `stackTrace`, `scopes`, and `evaluate`
   * only work on a paused thread. When nothing is paused we fall back to the
   * focused session, preferring its child so we never hand back a js-debug
   * parent that has no threads of its own.
   */
  private resolveTarget(): {
    session: vscode.DebugSession;
    threadId: number | null;
  } | null {
    const pausedId = this.resolvePausedSessionId();
    if (pausedId != null) {
      const session = this.sessions.get(pausedId);
      if (session) {
        return { session, threadId: this.stoppedThreads.get(pausedId) ?? null };
      }
    }

    const fallback = this.resolveFallbackSession();
    return fallback ? { session: fallback, threadId: null } : null;
  }

  /** Id of the paused session, preferring the one the user focused in the CALL STACK view. */
  private resolvePausedSessionId(): string | null {
    if (this.activeSessionId != null && this.stoppedThreads.has(this.activeSessionId)) {
      return this.activeSessionId;
    }
    for (const sessionId of this.stoppedThreads.keys()) {
      if (this.sessions.has(sessionId)) return sessionId;
    }
    return null;
  }

  /** Best session to talk to while nothing is paused (breakpoint sync, thread listing, stop). */
  private resolveFallbackSession(): vscode.DebugSession | null {
    const active =
      this.activeSessionId != null ? this.sessions.get(this.activeSessionId) : undefined;
    if (active) return this.findChildOf(active.id) ?? active;

    const latest =
      this.latestSessionId != null ? this.sessions.get(this.latestSessionId) : undefined;
    return latest ?? null;
  }

  /** First direct child of the given session, if js-debug spawned one for a target. */
  private findChildOf(sessionId: string): vscode.DebugSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.parentSession?.id === sessionId) return session;
    }
    return undefined;
  }

  /**
   * When attaching to an already-running session, detect whether any thread is
   * currently paused (e.g., stopped at a breakpoint). The DAP `stopped` event
   * fired before our tracker was registered, so we probe via `stackTrace` —
   * which only returns frames for paused threads per the DAP spec.
   */
  private async syncStoppedState(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      try {
        const threadsResponse = await session.customRequest("threads", {});
        const threads: Array<{ id: number }> = threadsResponse.threads ?? [];
        for (const thread of threads) {
          try {
            const stackResponse = await session.customRequest("stackTrace", {
              threadId: thread.id,
              startFrame: 0,
              levels: 1,
            });
            if (stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
              this.stoppedThreads.set(session.id, thread.id);
              break;
            }
          } catch {
            // Thread isn't paused — try the next one
          }
        }
      } catch {
        // Session can't answer 'threads' (a js-debug parent) — try the next one
      }
    }
  }

  /**
   * Returns the current debug state: inactive, running, or stopped (at breakpoint).
   */
  getState(): { state: string; threadId: number | null; sessionName: string | null } {
    const target = this.resolveTarget();
    const state =
      this.stoppedThreads.size > 0 ? "stopped" : this.sessions.size > 0 ? "running" : "inactive";
    return {
      state,
      threadId: target?.threadId ?? null,
      sessionName: target?.session.name ?? null,
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
    const target = this.resolveTarget();
    if (!target) {
      return { success: false };
    }
    // Stopping a js-debug child leaves the parent running, so stop the root.
    let root = target.session;
    while (root.parentSession) root = root.parentSession;
    await vscode.debug.stopDebugging(root);
    return { success: true };
  }

  /**
   * Sends a continue request to resume execution.
   */
  async continue_(): Promise<{ success: boolean; error?: string }> {
    return this.resume("continue");
  }

  /**
   * Steps over the next statement in the current function.
   */
  async stepOver(): Promise<{ success: boolean; error?: string }> {
    return this.resume("next");
  }

  /**
   * Steps into the next function call.
   */
  async stepInto(): Promise<{ success: boolean; error?: string }> {
    return this.resume("stepIn");
  }

  /**
   * Steps out of the current function.
   */
  async stepOut(): Promise<{ success: boolean; error?: string }> {
    return this.resume("stepOut");
  }

  /**
   * Pauses execution at the current point.
   */
  async pause(): Promise<{ success: boolean; error?: string }> {
    const target = this.resolveTarget();
    if (!target) {
      return { success: false, error: "No active debug session" };
    }
    try {
      await target.session.customRequest("pause", { threadId: target.threadId ?? 1 });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
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
    const target = this.resolveTarget();
    if (!target) {
      return { frames: [], error: "No active debug session" };
    }
    try {
      const response = await target.session.customRequest("stackTrace", {
        threadId: target.threadId ?? 1,
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
    const target = this.resolveTarget();
    if (!target) {
      return { variables: [], error: "No active debug session" };
    }
    try {
      // Get top frame if not specified
      let targetFrameId = frameId;
      if (targetFrameId === undefined) {
        const stackResponse = await target.session.customRequest("stackTrace", {
          threadId: target.threadId ?? 1,
          startFrame: 0,
          levels: 1,
        });
        targetFrameId = stackResponse.stackFrames?.[0]?.id;
        if (targetFrameId === undefined) {
          return { variables: [], error: "No stack frame available" };
        }
      }

      // Get scopes for the frame
      const scopesResponse = await target.session.customRequest("scopes", {
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
        const varsResponse = await target.session.customRequest("variables", {
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
    const target = this.resolveTarget();
    if (!target) {
      return { result: "", error: "No active debug session" };
    }
    try {
      let targetFrameId = frameId;
      if (targetFrameId === undefined) {
        const stackResponse = await target.session.customRequest("stackTrace", {
          threadId: target.threadId ?? 1,
          startFrame: 0,
          levels: 1,
        });
        targetFrameId = stackResponse.stackFrames?.[0]?.id;
      }

      const response = await target.session.customRequest("evaluate", {
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
    const target = this.resolveTarget();
    if (!target) {
      return { variables: [], error: "No active debug session" };
    }
    try {
      const response = await target.session.customRequest("variables", {
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
    const target = this.resolveTarget();
    if (!target) {
      return { threads: [], error: "No active debug session" };
    }
    try {
      const response = await target.session.customRequest("threads", {});
      return { threads: response.threads ?? [] };
    } catch (err) {
      return { threads: [], error: String(err) };
    }
  }

  /** Resumes the paused session and marks it running without waiting for the `continued` event. */
  private async resume(command: ResumeCommand): Promise<{ success: boolean; error?: string }> {
    const target = this.resolveTarget();
    if (!target) {
      return { success: false, error: "No active debug session" };
    }
    const sessionId = target.session.id;
    const pausedThread = this.stoppedThreads.get(sessionId);
    // Clear before sending, not after. A step that lands on the next breakpoint
    // can emit `stopped` before this request resolves, and clearing afterwards
    // would erase that fresh pause and leave the state stuck on "running".
    this.stoppedThreads.delete(sessionId);
    try {
      await target.session.customRequest(command, { threadId: target.threadId ?? 1 });
      return { success: true };
    } catch (err) {
      // The request never landed, so the session is still paused where it was —
      // unless a newer `stopped` already recorded a more accurate thread.
      if (pausedThread !== undefined && !this.stoppedThreads.has(sessionId)) {
        this.stoppedThreads.set(sessionId, pausedThread);
      }
      return { success: false, error: String(err) };
    }
  }
}
