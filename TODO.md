# TODO

VSCode Debug MCP Bridge の改善タスク。

## 直近の修正(参考)

`vscode-extension/src/debug-controller.ts` の `activate()` で、拡張が後から activate されたケースに対応。
`vscode.debug.activeDebugSession` を読んで `this.session` を初期化し、`syncStoppedState()` で
DAP `stackTrace` を probe して停止中スレッドを検出するようにした。

---

## 1. 既存セッションの `stopped` / `continued` イベント取り逃し

### 症状

`activate()` 時点で既に走っているデバッグセッションに対して、後続の `stopped` / `continued`
イベントが拾えない。`registerDebugAdapterTrackerFactory` の `createDebugAdapterTracker` は
**新規セッション**にしか呼ばれないため、既存セッションのイベントは tracker を通らない。

### 影響

初回 sync 後にユーザーが VSCode UI 経由で step / continue した場合、
MCP 側の `state` / `stoppedThreadId` が更新されず、古い状態が残る。

### 対応案

- **案 A:** `vscode.debug.activeStackItem` を polling して停止状態を検出(VSCode 1.85+)
- **案 B:** 各 step 系 API 実行後に `syncStoppedState()` を再実行して self-correct
- **案 C:** DAP の `setBreakpointsResponse` 後の `stopped` イベントを別経路で監視

### 関連ファイル

- `vscode-extension/src/debug-controller.ts` — `activate()`, `syncStoppedState()`

---

## 2. 複数デバッグセッション対応

### 症状

Next.js は server / client / edge runtime で複数のデバッグセッションを spawn することがあり、
現状は `vscode.debug.activeDebugSession`(現フォーカスのみ)しか追跡していない。

### 影響

ユーザーが別セッションにフォーカスを切り替えると、MCP 側のセッション参照が変わり、
ブレークポイントを設定したセッションと違うセッションで step が動く可能性がある。

### 対応案

- `vscode.debug.sessions` で全セッションを列挙し、各セッションの状態を `Map<sessionId, State>` で保持
- MCP API に `sessionId` パラメータを追加(オプショナル、省略時は active を使う)
- `onDidChangeActiveDebugSession` で active 変更を追跡

### 関連ファイル

- `vscode-extension/src/debug-controller.ts` — `session` プロパティを Map に変更
- `mcp-server/src/` — ツール定義に `sessionId` パラメータを追加

---

## 3. E2E テスト追加

### 症状

「拡張が後から activate されるケース」「セッション既存時の sync」を検証するテストがない。
今回のバグは既存テストを通過していた。

### 影響

同じクラスの regression が今後発生しても気付けない。

### 対応案

`e2e/` に以下のシナリオを追加:

1. デバッグセッション開始
2. ブレークポイントで停止
3. 拡張を Disable → Enable で再 activate
4. `get_debug_state` が `stopped` を返すこと
5. `step_over` が成功すること

### 関連ファイル

- `e2e/` — 新規テストファイル
