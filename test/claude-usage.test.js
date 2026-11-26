// E02 manual reader (FIXTURE): `r` on Claude runs Claude Code `/usage` once and reads its `usage_report`
// (Agent SDK SDKUsageReport). A fake `claude` (a shell script in a temporary folder, found through
// OPENCODE_CLAUDE_PATH) or an injected launcher stands in for the binary; no Claude Code, account or network is used.
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { USAGE_ARGS, USAGE_SOURCE, claudeBinary, createUsageReader, parseUsageReport, usageEnv } from "../claude.js"
import { refKey } from "../inventory.js"
import { createPlugin } from "../server.js"
import { batchRefs, modalRows } from "../view.js"
import { call, contract, fakeHost, settle } from "./host.js"

const HOUR = 3_600_000
const iso = (ms) => new Date(ms).toISOString()
const row = (kind, percent, resets, extra = {}) => ({ kind, group: kind === "session" ? "session" : "weekly", percent,
  resets_at: resets, severity: "normal", is_active: kind === "session", ...extra })
const limitsAt = (now, five = 37, seven = 55) => [row("session", five, iso(now + 2 * HOUR)), row("weekly_all", seven, iso(now + 72 * HOUR)),
  row("weekly_scoped", 99, iso(now + 72 * HOUR), { scope: { model: { display_name: "Synthetic" } } })]
// The stream-json lines of a `/usage` answer: init, the assistant message with the report, the result.
function stream({ limits, rate = limits === null ? null : { limits }, cost = 0, tokens = 0, report = true, isError = false, extra = [] } = {}) {
  const assistant = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "synthetic usage" }],
    usage: { input_tokens: tokens, output_tokens: 0 } }, session_id: "syn" }
  if (report) assistant.usage_report = { session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 1, total_lines_added: 0,
    total_lines_removed: 0, model_usage: {} }, rate_limits: rate }
  return [{ type: "system", subtype: "init", session_id: "syn" }, assistant, ...extra,
    { type: "result", subtype: "success", is_error: isError, total_cost_usd: cost, usage: { input_tokens: 0, output_tokens: 0 }, num_turns: 1 }]
    .map((line) => JSON.stringify(line)).join("\n") + "\n"
}

test("E02 /usage parser: session → 5 h, weekly_all → weekly, weekly_scoped ignored; validated percent and ISO reset", () => {
  const now = Date.UTC(2026, 10, 25, 12)
  assert.deepEqual(parseUsageReport(stream({ limits: limitsAt(now) }), now), { samples: [
    { window: "5h", scope: "general", observedAt: now, used: 37, resetsAt: now + 2 * HOUR },
    { window: "weekly", scope: "general", observedAt: now, used: 55, resetsAt: now + 72 * HOUR }] })
  assert.deepEqual(parseUsageReport(stream({ limits: [row("session", 100, iso(now + HOUR))] }), now).samples.map((s) => s.used), [100],
    "no quota left: the report still comes, 100% used")
  assert.deepEqual(parseUsageReport(stream({ limits: null }), now), { samples: [] }, "rate_limits null: no data")
  assert.deepEqual(parseUsageReport(stream({ rate: { limits: null } }), now), { samples: [] })
  for (const bad of [row("session", 101, null), row("session", -1, null), row("session", "50", null), row("session", 5, "tomorrow"),
    row("session", 5, "2026-11-25"), row("session", 5, iso(now + 7 * HOUR)), row("session", 5, iso(now - HOUR))]) {
    assert.deepEqual(parseUsageReport(stream({ limits: [bad, row("weekly_all", 1, null)] }), now).samples.map((s) => s.window), ["weekly"], JSON.stringify(bad))
  }
  assert.deepEqual(parseUsageReport(stream({ limits: [row("session", 5, null), row("session", 6, null)] }), now), { samples: [] }, "contradiction")
})

test("E02 /usage parser: malformed output, no usage_report and any sign of a model turn are failures, never figures", () => {
  const now = Date.now()
  const limits = limitsAt(now)
  assert.deepEqual(parseUsageReport("not json\n", now), { reason: "invalid" })
  assert.deepEqual(parseUsageReport(stream({ limits }).replace(/\n$/, "\n{trunc"), now), { reason: "invalid" })
  assert.deepEqual(parseUsageReport("", now), { reason: "invalid" })
  assert.deepEqual(parseUsageReport(stream({ limits, report: false }), now), { reason: "invalid" }, "an unrecognized /usage")
  assert.deepEqual(parseUsageReport(stream({ limits, isError: true }), now), { reason: "invalid" })
  assert.deepEqual(parseUsageReport(stream({ rate: { limits: "x" } }), now), { reason: "invalid" })
  assert.deepEqual(parseUsageReport(stream({ limits, cost: 0.01 }), now), { reason: "model" }, "cost > 0")
  assert.deepEqual(parseUsageReport(stream({ limits, tokens: 12 }), now), { reason: "model" }, "tokens > 0")
  assert.deepEqual(parseUsageReport(stream({ limits, extra: [{ type: "stream_event", event: {} }] }), now), { reason: "model" })
  assert.deepEqual(parseUsageReport(stream({ limits, report: false, cost: 0.2 }), now), { reason: "model" })
})

test("E02 /usage: binary and environment resolved as OpenCode 2.4.1's claude-agent", () => {
  assert.equal(claudeBinary({ OPENCODE_CLAUDE_PATH: "/opt/claude", PATH: "/usr/bin" }), "/opt/claude")
  assert.equal(claudeBinary({ PATH: "/nonexistent-ai" }), undefined)
  const env = { PATH: "/usr/bin", CLAUDE_CODE_SIMPLE: "1", KEEP: "x" }
  assert.deepEqual(usageEnv(undefined, { env, home: "/h" }), { PATH: "/usr/bin", KEEP: "x" })
  assert.deepEqual(usageEnv("~/.claude", { env, home: "/h" }), { PATH: "/usr/bin", KEEP: "x" }, "default folder left to Claude Code")
  assert.equal(usageEnv("~/.claude", { env: { CLAUDE_CONFIG_DIR: "/h/.claude/" }, home: "/h" }).CLAUDE_CONFIG_DIR, "/h/.claude")
})

// A plugin with the manual reader on a fake `claude`, plus its folder of traces (argv, cwd, runs).
async function start({ output = (now) => stream({ limits: limitsAt(now) }), connections = [{ type: "credential", id: "cl-1", label: "ALIAS", method: "external" }],
  providers = {}, timeout = 5_000, sleep = false, exit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ai-usage-test-"))
  const fake = join(root, "claude")
  writeFileSync(join(root, "out"), output(Date.now()))
  writeFileSync(fake, `#!/bin/sh\nd=${JSON.stringify(root)}\npwd > "$d/cwd"\nfor a in "$@"; do printf '[%s]\\n' "$a"; done > "$d/argv"\necho run >> "$d/runs"\n` +
    (sleep ? "sleep 30\n" : "") + `cat "$d/out"\nexit ${exit}\n`)
  chmodSync(fake, 0o700)
  const temp = join(root, "tmp")
  mkdirSync(temp)
  const system = { env: { OPENCODE_CLAUDE_PATH: fake, PATH: "/usr/bin:/bin" }, home: "/home/lab", tmp: temp }
  const host = fakeHost({ integrations: [{ id: "claude-agent", name: "Claude Agent", methods: [], connections }],
    active: { "claude-agent": { type: "credential", id: "cl-1" } }, providers, sessions: { "ses-1": "/work/a" } })
  host.ctx.options = { experimentalClaudeUsage: true }
  const plugin = createPlugin({ contract, claude: createUsageReader({ system, timeout }), system })
  let stop = await plugin.setup(host.ctx)
  const runs = () => (existsSync(join(root, "runs")) ? readFileSync(join(root, "runs"), "utf8").split("\n").filter(Boolean).length : 0)
  const refresh = (manual = true) => host.handlers.refresh({ integrationID: "claude-agent", connectionID: "cl-1", ...(manual ? { manual } : {}) }, call())
  const claude = async () => (await host.handlers.snapshot({}, call())).integrations.find((i) => i.id === "claude-agent")
  const lab = { host, root, temp, runs, refresh, claude,
    plugin: { setup: async (ctx) => { stop = await plugin.setup(ctx) } },
    stop: () => stop(),
    done: async () => {
      await stop()
      rmSync(root, { recursive: true, force: true })
    } }
  return lab
}

test("E02 /usage: no process when the view opens, reloads, on a turn end or on load", async () => {
  const lab = await start()
  const before = await lab.claude()
  assert.equal(before.refreshable && before.manual && before.passive, true)
  assert.equal((await lab.refresh(false)).status, "unsupported", "an automatic read (view opening) is refused")
  lab.host.events.push({ id: "e1", type: "session.step.started", created: Date.now(), data: { sessionID: "ses-1", assistantMessageID: "m1", model: { providerID: "claude-agent" } } })
  lab.host.events.push({ id: "e2", type: "session.step.ended", created: Date.now(), data: { sessionID: "ses-1", assistantMessageID: "m1", native: {} } })
  lab.host.events.push({ id: "e3", type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses-1" } })
  await settle()
  await lab.stop()
  await lab.plugin.setup(lab.host.ctx) // reload
  await lab.claude()
  assert.equal(lab.runs(), 0, "opening, reloading and turn ends start nothing")
  await lab.done()
})

test("E02 /usage: Refresh all with Claude alone runs once, removes its folder and attributes the figures to Claude", async () => {
  const lab = await start()
  const refs = batchRefs(await lab.host.handlers.snapshot({}, call()))
  const results = await Promise.all(refs.map((ref) => lab.host.handlers.refresh({ ...ref, manual: true }, call())))
  assert.deepEqual(results.map((r) => r.status), ["read"])
  assert.equal(lab.runs(), 1)
  assert.deepEqual(readFileSync(join(lab.root, "argv"), "utf8").trim().split("\n"), USAGE_ARGS.map((a) => `[${a}]`))
  const cwd = readFileSync(join(lab.root, "cwd"), "utf8").trim()
  assert.ok(cwd.startsWith(join(lab.temp, "account-quota-usage-")), cwd)
  assert.equal(existsSync(cwd), false, "the temporary folder is gone")
  assert.deepEqual(readdirSync(lab.temp), [])
  const claude = await lab.claude()
  assert.deepEqual(claude.connections[0].samples.map((s) => [s.source, s.window, s.used]), [[USAGE_SOURCE, "5h", 37], [USAGE_SOURCE, "weekly", 55]])
  const lines = modalRows({ schema: 2, revision: 0, scope: "personal-server", inventory: "available", preferences: { state: "unavailable" }, integrations: [claude] },
    { now: Date.now(), cursor: refKey("claude-agent", "cl-1"), width: 84 }).map((r) => r.text).join("\n")
  assert.match(lines, /^✻ Claude *$/m, "titled by the profile")
  assert.equal(lines.includes("ALIAS"), false)
  assert.equal(lines.split("Source        Claude Code /usage").length - 1, 1)
  assert.equal(lines.includes("Claude Code turns"), false, "one source")
  assert.deepEqual(lab.host.record.resolved, [], "no credential is resolved")
  // A newer passive sample of a window wins over the older /usage one.
  lab.host.events.push({ id: "p1", type: "session.step.started", created: Date.now() + 5, data: { sessionID: "ses-1", assistantMessageID: "m9", model: { providerID: "claude-agent" } } })
  lab.host.events.push({ id: "p2", type: "session.step.ended", created: Date.now() + 5, location: { directory: "/work/a" },
    data: { sessionID: "ses-1", assistantMessageID: "m9", native: { rateLimit: { rateLimitType: "five_hour", utilization: 0.5 } } } })
  await settle()
  const mixed = (await lab.claude()).connections[0].samples.map((s) => [s.source, s.window, s.used])
  assert.deepEqual(mixed.sort(), [["claude-turns", "5h", 50], [USAGE_SOURCE, "weekly", 55]])
  assert.equal(lab.runs(), 1, "the turn end started nothing")
  await lab.done()
})

test("E02 /usage: 100% used shows with its reset; rate_limits null is No data without a failure", async () => {
  const full = await start({ output: (now) => stream({ limits: [row("session", 100, iso(now + HOUR)), row("weekly_all", 100, iso(now + 24 * HOUR))] }) })
  assert.equal((await full.refresh()).status, "read")
  const claude = await full.claude()
  const text = modalRows({ schema: 2, revision: 0, scope: "personal-server", inventory: "available", preferences: { state: "unavailable" }, integrations: [claude] },
    { now: Date.now(), cursor: refKey("claude-agent", "cl-1"), width: 84 }).map((r) => r.text).join("\n")
  for (const window of ["5 h", "Weekly"]) {
    assert.match(text, new RegExp(`^${window} +█+ 100% used\\n +Resets \\S`, "m"), "a full bar with its own renewal")
  }
  await full.done()

  const none = await start({ output: () => stream({ limits: null }) })
  assert.equal((await none.refresh()).status, "read")
  const empty = (await none.claude()).connections[0]
  assert.equal(empty.samples, undefined)
  assert.equal(empty.failure, undefined)
  await none.done()
})

test("E02 /usage: malformed, unrecognized, costly or failed runs record a failure and no figure", async () => {
  for (const [output, reason, exit] of [[() => "garbage\n", "invalid"], [(now) => stream({ limits: limitsAt(now), report: false }), "invalid"],
    [(now) => stream({ limits: limitsAt(now), cost: 0.5 }), "model"], [(now) => stream({ limits: limitsAt(now) }), "exit", 1]]) {
    const lab = await start({ output, exit })
    assert.equal((await lab.refresh()).status, "failed")
    const connection = (await lab.claude()).connections[0]
    assert.equal(connection.samples, undefined, reason)
    assert.equal(connection.failure.reason, reason)
    assert.equal((await lab.refresh()).status, "deferred", "no retry: the scheduler's backoff applies")
    assert.equal(lab.runs(), 1)
    await lab.done()
  }
})

test("E02 /usage: a run past the timeout is killed and its folder removed", async () => {
  const lab = await start({ sleep: true, timeout: 300 })
  const started = Date.now()
  assert.equal((await lab.refresh()).status, "failed")
  assert.ok(Date.now() - started < 5_000)
  assert.equal((await lab.claude()).connections[0].failure.reason, "timeout")
  assert.deepEqual(readdirSync(lab.temp), [])
  await lab.done()
})

test("E02 /usage: without the single signed-in ~/.claude profile nothing is launched", async () => {
  const two = [{ type: "credential", id: "cl-1", label: "A", method: "external" }, { type: "credential", id: "cl-2", label: "B", method: "external" }]
  for (const [options, expected] of [[{ connections: two }, "profile"], [{ providers: { "claude-agent": { settings: { configDir: ["~/.claude", "~/.claude-b"] } } } }, "profile"],
    [{ providers: { "claude-agent": { settings: { apiKey: "x" } } } }, "profile"]]) {
    const lab = await start(options)
    assert.equal((await lab.refresh()).status, "failed")
    assert.equal(lab.runs(), 0)
    await lab.done()
  }
  const waiting = await start({ connections: [{ type: "credential", id: "cl-1", label: "A", method: "external", status: { status: "needs_auth" } }] })
  assert.equal((await waiting.refresh()).status, "unsupported", "needs_auth: Sign in again, no process")
  assert.equal(waiting.runs(), 0)
  await waiting.done()
})

test("E02 /usage: at most one process at a time; unloading the plugin kills it", async () => {
  const children = []
  const launch = (bin, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.killed = []
    child.kill = (signal) => {
      child.killed.push(signal)
      setImmediate(() => child.emit("close", null))
    }
    children.push({ bin, args, options, child })
    return child
  }
  const temp = mkdtempSync(join(tmpdir(), "ai-usage-launch-"))
  const system = { env: { OPENCODE_CLAUDE_PATH: "/fake/claude" }, home: "/home/lab", tmp: temp }
  const reader = createUsageReader({ launch, system, timeout: 10_000 })
  const host = fakeHost({ integrations: [{ id: "claude-agent", connections: [{ type: "credential", id: "cl-1", label: "A", method: "external" }] }] })
  const signal = new AbortController()
  const first = reader.read({ ctx: host.ctx, connection: { id: "cl-1" }, signal: signal.signal })
  await settle(20)
  await assert.rejects(reader.read({ ctx: host.ctx, connection: { id: "cl-1" }, signal: new AbortController().signal }), { reason: "busy" })
  assert.equal(children.length, 1)
  assert.deepEqual(children[0].args, [...USAGE_ARGS])
  assert.deepEqual(children[0].options.stdio, ["ignore", "pipe", "ignore"])
  assert.equal(children[0].options.env.OPENCODE_CLAUDE_PATH, "/fake/claude", "the environment is inherited, nothing added")
  signal.abort()
  await assert.rejects(first, { reason: "cancelled" })
  assert.deepEqual(children[0].child.killed, ["SIGKILL"])
  assert.deepEqual(readdirSync(temp), [])
  rmSync(temp, { recursive: true, force: true })

  // Through the plugin: unloading the last instance aborts the run in flight.
  const root = mkdtempSync(join(tmpdir(), "ai-usage-unload-"))
  const plugin = createPlugin({ contract, claude: createUsageReader({ launch, system: { ...system, tmp: root } }), system })
  host.ctx.options = { experimentalClaudeUsage: true }
  const stop = await plugin.setup(host.ctx)
  const pending = host.handlers.refresh({ integrationID: "claude-agent", connectionID: "cl-1", manual: true }, call())
  await settle(20)
  assert.equal(children.length, 2)
  await stop()
  assert.equal(await pending.then((r) => r.status), "failed")
  assert.deepEqual(children[1].child.killed, ["SIGKILL"])
  assert.deepEqual(readdirSync(root), [])
  rmSync(root, { recursive: true, force: true })
})
