// E02 (FIXTURE, T32): Claude Code plan usage read passively from the step events of the user's own claude-agent turns
// (OpenCode 2.4.1 copies the Agent SDK's last rate_limit_event of a step to `session.step.ended` as native.rateLimit).
// Synthetic events, inventory, provider settings and clock; no Claude Code, network or credential is involved.
import assert from "node:assert/strict"
import { test } from "node:test"
import { isDefaultProfile, parseRateLimit, profileDirs } from "../claude.js"
import { refKey } from "../inventory.js"
import { createPlugin } from "../server.js"
import { compactLine, modalRows, NO_REFRESH, staleRefs } from "../view.js"
import { call, contract, fakeHost, settle } from "./host.js"

const MARK = "SYNTHETIC-MARK-E02"
const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 10, 25, 12)
const S = (ms) => Math.floor(ms / 1000) // Unix seconds, as the SDK sends resets
const system = { env: {}, home: "/home/lab" }
// The route subscriptions (rotation plan R4), always present; they act only for sessions set to preview.
const ROUTE = [["session.step.started", "session.execution.started", "session.execution.succeeded", "session.execution.failed"],
  ["session.model.selected"]]
const login = (id = "cl-1", label = "TURING", extra = {}) => ({ type: "credential", id, label, method: "external", ...extra })
const text = (rows) => rows.map((row) => row.text.trimEnd()).filter((line) => line !== "")
const detailOf = (rows) => text(rows.filter((row) => row.zone === "detail" && !row.rule))
const listOf = (rows) => text(rows.filter((row) => row.zone !== "detail"))

// The shape OpenCode 2.4.1 recorded from Claude Code 2.1.30x (test fixtures `controls.jsonl`, `websearch.jsonl`):
// utilization only under unifiedWindows, resets in Unix seconds.
const recorded = (windows, type = "five_hour") => ({
  status: "allowed", resetsAt: windows[type]?.resetsAt, rateLimitType: type, overageStatus: "rejected",
  overageDisabledReason: "org_level_disabled", isUsingOverage: false, unifiedWindows: windows,
})
const both = (five = 0.42, seven = 0.61) => recorded({
  five_hour: { utilization: five, resetsAt: S(T0 + 2 * HOUR) },
  seven_day: { utilization: seven, resetsAt: S(T0 + 3 * DAY), status: "allowed" },
})

async function start({ claude = true, connections = [login()], providers = {}, clock = { now: T0 }, instances = 1, options = {} } = {}) {
  const host = fakeHost({
    integrations: [
      { id: "claude-agent", name: "Claude Agent", methods: [], connections },
      { id: "anthropic", name: "Anthropic", methods: [], connections: [{ type: "credential", id: "an-1", label: "API", method: "key" }] },
      { id: "deepseek", name: "DeepSeek", methods: [], connections: [{ type: "credential", id: "ds-1", label: "Main", method: "key" }] },
    ],
    active: { "claude-agent": connections[0] && { type: "credential", id: connections[0].id }, anthropic: { type: "credential", id: "an-1" } },
    credentials: { "an-1": { type: "key", key: `${MARK}-key` }, "ds-1": { type: "key", key: `${MARK}-ds` } },
    providers,
    sessions: { "ses-1": "/work/session-a" },
  })
  host.ctx.options = { ...(claude ? { experimentalClaudeUsage: true } : {}), ...options }
  const plugin = createPlugin({ contract, now: () => clock.now, system })
  const stops = []
  for (let i = 0; i < instances; i += 1) stops.push(await plugin.setup(host.ctx))
  let n = 0
  // One step of the user's turn: its start names the model's provider, its end carries the provider metadata. 2.4.1
  // delivers session events without a location (`located: false`); with one, it is the step's own.
  const turn = async (providerID, rateLimit, { message = `msg-${n}`, created = clock.now, native, extra = {}, session = "ses-1", located = true } = {}) => {
    n += 1
    const base = { sessionID: session, assistantMessageID: message }
    const where = located ? { location: { directory: "/work/a" } } : {}
    host.events.push({ id: `evt-${n}-a`, type: "session.step.started", created, ...where,
      data: { ...base, agent: "build", model: { id: "sonnet", providerID }, started: created } })
    host.events.push({ id: `evt-${n}-b`, type: "session.step.ended", created, ...where, ...extra,
      data: { ...base, finish: "stop", native: native ?? (rateLimit === undefined ? undefined : { rateLimit }), cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } })
    await settle()
  }
  const snapshot = () => host.handlers.snapshot({}, call())
  const claudeOf = async () => (await snapshot()).integrations.find((item) => item.id === "claude-agent")
  const samples = async () => ((await claudeOf())?.connections ?? []).flatMap((c) => (c.samples ?? []).map((s) => [c.id, s.window, s.used]))
  const stop = async () => { for (const s of stops.reverse()) await s() }
  return { host, clock, turn, snapshot, claudeOf, samples, stop }
}

test("E02 parser: the shape OpenCode 2.4.1 recorded and the documented one give 5 h and weekly, utilization 0–1 as % used", () => {
  assert.deepEqual(parseRateLimit(recorded({ five_hour: { utilization: 0.05, resetsAt: S(T0 + HOUR) } }), T0),
    [{ window: "5h", scope: "general", observedAt: T0, used: 5, resetsAt: T0 + HOUR }])
  assert.deepEqual(parseRateLimit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.68, resetsAt: S(T0 + 3 * DAY) }, T0),
    [{ window: "weekly", scope: "general", observedAt: T0, used: 68, resetsAt: T0 + 3 * DAY }], "documented fields, float noise removed")
  assert.deepEqual(parseRateLimit(both(), T0).map((s) => [s.window, s.used, s.resetsAt]), [["5h", 42, T0 + 2 * HOUR], ["weekly", 61, T0 + 3 * DAY]])
  const same = { rateLimitType: "five_hour", utilization: 0.42, resetsAt: S(T0 + 2 * HOUR), ...both() }
  assert.equal(parseRateLimit(same, T0).filter((s) => s.window === "5h").length, 1, "the same figure twice is one sample")
  assert.equal(parseRateLimit({ rateLimitType: "five_hour", utilization: 0 }, T0)[0].used, 0, "a real 0 is kept")
  assert.equal(parseRateLimit({ rateLimitType: "five_hour", utilization: 1 }, T0)[0].used, 100)
  assert.equal(parseRateLimit({ rateLimitType: "seven_day", utilization: 0.5, resetsAt: S(T0 + 7 * DAY) }, T0).length, 1, "a week ahead is valid")
})

test("E02 parser: unknown and model-family windows, missing or invalid utilization and invalid resets give no figure, never 0", () => {
  for (const type of ["seven_day_opus", "seven_day_sonnet", "overage", "ten_day", "", "__proto__", "constructor"]) {
    assert.equal(parseRateLimit({ rateLimitType: type, utilization: 0.5 }, T0), undefined, type)
    assert.equal(parseRateLimit({ unifiedWindows: { [type]: { utilization: 0.5 } } }, T0), undefined, type)
  }
  for (const utilization of [1.01, -0.01, 42, NaN, Infinity, "0.5", true, {}]) {
    assert.equal(parseRateLimit({ rateLimitType: "five_hour", utilization }, T0), undefined, String(utilization))
  }
  for (const info of [{ rateLimitType: "five_hour" }, { rateLimitType: "five_hour", utilization: null, resetsAt: S(T0 + HOUR) },
    { status: "rejected", rateLimitType: "seven_day", resetsAt: S(T0 + DAY) }, { unifiedWindows: { five_hour: { resetsAt: S(T0 + HOUR) } } },
    { unifiedWindows: [] }, null, "five_hour", [], {}]) {
    assert.equal(parseRateLimit(info, T0), undefined, JSON.stringify(info))
  }
  // Resets: Unix seconds after the observation and within the window's span (plus an hour of skew).
  for (const resetsAt of ["soon", S(T0) - 1, S(T0), S(T0 + 6 * HOUR) + 1, T0 + HOUR /* milliseconds */, NaN, -1]) {
    assert.equal(parseRateLimit({ rateLimitType: "five_hour", utilization: 0.5, resetsAt }, T0), undefined, String(resetsAt))
  }
  // A contradiction or an invalid value drops that window only.
  const mixed = { rateLimitType: "five_hour", utilization: 0.3, unifiedWindows: { five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.9, resetsAt: S(T0 + DAY) } } }
  assert.deepEqual(parseRateLimit(mixed, T0).map((s) => [s.window, s.used]), [["weekly", 90]])
  assert.deepEqual(parseRateLimit({ unifiedWindows: { five_hour: { utilization: 2 }, seven_day: { utilization: 0.2 } } }, T0).map((s) => s.window), ["weekly"])
})

test("E02 profile: only the single ~/.claude folder, derived as OpenCode 2.4.1 does", () => {
  const sys = { env: {}, home: "/home/u" }
  assert.deepEqual(profileDirs(undefined, sys), ["/home/u/.claude"])
  for (const value of [undefined, "~/.claude", ["~/.claude"], "/home/u/.claude/", "/home/u/x/../.claude", [42, "~/.claude"]]) {
    assert.equal(isDefaultProfile(value, sys), true, JSON.stringify(value))
  }
  for (const value of ["~/.claude-work", ["~/.claude", "~/.claude-b"], ["~/.claude", "~/.claude"], "/srv/claude", "~/", ".claude"]) {
    assert.equal(isDefaultProfile(value, sys), false, JSON.stringify(value))
  }
  assert.equal(isDefaultProfile(undefined, { env: { CLAUDE_CONFIG_DIR: "/srv/other" }, home: "/home/u" }), false, "Claude Code would run that folder")
  assert.equal(isDefaultProfile(undefined, { env: { CLAUDE_CONFIG_DIR: "/home/u/.claude" }, home: "/home/u" }), true)
})

test("E02: a claude-agent step with 5 h and weekly windows is recorded under the single Claude login, passively", async () => {
  const lab = await start()
  assert.deepEqual(lab.host.record.subscribed, [["credential.updated", "credential.switched", "integration.updated"],
    ["session.step.started", "session.step.ended"], ...ROUTE], "the step events only with the option on, in their own subscription")
  const before = await lab.claudeOf()
  assert.deepEqual(before, { id: "claude-agent", active: "connection", refreshable: false, passive: true,
    connections: [{ id: "cl-1", label: "TURING", method: "external", active: true }] }, "flagged passive; nothing until a turn")
  await lab.turn("claude-agent", both())
  const after = await lab.claudeOf()
  assert.deepEqual(after.connections[0].samples, [
    { source: "claude-turns", window: "5h", scope: "general", observedAt: T0, used: 42, resetsAt: T0 + 2 * HOUR },
    { source: "claude-turns", window: "weekly", scope: "general", observedAt: T0, used: 61, resetsAt: T0 + 3 * DAY },
  ])
  assert.equal(lab.host.record.emitted.length, 1, "one `changed` so open views reload")
  assert.deepEqual(lab.host.record.providers, [{ providerID: "claude-agent", location: { directory: "/work/a" } }],
    "the profile folder is checked for the location that ran the step")
  assert.deepEqual(lab.host.record.resolved, [], "no credential is resolved")
  assert.equal((await lab.host.handlers.refresh({ integrationID: "claude-agent", connectionID: "cl-1" }, call())).status, "unsupported",
    "nothing to read on request")
  await lab.stop()
})

test("E02: anthropic (API key) and other providers are ignored, and so are step ends without a seen claude-agent start", async () => {
  const lab = await start()
  await lab.turn("anthropic", both(0.99, 0.99))
  await lab.turn("openai", both(0.99, 0.99))
  // A step end whose start was not seen (the plugin loaded mid-step), or that names another message.
  lab.host.events.push({ id: "lone", type: "session.step.ended", created: T0, data: { sessionID: "ses-1", assistantMessageID: "never-started", finish: "stop", native: { rateLimit: both() } } })
  await settle()
  assert.deepEqual(await lab.samples(), [])
  assert.equal(JSON.stringify(await lab.snapshot()).includes("claude-turns"), false, "no sample anywhere")
  assert.deepEqual(lab.host.record.providers, [], "nothing to attribute: the profile is not even checked")
  // The same rate-limit object on a claude-agent step is recorded.
  await lab.turn("claude-agent", both(0.99, 0.99))
  assert.deepEqual(await lab.samples(), [["cl-1", "5h", 99], ["cl-1", "weekly", 99]])
  await lab.stop()
})

test("E02: with the option off nothing listens to turns and no Claude figure is shown", async () => {
  const lab = await start({ claude: false })
  assert.deepEqual(lab.host.record.subscribed, [["credential.updated", "credential.switched", "integration.updated"], ...ROUTE],
    "no step-end subscription; the route subscriptions (R4) evaluate only sessions set to preview")
  await lab.turn("claude-agent", both())
  const claude = await lab.claudeOf()
  assert.equal(claude.passive, undefined)
  assert.deepEqual(await lab.samples(), [])
  await lab.stop()
})

test("E02: two Claude logins, none, a pending sign-in or another profile folder → discarded (No data)", async () => {
  const two = await start({ connections: [login("cl-1", "TURING"), login("cl-2", "Other")] })
  await two.turn("claude-agent", both())
  assert.deepEqual(await two.samples(), [], "two saved logins: the profile cannot be told apart")
  // Back to one login: the next turn is recorded; a second login appearing later drops it.
  two.host.integrations[0].connections.pop()
  await two.turn("claude-agent", both())
  assert.deepEqual(await two.samples(), [["cl-1", "5h", 42], ["cl-1", "weekly", 61]])
  two.host.integrations[0].connections.push(login("cl-3", "Again"))
  assert.deepEqual(await two.samples(), [], "dropped as soon as the inventory has two")
  two.host.integrations[0].connections.pop()
  assert.deepEqual(await two.samples(), [], "and not brought back")
  await two.stop()

  const none = await start({ connections: [] })
  await none.turn("claude-agent", both())
  assert.equal(none.host.record.providers.length, 0)
  assert.equal(await none.claudeOf(), undefined)
  await none.stop()

  const pending = await start({ connections: [login("cl-1", "TURING", { status: { status: "needs_auth", message: MARK } })] })
  await pending.turn("claude-agent", both())
  assert.deepEqual(await pending.samples(), [])
  assert.equal((await pending.claudeOf()).connections[0].reconnectRequired, true)
  await pending.stop()

  for (const configDir of [["~/.claude", "~/.claude-b"], "~/.claude-work", "/srv/claude"]) {
    const other = await start({ providers: { "claude-agent": { settings: { configDir, apiKey: MARK } } } })
    await other.turn("claude-agent", both())
    assert.deepEqual(await other.samples(), [], JSON.stringify(configDir))
    await other.stop()
  }
  const same = await start({ providers: { "claude-agent": { settings: { configDir: "~/.claude" } } } })
  await same.turn("claude-agent", both())
  assert.equal((await same.samples()).length, 2, "the default folder named explicitly is the same profile")
  same.host.failProvider = true
  await same.turn("claude-agent", both(0.5, 0.7))
  assert.deepEqual(await same.samples(), [["cl-1", "5h", 42], ["cl-1", "weekly", 61]], "an unreadable provider records nothing new")
  await same.stop()
})

test("E02: out-of-range utilization, unknown windows or a step without metadata record nothing", async () => {
  const lab = await start()
  await lab.turn("claude-agent", { rateLimitType: "five_hour", utilization: 1.5, resetsAt: S(T0 + HOUR) })
  await lab.turn("claude-agent", { rateLimitType: "five_hour", utilization: -0.2 })
  await lab.turn("claude-agent", recorded({ seven_day_opus: { utilization: 0.4 }, seven_day_sonnet: { utilization: 0.5 }, overage: { utilization: 0.1 } }, "seven_day_opus"))
  await lab.turn("claude-agent", { rateLimitType: "weekly_all", utilization: 0.4 })
  await lab.turn("claude-agent", undefined)
  await lab.turn("claude-agent", undefined, { native: { rateLimit: "allowed", sessionID: MARK } })
  assert.deepEqual(await lab.samples(), [])
  assert.equal(lab.host.record.emitted.length, 0, "no `changed` for nothing")
  await lab.stop()
})

test("E02: credential events of claude-agent, integration updates and a reconnect drop the Claude figures; others keep them", async () => {
  const lab = await start()
  await lab.turn("claude-agent", both())
  lab.host.events.push({ type: "credential.updated", data: { integrationID: "deepseek", credentialID: "ds-1" } })
  lab.host.events.push({ type: "credential.switched", data: { integrationID: "openai", credentialID: null } })
  await settle()
  assert.equal((await lab.samples()).length, 2, "another integration's events do not touch Claude")
  for (const event of [
    { type: "credential.switched", data: { integrationID: "claude-agent", credentialID: "cl-1" } },
    { type: "credential.updated", data: { integrationID: "claude-agent", credentialID: "cl-1" } },
    { type: "integration.updated", data: {} },
  ]) {
    await lab.turn("claude-agent", both())
    assert.equal((await lab.samples()).length, 2)
    lab.host.events.push(event)
    await settle()
    assert.deepEqual(await lab.samples(), [], event.type)
  }
  await lab.turn("claude-agent", both())
  lab.host.integrations[0].connections[0].status = { status: "needs_auth" }
  assert.deepEqual(await lab.samples(), [], "Reconnect required")
  await lab.stop()
})

test("E02: an invalidation while a step end is being attributed records nothing", async () => {
  const lab = await start()
  const get = lab.host.ctx.provider.get
  let release
  lab.host.ctx.provider.get = async (input) => {
    await new Promise((resolve) => (release = resolve))
    return get(input)
  }
  await lab.turn("claude-agent", both())
  assert.equal(typeof release, "function", "the check is waiting for the provider")
  lab.host.events.push({ type: "credential.switched", data: { integrationID: "claude-agent", credentialID: "cl-1" } })
  await settle()
  release()
  await settle()
  assert.deepEqual(await lab.samples(), [])
  await lab.stop()
})

test("E02: past its freshness (150 s) or its reset the last attributable figure stays, Stale with its age; never current or 0", async () => {
  const clock = { now: T0 }
  const lab = await start({ clock })
  await lab.turn("claude-agent", both(), { created: T0 - 5 * 60_000 })
  await lab.turn("claude-agent", both(), { created: T0 + 60_000 })
  assert.deepEqual(await lab.samples(), [], "too old, or from the future")
  // The weekly window resets 1 min after the step, before the 5 h one reaches its freshness.
  await lab.turn("claude-agent", recorded({ five_hour: { utilization: 0.42, resetsAt: S(T0 + 2 * HOUR) }, seven_day: { utilization: 0.61, resetsAt: S(T0 + 60_000) } }))
  const snap = await lab.snapshot()
  assert.equal(snap.usageFreshnessSeconds, 150, "the default, carried by this location's snapshot")
  const claude = snap.integrations.find((item) => item.id === "claude-agent")
  const figure = (now) => listOf(modalRows(snap, { now })).find((row) => /^[ ┃]● Claude /.test(row)).replace(/ +/g, " ").trim()
  const detail = (now) => detailOf(modalRows(snap, { now, cursor: refKey("claude-agent", "cl-1"), width: 84 }))
  const weekly = (now) => detail(now).find((line) => line.startsWith("Weekly"))
  assert.equal(figure(T0), "● Claude 5 h 42% used")
  assert.match(weekly(T0 + 60_000 - 1), /^Weekly +█+░+ 61% used$/)
  assert.match(weekly(T0 + 60_000), /^Weekly +█+░+ 61% used · Stale$/, "at its reset the weekly window keeps its figure, Stale")
  assert.equal(figure(T0 + 60_000), "● Claude 5 h 42% used", "the 5 h window is still fresh")
  assert.equal(figure(T0 + 150_000 - 1), "● Claude 5 h 42% used")
  assert.equal(figure(T0 + 150_000), "● Claude Stale", "past the freshness: Stale, neither — nor a current figure")
  const late = detail(T0 + 10 * 60_000)
  assert.match(late[1], /^5 h +█+░+ 42% used · Stale$/, "the bar and the last percentage stay")
  assert.match(late[2], /^Weekly +█+░+ 61% used · Stale$/)
  assert.deepEqual(late.slice(3), ["Updated       10 min ago", "Source        Claude Code turns", "Type          External (unverified)"])
  assert.equal(late.some((line) => /Resets|\b0% used/.test(line)), false, "no renewal and no invented zero")
  assert.equal(compactLine(snap, { providerID: "claude-agent", modelID: "sonnet" }), undefined, "no notice: nothing above the composer")
  assert.equal(claude.connections[0].samples.length, 2, "the server keeps them; the view decides freshness")
  // What makes them unattributable still drops them, whatever their age: here, a second login.
  lab.host.integrations[0].connections.push(login("cl-2", "Other"))
  assert.deepEqual(await lab.samples(), [])
  await lab.stop()
})

test("E02: usageFreshnessSeconds sets Claude's freshness per location; the 5 min limit on step ends is separate", async () => {
  for (const [option, used] of [[30, 30], [3600, 3600], [0, 150], [3601, 150], ["30", 150], [12.5, 150]]) {
    const lab = await start({ options: { usageFreshnessSeconds: option } })
    assert.equal((await lab.snapshot()).usageFreshnessSeconds, used, String(option))
    await lab.stop()
  }
  const clock = { now: T0 }
  // A long freshness does not reach further back: a step that ended 5 min ago is still not attributed to today's profile.
  const long = await start({ clock, options: { usageFreshnessSeconds: 3600 } })
  await long.turn("claude-agent", both(), { created: T0 - 5 * 60_000 })
  assert.deepEqual(await long.samples(), [])
  await long.stop()
  // A short one does not drop a step delivered late: recorded at its own time, it is born Stale and says how old.
  const short = await start({ clock, options: { usageFreshnessSeconds: 30 } })
  await short.turn("claude-agent", both(), { created: T0 - 4 * 60_000 })
  assert.deepEqual(await short.samples(), [["cl-1", "5h", 42], ["cl-1", "weekly", 61]])
  const rows = modalRows(await short.snapshot(), { now: T0, cursor: refKey("claude-agent", "cl-1"), width: 84 })
  assert.match(listOf(rows).find((row) => row.startsWith("┃")), /^┃● Claude +Stale$/)
  assert.ok(detailOf(rows).includes("Updated       4 min ago"), detailOf(rows).join("\n"))
  // Fresh figures of this location expire at 30 s, not at 150 s.
  await short.turn("claude-agent", both(0.5, 0.7))
  const snap = await short.snapshot()
  const figure = (now) => listOf(modalRows(snap, { now })).find((row) => /^[ ┃]● Claude /.test(row)).replace(/ +/g, " ").trim()
  assert.equal(figure(T0 + 30_000 - 1), "● Claude 5 h 50% used")
  assert.equal(figure(T0 + 30_000), "● Claude Stale")
  await short.stop()
})

test("E02: no secret or raw metadata reaches RPC, events, storage or the console", async () => {
  const printed = []
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug }
  for (const name of Object.keys(saved)) console[name] = (...args) => printed.push(args.map(String).join(" "))
  try {
    const lab = await start({
      connections: [login("cl-1", "TURING", { configDir: MARK, metadata: { email: MARK } })],
      providers: { "claude-agent": { settings: { apiKey: MARK, authToken: MARK }, headers: { Authorization: MARK } } },
    })
    const rateLimit = { ...both(), errorCode: MARK, overageDisabledReason: MARK, unifiedWindows: { ...both().unifiedWindows, five_hour: { utilization: 0.42, resetsAt: S(T0 + 2 * HOUR), note: MARK } } }
    await lab.turn("claude-agent", undefined, { native: { rateLimit, sessionID: MARK, messageID: MARK }, extra: { metadata: { trace: MARK } } })
    const snapshot = await lab.snapshot()
    assert.equal((await lab.samples()).length, 2)
    const everything = JSON.stringify({ snapshot, emitted: lab.host.record.emitted, storage: [...lab.host.storage], printed })
    assert.equal(everything.includes(MARK), false)
    assert.deepEqual([...lab.host.storage.keys()], [], "nothing persisted: measurements live in memory only")
    assert.deepEqual(lab.host.record.resolved, [])
    await lab.stop()
    const again = await start()
    assert.deepEqual(await again.samples(), [], "gone after a reload")
    await again.stop()
  } finally {
    Object.assign(console, saved)
  }
})

test("E02: opening the modal makes no network request, no provider or credential read, and never refreshes Claude", async () => {
  const lab = await start()
  await lab.turn("claude-agent", both())
  const reads = lab.host.record.providers.length
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    throw new Error("no network in this test")
  }
  try {
    const snap = await lab.snapshot()
    assert.deepEqual(staleRefs(snap, T0 + 1).filter((ref) => ref.integrationID === "claude-agent"), [], "never read on open")
    modalRows(snap, { now: T0 + 1, cursor: refKey("claude-agent", "cl-1") })
    compactLine(snap, { providerID: "claude-agent", modelID: "sonnet" })
    await settle()
  } finally {
    globalThis.fetch = original
  }
  assert.equal(requests, 0)
  assert.equal(lab.host.record.providers.length, reads, "a snapshot checks nothing with the provider")
  assert.deepEqual([lab.host.record.resolved, lab.host.record.sessions], [[], []], "nor reads a credential or a session")
  await lab.stop()
})

test("E02: a step event without a location (as 2.4.1 delivers them) is checked in its session's location; unknown → discarded", async () => {
  const lab = await start({ providers: { "claude-agent": { settings: {} } } })
  await lab.turn("claude-agent", both(), { located: false })
  assert.deepEqual(lab.host.record.sessions, ["ses-1"], "a local read of the session's metadata, nothing else")
  assert.deepEqual(lab.host.record.providers, [{ providerID: "claude-agent", location: { directory: "/work/session-a" } }])
  assert.equal((await lab.samples()).length, 2)
  await lab.turn("claude-agent", both(0.5, 0.7), { located: false, session: "ses-unknown" })
  assert.deepEqual(await lab.samples(), [["cl-1", "5h", 42], ["cl-1", "weekly", 61]], "no location, no profile check, nothing new")
  assert.equal(lab.host.record.providers.length, 1)
  await lab.stop()
})

test("E02: every location instance gets the same event; it is handled once", async () => {
  const lab = await start({ instances: 2 })
  await lab.turn("claude-agent", both())
  assert.equal(lab.host.record.providers.length, 1)
  assert.equal((await lab.samples()).length, 2)
  await lab.stop()
})

test("E02 (R4): with two location instances, a turn-end decision still waits for the step end being attributed", async () => {
  const lab = await start({ instances: 2 })
  const get = lab.host.ctx.provider.get
  // A slow provider check keeps the attribution in progress when the turn end arrives.
  lab.host.ctx.provider.get = async (input) => {
    await settle(50)
    return get(input)
  }
  await lab.host.handlers.setSessionRouting({ sessionID: "ses-1", mode: "preview", paid: false }, call())
  const base = { sessionID: "ses-1", assistantMessageID: "msg-r4" }
  lab.host.events.push({ id: "evt-r4-a", type: "session.step.started", created: T0, location: { directory: "/work/a" },
    data: { ...base, agent: "build", model: { id: "sonnet", providerID: "claude-agent" }, started: T0 } })
  lab.host.events.push({ id: "evt-r4-b", type: "session.step.ended", created: T0, location: { directory: "/work/a" },
    data: { ...base, finish: "stop", native: { rateLimit: both(0.97) }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } })
  await settle(5)
  lab.host.events.push({ id: "evt-r4-end", type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
  await settle(150)
  const { decision } = (await lab.host.handlers.routingView({ sessionID: "ses-1" }, call())).session
  assert.deepEqual([decision.kind, decision.trigger], ["noTarget", "5 h: 97% used"], "not keep · Usage unknown")
  await lab.stop()
})

// A step of claude-agent at 97 % pushed by hand, so the snapshot can be asked for while it is still being attributed.
const step = (host, id) => {
  const base = { sessionID: "ses-1", assistantMessageID: `msg-${id}` }
  host.events.push({ id: `${id}-a`, type: "session.step.started", created: T0, location: { directory: "/work/a" },
    data: { ...base, agent: "build", model: { id: "sonnet", providerID: "claude-agent" }, started: T0 } })
  host.events.push({ id: `${id}-b`, type: "session.step.ended", created: T0, location: { directory: "/work/a" },
    data: { ...base, finish: "stop", native: { rateLimit: both(0.97) }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } })
}

test("E02 (T08): a snapshot read at the turn end waits, within 500 ms, for the step end being attributed", async () => {
  const slow = await start()
  const get = slow.host.ctx.provider.get
  slow.host.ctx.provider.get = async (input) => {
    await settle(50)
    return get(input)
  }
  step(slow.host, "slow")
  await settle(5)
  const five = (await slow.claudeOf()).connections[0].samples?.find((s) => s.window === "5h")
  assert.equal(five?.used, 97, "the turn's usage, not the figure held before it")
  await slow.stop()

  // A provider that never answers: the snapshot still comes, without figures.
  const stuck = await start()
  stuck.host.ctx.provider.get = () => new Promise(() => {})
  step(stuck.host, "stuck")
  await settle(5)
  const asked = Date.now()
  const connection = (await stuck.claudeOf()).connections[0]
  assert.ok(Date.now() - asked < 1000, "bounded wait")
  assert.equal(connection.samples, undefined)
  await stuck.stop()
})

test("E02 (view): the row is named by the profile, never by the alias; meters and one source note", async () => {
  const lab = await start()
  await lab.turn("claude-agent", both())
  const snap = await lab.snapshot()
  const rows = modalRows(snap, { now: T0 + 1, cursor: refKey("claude-agent", "cl-1"), width: 84 })
  const all = [...text(rows), compactLine(snap, { providerID: "claude-agent", modelID: "sonnet" })].join("\n")
  assert.equal(all.includes("TURING"), false, "the alias is not verified: it never names the figures")
  assert.match(listOf(rows).find((row) => row.startsWith("┃")), /^┃● Claude +5 h {2}42% used$/)
  const detail = detailOf(rows)
  assert.match(detail[0], /^✻ Claude$/, "the detail is titled by the profile too")
  assert.match(detail[1], /^5 h +█+░+ 42% used$/)
  assert.match(detail[2], /^ +Resets \S/)
  assert.match(detail[3], /^Weekly +█+░+ 61% used$/)
  assert.match(detail[4], /^ +Resets \S/)
  assert.deepEqual(detail.slice(5), ["Updated       just now", "Source        Claude Code turns", "Type          External (unverified)"])
  assert.equal(all.split("Claude Code turns").length - 1, 1, "one source")
  assert.equal(all.includes("does not apply"), false, "`r` on Claude refreshes (manual /usage reader), no such line")
  assert.equal(NO_REFRESH, "Refresh is not available for this account.")
  // No data yet (or any more, once the server dropped it): the same single source, no meter, no zero. This plugin has
  // no /usage reader: no `r`. Time alone no longer empties the row (it says Stale), so the samples are taken away here.
  const bare = structuredClone(snap)
  delete bare.integrations.find((item) => item.id === "claude-agent").connections[0].samples
  const empty = modalRows(bare, { now: T0 + 5 * 60_000, cursor: refKey("claude-agent", "cl-1"), width: 84 })
  assert.deepEqual(detailOf(empty).slice(1), ["Usage         —", "Source        Claude Code turns", "Type          External (unverified)"])
  // With the manual /usage reader, an empty row says how to read it.
  const readable = { ...bare, integrations: bare.integrations.map((item) => (item.id === "claude-agent" ? { ...item, refreshable: true, manual: true } : item)) }
  assert.equal(detailOf(modalRows(readable, { now: T0 + 5 * 60_000, cursor: refKey("claude-agent", "cl-1"), width: 84 }))[1], "Usage         Press r to read")
  // Two logins: the profile cannot be told apart, so each keeps its alias and has no figure.
  snap.integrations.find((item) => item.id === "claude-agent").connections.push({ id: "cl-2", label: "Other", method: "external", active: false })
  delete snap.integrations.find((item) => item.id === "claude-agent").connections[0].samples
  const twoRows = listOf(modalRows(snap, { now: T0 + 1 }))
  assert.ok(twoRows.some((row) => /^ ● TURING +—$/.test(row)) && twoRows.some((row) => /^ ○ Other +—$/.test(row)), twoRows.join("\n"))
  assert.equal(detailOf(modalRows({ ...readable, integrations: snap.integrations.map((item) => (item.id === "claude-agent" ? { ...item, refreshable: true, manual: true } : item)) },
    { now: T0 + 1, cursor: refKey("claude-agent", "cl-1"), width: 84 }))[1], "Usage         —", "two logins: /usage cannot be attributed, no invitation")
  await lab.stop()
})
