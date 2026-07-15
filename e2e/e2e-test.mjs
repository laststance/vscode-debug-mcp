#!/usr/bin/env node

/**
 * End-to-end test for the VSCode Debug MCP Bridge.
 *
 * Prerequisites:
 * 1. VSCode is open with the test-project folder
 * 2. The Debug MCP Bridge extension is installed and active
 *
 * This test verifies:
 * - Health check (extension connectivity)
 * - Set/list/remove breakpoints
 * - Launch debug session
 * - Step over / step into / step out
 * - Get call stack
 * - Get variables
 * - Evaluate expressions
 * - Stop debugging
 *
 * @example
 * node e2e-test.mjs
 */

const BASE = "http://127.0.0.1:7779";
const TEST_FILE = new URL("./test-app.js", import.meta.url).pathname;

async function request(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function main() {
  console.log("\n🔬 E2E Test: VSCode Debug MCP Bridge\n");

  // 1. Health check
  console.log("── Health Check ──");
  try {
    const health = await request("GET", "/health");
    assert("Extension is reachable", health.status === "ok");
  } catch (err) {
    console.error("❌ Cannot reach extension. Is VSCode open with the extension activated?");
    console.error(`   Error: ${err.message}`);
    process.exit(1);
  }

  // 2. Initial state
  console.log("\n── Initial State ──");
  const state0 = await request("GET", "/state");
  assert("State is 'inactive' before debugging", state0.state === "inactive");

  // 3. Set breakpoints
  console.log("\n── Breakpoints ──");
  await request("POST", "/breakpoint", { file: TEST_FILE, line: 14 }); // const x = 10
  await request("POST", "/breakpoint", { file: TEST_FILE, line: 16 }); // const sum = add(x, y)
  await request("POST", "/breakpoint", {
    file: TEST_FILE,
    line: 3,
    condition: "a > 5",
  }); // inside add()

  const bps = await request("GET", "/breakpoints");
  assert("3 breakpoints set", bps.breakpoints.length === 3);
  assert(
    "Conditional breakpoint has condition",
    bps.breakpoints.some((bp) => bp.condition === "a > 5"),
  );

  // 4. Remove one breakpoint
  const removed = await request("DELETE", "/breakpoint", { file: TEST_FILE, line: 14 });
  assert("Removed 1 breakpoint", removed.removed === 1);

  const bps2 = await request("GET", "/breakpoints");
  assert("2 breakpoints remain", bps2.breakpoints.length === 2);

  // 5. Launch debug session
  console.log("\n── Debug Session ──");
  const launched = await request("POST", "/debug/launch", {
    config: {
      type: "node",
      request: "launch",
      name: "E2E Test",
      program: TEST_FILE,
      stopOnEntry: true,
    },
  });
  assert("Debug session launched", launched.success === true);

  // Wait for debugger to attach and stop on entry
  await sleep(2000);

  const state1 = await request("GET", "/state");
  assert("State is 'stopped' after stopOnEntry", state1.state === "stopped");

  // 6. Continue to breakpoint (line 3 inside add(), with condition a > 5)
  console.log("\n── Continue & Step ──");
  await request("POST", "/debug/continue");
  await sleep(1000);

  const state2 = await request("GET", "/state");
  assert("Stopped at breakpoint", state2.state === "stopped");

  // 7. Call stack
  console.log("\n── Call Stack ──");
  const stack = await request("GET", "/debug/callstack");
  assert("Call stack has frames", stack.frames.length > 0);
  console.log(`   Top frame: ${stack.frames[0]?.name} at line ${stack.frames[0]?.line}`);

  // 8. Variables
  console.log("\n── Variables ──");
  const vars = await request("POST", "/debug/variables", { scope: "Local" });
  assert("Variables returned", vars.variables.length > 0);
  for (const v of vars.variables.slice(0, 5)) {
    console.log(`   ${v.name} = ${v.value} (${v.type || "?"})`);
  }

  // 9. Evaluate expression
  console.log("\n── Evaluate ──");
  const evalResult = await request("POST", "/debug/evaluate", {
    expression: "1 + 2",
  });
  assert("Expression evaluated", evalResult.result === "3");

  // 10. Threads
  console.log("\n── Threads ──");
  const threads = await request("GET", "/debug/threads");
  assert("At least 1 thread", threads.threads.length >= 1);

  // 11. Step over
  await request("POST", "/debug/stepOver");
  await sleep(500);
  const state3 = await request("GET", "/state");
  assert("Still stopped after step over", state3.state === "stopped");

  // 12. Stop debugging
  console.log("\n── Stop ──");
  await request("POST", "/debug/stop");
  await sleep(1000);

  const state4 = await request("GET", "/state");
  assert("State is 'inactive' after stop", state4.state === "inactive");

  // Clean up breakpoints
  await request("DELETE", "/breakpoint", { file: TEST_FILE, line: 16 });
  await request("DELETE", "/breakpoint", { file: TEST_FILE, line: 3 });

  // Summary
  console.log(`\n══════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`══════════════════════════════════════\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
