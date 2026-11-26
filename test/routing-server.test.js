// Rotation plan R1 and R4 (FIXTURE, A5–A8): route order storage and RPC, per-session preview mode and the turn-end
// coordinator, with a simulated host, counted synthetic readers and a controlled clock. No real provider is read.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createPlugin } from "../server.js"
import { call, contract, fakeHost, settle } from "./host.js"

const T0 = Date.UTC(2026, 10, 25, 12)
const key = (id, extra = {}) => ({ type: "credential", id, label: id, method: "key", ...extra })
const oauth = (id) => ({ type: "credential", id, label: id, method: "oauth" })
const exact = (connectionID, integrationID = "deepseek") => ({ integrationID, providerID: integrationID, modelID: "chat", binding: "exact", connectionID })
const PREFS = { schema: 1, revision: 3, mode: "recommend", threshold: 90, order: {}, minimums: { USD: "0.20" } }

test("hot reload upgrades earlier shared state before refresh and disposal", async () => {
  const shared = globalThis[Symbol.for("account-quota.server.v6")]
  const inflight = shared.inflight
  delete shared.until
  delete shared.epochs
  delete shared.routing.checks
  await import("../server.js?reload-old-state")
  const lab = await start()
  try {
    const result = await lab.handlers.refresh({ integrationID: "deepseek", connectionID: "ds-1" }, call())
    assert.equal(result.status, "read")
    assert.equal(shared.inflight, inflight)
    assert.ok(shared.routing.checks instanceof Map && shared.epochs instanceof Map)
  } finally {
    await lab.stop()
  }
})

async function start({ ids = ["ds-1", "ds-2"], balances = {}, hold, storage = new Map([["preferences", PREFS]]), codex = false, model, clock = { now: T0 } } = {}) {
  const host = fakeHost({
    storage,
    sessions: { "ses-1": "/work/a", "ses-2": "/work/b" },
    integrations: [{ id: "deepseek", connections: ids.map((id) => key(id)) }, { id: "openai", connections: [oauth("oa-1"), oauth("oa-2")] }],
    active: { deepseek: { type: "credential", id: ids[0] }, openai: { type: "credential", id: "oa-1" } },
  })
  const reads = []
  const gates = []
  const reader = {
    source: "test-balance",
    async read({ connection }) {
      reads.push(connection.id)
      if (hold?.includes(connection.id)) await new Promise((resolve) => gates.push(resolve))
      return { window: "balance", scope: "general", observedAt: clock.now, available: true, balances: [{ currency: "USD", total: balances[connection.id] ?? "0.10" }] }
    },
  }
  const codexReads = []
  const plugin = createPlugin({ contract, now: () => clock.now, readers: { deepseek: reader },
    experimental: { openai: { source: "codex-usage", manual: true, bound: true, read: async ({ connection }) => (codexReads.push(connection.id), []) } } })
  const stops = [await plugin.setup({ ...host.ctx, model, options: { experimentalCodexUsage: codex } })]
  const handlers = host.handlers
  const turn = async (sessionID = "ses-1", id = `end-${Math.random()}`, model = { providerID: "deepseek", id: "chat" }) => {
    host.events.push({ id: `step-${id}`, type: "session.step.started", data: { sessionID, assistantMessageID: id, model } })
    host.events.push({ id, type: "session.execution.succeeded", data: { sessionID } })
    await settle(30)
    return id
  }
  const view = async (sessionID = "ses-1") => handlers.routingView({ sessionID }, call())
  const stop = async () => { for (const s of stops.reverse()) await s() }
  return { host, handlers, reads, codexReads, gates, turn, view, stop, clock, plugin, stops }
}

test("A5: the route order lives under its own key; reading writes nothing; saves are exact, validated and conflict-safe", async () => {
  const lab = await start()
  assert.deepEqual(await lab.handlers.routingView({}, call()), { state: "available", revision: 0, targets: [] })
  assert.equal(lab.host.storage.has("routingPreferences"), false, "nothing is written by reading")
  const inherit = { integrationID: "openai", providerID: "openai", binding: "current" }
  const targets = [exact("ds-2"), inherit, { ...inherit, variant: "deep" }, { ...inherit, modelID: "gpt" }]
  assert.deepEqual(await lab.handlers.saveRouting({ revision: 0, targets }, call()), { revision: 1 })
  assert.deepEqual(lab.host.storage.get("routingPreferences"), { schema: 1, revision: 1, targets })
  assert.deepEqual((await lab.handlers.routingView({}, call())).targets, targets)
  assert.equal((await lab.handlers.saveRouting({ revision: 0, targets: [] }, call())).rpcError, "conflict", "second save on the same revision")
  for (const bad of [
    [exact("ds-2"), exact("ds-2")],
    [inherit, { binding: "current", providerID: "openai", integrationID: "openai" }],
    [{ ...inherit, variant: "" }], [{ ...inherit, modelID: null }], [{ ...inherit, connectionID: undefined }],
    [{ ...exact("ds-2"), binding: "current" }],
    [{ integrationID: "openai", providerID: "openai", modelID: "gpt", binding: "exact" }],
    [exact("invented")],
    [{ ...exact("ds-2"), providerID: "openai" }],
    [{ ...exact("ds-2"), extra: true }],
    [{ integrationID: "nowhere", providerID: "nowhere", modelID: "m", binding: "current" }],
    Array.from({ length: 65 }, (_, i) => ({ integrationID: "openai", providerID: "openai", modelID: `m${i}`, binding: "current" })),
  ]) assert.equal((await lab.handlers.saveRouting({ revision: 1, targets: bad }, call())).rpcError, "invalid", JSON.stringify(bad).slice(0, 80))
  assert.equal((await lab.handlers.saveRouting({ revision: 1, targets: [], more: 1 }, call())).rpcError, "invalid")
  // A TUI that only knows priorities saves them with the preferences revision; the route order is untouched.
  assert.deepEqual(await lab.handlers.savePreferences({ revision: 3, threshold: 90, minimums: { USD: "0.20" }, order: { deepseek: ["ds-2", "ds-1"] } }, call()), { revision: 4 })
  assert.deepEqual(lab.host.storage.get("routingPreferences").targets, targets)
  // Concurrent saves from two clients on one revision: one success, one conflict.
  const both = await Promise.all([1, 2].map(() => lab.handlers.saveRouting({ revision: 1, targets: [exact("ds-1")] }, call())))
  assert.deepEqual(both.map((r) => r.revision ?? r.rpcError).sort(), [2, "conflict"])
  assert.deepEqual(lab.reads, [], "no save reads a provider")
  await lab.stop()

  const future = await start({ storage: new Map([["preferences", PREFS], ["routingPreferences", { schema: 2, revision: 9, targets: [] }]]) })
  assert.deepEqual(await future.handlers.routingView({}, call()), { state: "unsupported" })
  assert.equal((await future.handlers.saveRouting({ revision: 9, targets: [] }, call())).rpcError, "unavailable", "a future schema is read-only")
  assert.deepEqual(future.host.storage.get("routingPreferences"), { schema: 2, revision: 9, targets: [] })
  await future.stop()
})

test("R4: floating models use the session selection, even without a step; pinned efforts consult only its own location", async () => {
  const locations = []
  const lab = await start({ balances: { "ds-2": "5.00" }, model: { list: async ({ location }) => {
    locations.push(location.directory)
    return { data: [{ providerID: "deepseek", id: "chat-new", enabled: true, variants: [{ id: "deep" }] }] }
  } } })
  try {
    const ctx = lab.host.ctx
    const get = ctx.session.get
    ctx.session.get = async (args) => ({ ...await get(args), model: { providerID: "deepseek", id: "chat-new", variant: "normal" } })
    const run = async (id) => {
      lab.host.events.push({ id, type: "session.execution.failed", data: { sessionID: "ses-1" } })
      await settle(40)
      return (await lab.view()).session.decision
    }
    const { modelID, ...inherit } = exact("ds-2")
    await lab.handlers.saveRouting({ revision: 0, targets: [inherit] }, call())
    await lab.handlers.setSessionRouting({ sessionID: "ses-1", mode: "preview", paid: true }, call())
    assert.equal((await run("missing-step")).target, 0)
    assert.deepEqual(locations, [], "keeping model and effort needs no catalog call")
    await lab.handlers.saveRouting({ revision: 1, targets: [{ ...inherit, variant: "deep" }] }, call())
    assert.equal((await run("different-effort")).target, 0)
    assert.deepEqual(locations, ["/work/a"])
    lab.host.events.push({ type: "session.model.selected", data: { sessionID: "ses-1", model: { providerID: "deepseek", id: "other" } } })
    await settle()
    const next = await run("model-changed")
    assert.deepEqual([next.kind, next.rows[0].reason], ["noTarget", "Choose an effort for this model"])
  } finally {
    await lab.stop()
  }
})

test("R4: decisions use the usage freshness of the location that watches the session, not of the instance that gets the event", async () => {
  const clock = { now: T0 }
  const world = { storage: new Map([["preferences", PREFS]]), sessions: { "ses-1": "/work/a" },
    integrations: [{ id: "openai", connections: [oauth("oa-1"), oauth("oa-2")] }], active: { openai: { type: "credential", id: "oa-1" } } }
  // Two location instances of one server: same inventory and storage, each with its own options and event channel.
  const [a, b] = [fakeHost(world), fakeHost(world)]
  const usage = { source: "codex-usage", manual: true, bound: true, read: async ({ connection }) => [
    { window: "5h", scope: "general", observedAt: clock.now, used: connection.id === "oa-1" ? 97 : 10 },
    { window: "weekly", scope: "general", observedAt: clock.now, used: 10 }] }
  const plugin = createPlugin({ contract, now: () => clock.now, experimental: { openai: usage } })
  const setup = (host, directory, seconds) => plugin.setup({ ...host.ctx, location: { directory },
    options: { experimentalCodexUsage: true, usageFreshnessSeconds: seconds } })
  const stops = [await setup(a, "/work/a", 30), await setup(b, "/work/b")]
  try {
    const own = async (host) => (await host.handlers.snapshot({}, call())).usageFreshnessSeconds
    assert.deepEqual([await own(a), await own(b)], [30, 150], "each location's snapshot carries its own option, whichever loaded last")
    await b.handlers.saveRouting({ revision: 0, targets: [exact("oa-2", "openai")] }, call())
    assert.equal((await b.handlers.refresh({ integrationID: "openai", connectionID: "oa-1", manual: true }, call())).status, "read")
    clock.now = T0 + 60_000
    // Only B receives the turn end, a minute after the reading.
    const decision = async (id) => {
      b.events.push({ id: `step-${id}`, type: "session.step.started", data: { sessionID: "ses-1", assistantMessageID: id, model: { providerID: "openai", id: "gpt" } } })
      b.events.push({ id, type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
      await settle(40)
      return (await a.handlers.routingView({ sessionID: "ses-1" }, call())).session.decision
    }
    await a.handlers.setSessionRouting({ sessionID: "ses-1", mode: "preview", paid: false }, call())
    const watchedFromA = await decision("t1")
    assert.deepEqual([watchedFromA.kind, watchedFromA.reason, watchedFromA.trigger], ["keep", "Refresh required", undefined],
      "A's 30 s: the origin's minute-old 97 % is stale, so unverified")
    await stops[0]()
    stops[0] = await setup(a, "/work/a", 90)
    assert.equal((await decision("after-reload")).trigger, "5 h: 97% used", "a config reload updates an already watched session")
    await b.handlers.setSessionRouting({ sessionID: "ses-1", mode: "preview", paid: false }, call())
    const watchedFromB = await decision("t2")
    assert.deepEqual([watchedFromB.kind, watchedFromB.trigger], ["noTarget", "5 h: 97% used"], "B's default 150 s: fresh, it triggers")
  } finally {
    for (const stop of stops.reverse()) await stop()
  }
})

test("R4: decisions use the readers and passive data of the location that watches the session, not of the instance that gets the event", async () => {
  const clock = { now: T0 }
  const S = (ms) => Math.floor(ms / 1000)
  const world = { storage: new Map([["preferences", PREFS]]), sessions: { "ses-1": "/work/a" },
    integrations: [{ id: "claude-agent", connections: [{ type: "credential", id: "cl-1", label: "cl-1", method: "external" }] }],
    active: { "claude-agent": { type: "credential", id: "cl-1" } } }
  const [a, b] = [fakeHost(world), fakeHost(world)]
  const plugin = createPlugin({ contract, now: () => clock.now, system: { env: {}, home: "/home/lab" } })
  const stops = [await plugin.setup({ ...a.ctx, location: { directory: "/work/a" }, options: { experimentalClaudeUsage: true } }),
    await plugin.setup({ ...b.ctx, location: { directory: "/work/b" }, options: {} })]
  try {
    await a.handlers.setSessionRouting({ sessionID: "ses-1", mode: "preview", paid: false }, call())
    // Only A measures Claude's usage: it records a step of the user's turn at 97 %.
    const base = { sessionID: "ses-1", assistantMessageID: "m1" }
    const model = { id: "sonnet", providerID: "claude-agent" }
    a.events.push({ id: "a-step", type: "session.step.started", created: T0, location: { directory: "/work/a" }, data: { ...base, agent: "build", model, started: T0 } })
    a.events.push({ id: "a-end", type: "session.step.ended", created: T0, location: { directory: "/work/a" }, data: { ...base, finish: "stop", cost: 0,
      native: { rateLimit: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: S(T0 + 3_600_000) },
        seven_day: { utilization: 0.1, resetsAt: S(T0 + 86_400_000) } } } },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } })
    await settle(40)
    // Only B, without the option, receives the turn end.
    b.events.push({ id: "b-step", type: "session.step.started", data: { sessionID: "ses-1", assistantMessageID: "m2", model } })
    b.events.push({ id: "b-turn", type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
    await settle(40)
    const { decision } = (await a.handlers.routingView({ sessionID: "ses-1" }, call())).session
    assert.equal(decision.trigger, "5 h: 97% used", "not keep · Usage unknown")
  } finally {
    for (const stop of stops.reverse()) await stop()
  }
})

test("A6: 0 reads at rest, on saving or with routing off; one decision reads the stale candidate once and stops there", async () => {
  const lab = await start({ balances: { "ds-1": "0.10", "ds-2": "5.00", "ds-3": "5.00" }, ids: ["ds-1", "ds-2", "ds-3"] })
  await lab.handlers.saveRouting({ revision: 0, targets: [exact("ds-2"), exact("ds-3")] }, call())
  await lab.handlers.refresh({ integrationID: "deepseek", connectionID: "ds-1" }, call())
  lab.reads.length = 0
  await lab.turn()
  assert.deepEqual(lab.reads, [], "a session that is not in preview is never evaluated")
  assert.equal((await lab.handlers.setSessionRouting({ sessionID: "nope", mode: "preview", paid: true }, call())).rpcError, "not_found")
  assert.equal((await lab.handlers.setSessionRouting({ sessionID: "ses-1", mode: "auto", paid: true }, call())).rpcError, "invalid", "no automatic mode")
  assert.deepEqual(await lab.handlers.setSessionRouting({ sessionID: "ses-1", mode: "preview", paid: true }, call()), { mode: "preview", paid: true })
  await settle(40)
  assert.deepEqual(lab.reads, [], "enabling reads nothing")
  await lab.turn()
  const { session } = await lab.view()
  assert.deepEqual(lab.reads, ["ds-2"], "origin fresh (low balance): one read of the first candidate, none of the second")
  assert.deepEqual([session.decision.kind, session.decision.target, session.decision.reason, session.decision.reads], ["suggest", 0, "Account switch is global", 1])
  assert.equal(session.decision.trigger, "Low balance: USD 0.10")
  // The next turn reuses the fresh data: no read at all.
  await lab.turn()
  assert.deepEqual(lab.reads, ["ds-2"])
  // Another session keeps its own (off) mode.
  assert.deepEqual((await lab.view("ses-2")).session, { mode: "off", paid: false })
  await lab.stop()
})

test("A6: with every candidate stale and low, at most two candidate reads per decision, one at a time; the rest is unverified", async () => {
  const ids = ["ds-0", "ds-1", "ds-2", "ds-3", "ds-4"]
  const lab = await start({ ids })
  await lab.handlers.saveRouting({ revision: 0, targets: ids.slice(1).map((id) => exact(id)) }, call())
  await lab.handlers.refresh({ integrationID: "deepseek", connectionID: "ds-0" }, call())
  await lab.handlers.setSessionRouting({ sessionID: "ses-1", mode: "preview", paid: true }, call())
  lab.reads.length = 0
  await lab.turn()
  const { decision } = (await lab.view()).session
  assert.deepEqual(lab.reads, ["ds-1", "ds-2"])
  assert.deepEqual([decision.kind, decision.reason, decision.reads], ["noTarget", "Balance: USD 0.10", 2])
  assert.deepEqual(decision.rows.map((r) => r.reason), ["Balance: USD 0.10", "Balance: USD 0.10", "Not verified (read budget used)", "Not verified (read budget used)"])
  await lab.stop()
})

test("A6/A12: manual readers are never read by a decision; paid keys need consent; duplicate events give one decision", async () => {
  const lab = await start({ codex: true })
  await lab.handlers.saveRouting({ revision: 0, targets: [exact("oa-2", "openai"), exact("ds-2")] }, call())
  await lab.handlers.refresh({ integrationID: "deepseek", connectionID: "ds-1" }, call())
  await lab.handlers.setSessionRouting({ sessionID: "ses-1", mode: "preview", paid: false }, call())
  lab.reads.length = 0
  // A second location instance receives the same events.
  lab.stops.push(await lab.plugin.setup({ ...lab.host.ctx, options: { experimentalCodexUsage: true } }))
  await lab.turn("ses-1", "same-end")
  lab.host.events.push({ id: "same-end", type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
  await settle(40)
  const { decision } = (await lab.view()).session
  assert.deepEqual(lab.codexReads, [], "the experimental Codex reader is manual: never read on a turn end")
  assert.deepEqual(lab.reads, [], "paid keys without consent are not even read")
  assert.deepEqual(decision.rows.map((r) => r.reason), ["Refresh required", "Metered API not enabled"])
  assert.equal(decision.kind, "noTarget")
  await lab.stop()
})

test("A7/A8: a decision past its deadline queues nothing and drops its result; a new turn or switching off abandons it", async () => {
  const clock = { now: T0 }
  const lab = await start({ clock, ids: ["ds-1", "ds-2", "ds-3", "ds-4"], hold: ["ds-3", "ds-4", "ds-2"], balances: { "ds-2": "5.00" } })
  await lab.handlers.saveRouting({ revision: 0, targets: [exact("ds-2")] }, call())
  await lab.handlers.refresh({ integrationID: "deepseek", connectionID: "ds-1" }, call())
  await lab.handlers.setSessionRouting({ sessionID: "ses-1", mode: "preview", paid: true }, call())
  // Two manual reads fill both slots of the server; the decision's read has to wait in the queue.
  const manual = ["ds-3", "ds-4"].map((id) => lab.handlers.refresh({ integrationID: "deepseek", connectionID: id, manual: true }, call()))
  await settle(20)
  lab.reads.length = 0
  await lab.turn()
  clock.now = T0 + 6_000
  for (const open of lab.gates.splice(0)) open()
  await Promise.all(manual)
  await settle(60)
  assert.deepEqual(lab.reads, [], "the queued read expired with its decision and was never sent")
  assert.equal((await lab.view()).session.decision, undefined, "no late decision")
  assert.equal((await lab.handlers.snapshot({}, call())).integrations[0].connections.find((c) => c.id === "ds-2").failure, undefined,
    "an expired wait is not a failure and starts no retry wait")
  // A manual read of the same account while a decision waits for it keeps it wanted whatever the deadline.
  const again = ["ds-3", "ds-4"].map((id) => lab.handlers.refresh({ integrationID: "deepseek", connectionID: id, manual: true }, call()))
  await settle(20)
  await lab.turn()
  const user = lab.handlers.refresh({ integrationID: "deepseek", connectionID: "ds-2", manual: true }, call())
  clock.now = T0 + 20_000
  for (const open of lab.gates.splice(0)) open()
  await settle(30)
  for (const open of lab.gates.splice(0)) open()
  assert.equal((await user).status, "read", "the user's read is not cancelled by an expired decision")
  await Promise.all(again)
  assert.equal((await lab.view()).session.decision, undefined, "and its result still changes no decision")

  // A new turn starting while a decision reads: the old one is dropped.
  clock.now = T0 + 10 * 60_000
  await lab.handlers.refresh({ integrationID: "deepseek", connectionID: "ds-1" }, call())
  lab.reads.length = 0
  await lab.turn("ses-1", "old")
  assert.deepEqual(lab.reads, ["ds-2"])
  lab.host.events.push({ id: "next", type: "session.execution.started", data: { sessionID: "ses-1" } })
  await settle(20)
  for (const open of lab.gates.splice(0)) open()
  await settle(40)
  assert.equal((await lab.view()).session.decision, undefined, "a decision of an earlier turn changes nothing")
  await lab.stop()
})

test("A3/A4 (R4): a DeepSeek key replaced during the read does not lend its balance; unloading forgets modes and decisions", async () => {
  const lab = await start({ hold: ["ds-2"], balances: { "ds-2": "5.00" } })
  await lab.handlers.saveRouting({ revision: 0, targets: [exact("ds-2")] }, call())
  await lab.handlers.refresh({ integrationID: "deepseek", connectionID: "ds-1" }, call())
  await lab.handlers.setSessionRouting({ sessionID: "ses-1", mode: "preview", paid: true }, call())
  await lab.turn()
  lab.host.events.push({ id: "cred", type: "credential.updated", data: { integrationID: "deepseek", credentialID: "ds-2" } })
  await settle(20)
  for (const open of lab.gates.splice(0)) open()
  await settle(60)
  const { decision } = (await lab.view()).session
  assert.deepEqual([decision.kind, decision.rows[0].reason], ["noTarget", "Account changed during the read"])
  const ds2 = (await lab.handlers.snapshot({}, call())).integrations[0].connections.find((c) => c.id === "ds-2")
  assert.equal(ds2.samples, undefined, "the balance read for the old key is forgotten")
  await lab.stop()
  const again = await start()
  assert.deepEqual((await again.view()).session, { mode: "off", paid: false }, "session modes do not survive a reload")
  assert.deepEqual([...again.host.storage.keys()].sort(), ["preferences"], "nothing about sessions is ever stored")
  await again.stop()
})
