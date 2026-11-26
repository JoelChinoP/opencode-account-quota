// Server wiring with a simulated host: B02 inventory (support for T03/T04), B04 preferences (T10 and the
// fixture side of T09), B06 read scheduling (fixture side of T14). HOST cases run in scripts/check-host.py.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createPlugin } from "../server.js"
import { proposalFrom, setAmount, shiftCurrency, startMinimum, turnOff } from "../view.js"
import { call, contract, fakeHost, settle } from "./host.js"

const MARK = "SYNTHETIC-MARKED-CREDENTIAL-B02"
const T0 = Date.UTC(2026, 10, 24, 12)

const native = () => [
  {
    id: "deepseek",
    name: "DeepSeek",
    methods: [{ type: "key" }],
    connections: [
      { type: "credential", id: "ds-1", label: "Main", method: "key", status: { status: "needs_auth", message: MARK } },
      { type: "credential", id: "ds-2", label: "Backup", method: "key", key: MARK },
      { type: "env", name: "DEEPSEEK_API_KEY" },
    ],
  },
  { id: "openai", name: "OpenAI", methods: [], connections: [{ type: "credential", id: "oa-1", label: "Work", method: "oauth" }] },
  { id: "anthropic", name: "Anthropic", methods: [], connections: [] },
]

const balance = (total = "1.00") => ({ window: "balance", scope: "general", observedAt: T0, available: true, balances: [{ currency: "USD", total }] })

async function start({ read, clock = { now: T0 }, storage } = {}) {
  const host = fakeHost({
    integrations: native(),
    active: { deepseek: { type: "credential", id: "ds-1", label: "Main", method: "key" }, openai: undefined },
    credentials: { "ds-1": { type: "key", key: MARK + "-1" }, "ds-2": { type: "key", key: MARK + "-2" } },
    storage,
  })
  const reads = []
  const plugin = createPlugin({
    contract,
    now: () => clock.now,
    readers: {
      deepseek: {
        source: "test-balance",
        async read(args) {
          reads.push({ id: args.connection.id, key: (await args.resolve())?.key })
          return read ? read(args) : balance()
        },
      },
    },
  })
  const stop = await plugin.setup(host.ctx)
  return { host, reads, stop, clock }
}

const ref = (connectionID, integrationID = "deepseek") => ({ integrationID, connectionID })
const order = (snapshot, id = "deepseek") => snapshot.integrations.find((item) => item.id === id).connections.map((c) => c.id)

test("snapshot lists every saved connection of the personal server, labelled, without credential data", async () => {
  const { host, stop } = await start()
  const snapshot = await host.handlers.snapshot({}, call())
  assert.equal(snapshot.scope, "personal-server")
  assert.equal(snapshot.schema, 2)
  assert.equal(typeof snapshot.revision, "number")
  assert.deepEqual(snapshot.preferences, { state: "available", revision: 0, mode: "recommend", threshold: 95, minimums: { USD: "0.20" } })
  assert.deepEqual(snapshot.integrations, [
    {
      id: "deepseek",
      active: "connection",
      refreshable: true,
      connections: [
        { id: "ds-1", label: "Main", method: "key", active: true, reconnectRequired: true },
        { id: "ds-2", label: "Backup", method: "key", active: false },
      ],
    },
    { id: "openai", active: "none", refreshable: false, connections: [{ id: "oa-1", label: "Work", method: "oauth", active: false }] },
  ])
  assert.equal(JSON.stringify(snapshot).includes(MARK), false)
  assert.deepEqual(host.record.resolved, [], "listing never resolves a credential")
  await stop()
})

test("a failed or oversized native read is reported as unavailable, not as an empty or cut inventory", async () => {
  const { host, stop } = await start()
  host.failList = true
  const failed = await host.handlers.snapshot({}, call())
  assert.deepEqual([failed.inventory, failed.integrations, failed.scope], ["unavailable", [], "personal-server"])
  host.failList = false
  host.integrations = [{ id: "deepseek", connections: Array.from({ length: 65 }, (_, i) => ({ type: "credential", id: `k${i}`, label: "K", method: "key" })) }]
  const big = await host.handlers.snapshot({}, call())
  assert.deepEqual([big.inventory, big.integrations], ["unavailable", []])
  host.integrations = [{ id: "deepseek", connections: [{ type: "credential", id: "k", label: "L".repeat(500), method: "key" }] }]
  const clipped = await host.handlers.snapshot({}, call())
  assert.equal(clipped.integrations[0].connections[0].label.length, 200)
  await stop()
})

test("refresh reaches the reader only for a listed reference of that integration, with that connection's key", async () => {
  const { host, reads, stop } = await start()
  const rejected = [
    {},
    { integrationID: "deepseek" },
    ref("missing"),
    ref("ds-2", "openai"),
    ref("oa-1"),
    ref("DEEPSEEK_API_KEY"),
    ref("ds-2", "constructor"),
    ref("ds-2", "__proto__"),
    { integrationID: "deepseek", connectionID: { id: "ds-2" } },
    ref("x".repeat(201)),
    { ...ref("ds-2"), scope: "somewhere else" },
  ]
  for (const input of rejected) {
    assert.equal((await host.handlers.refresh(input, call())).rpcError, "not_found", JSON.stringify(input))
  }
  assert.deepEqual([reads, host.record.resolved], [[], []])
  const result = await host.handlers.refresh(ref("ds-2"), call())
  assert.equal(result.status, "read")
  assert.deepEqual(reads, [{ id: "ds-2", key: MARK + "-2" }], "the requested inactive key, not the active one")
  const unsupported = await host.handlers.refresh(ref("oa-1", "openai"), call())
  assert.equal(unsupported.status, "unsupported")
  assert.equal(reads.length, 1)
  const snapshot = await host.handlers.snapshot({}, call())
  const backup = snapshot.integrations[0].connections.find((c) => c.id === "ds-2")
  assert.deepEqual(backup.samples, [{ source: "test-balance", ...balance() }])
  assert.equal(JSON.stringify(snapshot).includes(MARK), false)
  await stop()
})

test("a reader failure is a status and a reason, never the reader's message; backoff defers without a call", async () => {
  let fail = { reason: "rate-limit", retryAfter: 60_000, message: MARK }
  const { host, reads, stop, clock } = await start({ read: () => { if (fail) throw fail; return balance("2.00") } })
  const result = await host.handlers.refresh(ref("ds-1"), call())
  assert.equal(result.status, "failed")
  const failure = (await host.handlers.snapshot({}, call())).integrations[0].connections[0].failure
  assert.deepEqual(failure, { source: "test-balance", at: T0, reason: "rate-limit", retryAt: T0 + 60_000 }, "Retry-After honoured")
  assert.equal(JSON.stringify(failure).includes(MARK), false)
  clock.now = T0 + 59_999
  assert.equal((await host.handlers.refresh(ref("ds-1"), call())).status, "deferred")
  assert.equal(reads.length, 1, "no loop and no call while waiting")
  clock.now = T0 + 60_000
  fail = new Error(MARK)
  assert.equal((await host.handlers.refresh(ref("ds-1"), call())).status, "failed")
  const second = (await host.handlers.snapshot({}, call())).integrations[0].connections[0].failure
  assert.deepEqual([second.reason, second.retryAt - second.at], ["unknown", 30_000], "the wait grows after another failure")
  clock.now = second.retryAt
  fail = undefined
  assert.equal((await host.handlers.refresh(ref("ds-1"), call())).status, "failed", "a sample older than the failure is not decisive")
  await stop()
})

test("a huge Retry-After waits at most one hour, then the account is read again", async () => {
  let fail = { reason: "rate-limit", retryAfter: 999_999_000 }
  const { host, reads, stop, clock } = await start({ read: () => { if (fail) throw fail; return { ...balance(), observedAt: clock.now } } })
  assert.equal((await host.handlers.refresh(ref("ds-1"), call())).status, "failed")
  const failure = (await host.handlers.snapshot({}, call())).integrations[0].connections[0].failure
  assert.equal(failure.retryAt - failure.at, 3_600_000, "not 11.5 days")
  clock.now = failure.retryAt - 1
  assert.equal((await host.handlers.refresh(ref("ds-1"), call())).status, "deferred")
  assert.equal(reads.length, 1)
  clock.now = failure.retryAt
  fail = undefined
  assert.equal((await host.handlers.refresh(ref("ds-1"), call())).status, "read")
  assert.equal(reads.length, 2)
  await stop()
})

test("a good read after the wait clears an old auth failure from the snapshot", async () => {
  let fail = { reason: "auth" }
  const { host, stop, clock } = await start({ read: () => { if (fail) throw fail; return { ...balance(), observedAt: clock.now } } })
  assert.equal((await host.handlers.refresh(ref("ds-2"), call())).status, "failed")
  const { failure } = (await host.handlers.snapshot({}, call())).integrations[0].connections.find((c) => c.id === "ds-2")
  clock.now = failure.retryAt
  fail = undefined
  assert.equal((await host.handlers.refresh(ref("ds-2"), call())).status, "read")
  const backup = (await host.handlers.snapshot({}, call())).integrations[0].connections.find((c) => c.id === "ds-2")
  assert.deepEqual([backup.samples?.length, "failure" in backup], [1, false], "no Error or Reconnect required beside a current value")
  await stop()
})

test("one shared read per account and source, at most two external reads at once, cancelled on unload", async () => {
  const pending = []
  const { host, reads, stop } = await start({ read: ({ signal }) => new Promise((resolve, reject) => {
    pending.push(resolve)
    signal.addEventListener("abort", () => reject({ reason: "unknown" }))
  }) })
  host.integrations[0].connections.push({ type: "credential", id: "ds-3", label: "Third", method: "key" })
  const same = [host.handlers.refresh(ref("ds-1"), call()), host.handlers.refresh(ref("ds-1"), call())]
  const others = [host.handlers.refresh(ref("ds-2"), call()), host.handlers.refresh(ref("ds-3"), call())]
  await settle(20)
  assert.deepEqual(reads.map((r) => r.id), ["ds-1", "ds-2"], "deduplicated, and the third read waits for a slot")
  pending[0](balance())
  assert.deepEqual((await Promise.all(same)).map((r) => r.status), ["read", "read"])
  await settle(20)
  assert.deepEqual(reads.map((r) => r.id), ["ds-1", "ds-2", "ds-3"])
  await stop()
  assert.deepEqual((await Promise.all(others)).map((r) => r.status), ["failed", "failed"], "unload cancels reads in flight")
  const again = await start()
  const snapshot = await again.host.handlers.snapshot({}, call())
  assert.equal(JSON.stringify(snapshot).includes("samples"), false, "measurements do not survive a reload")
  await again.stop()
})

test("T09 fixture: two saves based on the same revision at the same time; one wins, the other gets a conflict", async () => {
  const storage = new Map()
  const { host, stop } = await start({ storage })
  const base = await host.handlers.snapshot({}, call())
  const save = (ids) => host.handlers.savePreferences({ revision: base.preferences.revision, threshold: 95, minimums: {}, order: { deepseek: ids } }, call())
  const results = await Promise.all([save(["ds-2", "ds-1"]), save(["ds-1", "ds-2"])])
  assert.deepEqual(results, [{ revision: 1 }, { rpcError: "conflict", message: "Preferences changed. Reload before saving.", data: {} }])
  const after = await host.handlers.snapshot({}, call())
  assert.deepEqual([after.preferences.revision, order(after)], [1, ["ds-2", "ds-1"]])
  assert.equal(after.integrations[0].connections.find((c) => c.active).id, "ds-1", "the native account is unchanged")
  assert.deepEqual(host.record.resolved, [], "saving never resolves or switches a credential")
  assert.deepEqual([...storage.keys()], ["preferences"])
  assert.deepEqual(Object.keys(storage.get("preferences")).sort(), ["minimums", "mode", "order", "revision", "schema", "threshold"])
  await stop()
})

test("T10: rename, lost connection, confirmed removal, new account, unknown schema and out-of-scope IDs", async () => {
  const storage = new Map()
  const { host, stop } = await start({ storage })
  const save = async (input) => host.handlers.savePreferences({ threshold: 95, minimums: {}, ...input }, call())
  host.integrations[0].connections.push({ type: "credential", id: "ds-3", label: "Third", method: "key" })
  assert.deepEqual(await save({ revision: 0, order: { deepseek: ["ds-3", "ds-2", "ds-1"] } }), { revision: 1 })

  host.integrations[0].connections[1].label = "Backup renamed"
  host.integrations[0].connections[0].status = { status: "needs_auth" }
  assert.deepEqual(order(await host.handlers.snapshot({}, call())), ["ds-3", "ds-2", "ds-1"], "rename and reconnect keep the order")
  host.failList = true
  assert.equal((await host.handlers.snapshot({}, call())).inventory, "unavailable")
  assert.equal((await save({ revision: 1, order: {} })).rpcError, "unavailable", "no save without a verifiable inventory")
  host.failList = false
  assert.deepEqual(storage.get("preferences").order.deepseek, ["ds-3", "ds-2", "ds-1"], "a timeout does not delete preferences")

  host.integrations[0].connections = host.integrations[0].connections.filter((c) => c.id !== "ds-2")
  host.integrations[0].connections.push({ type: "credential", id: "ds-4", label: "New", method: "key" })
  assert.deepEqual(order(await host.handlers.snapshot({}, call())), ["ds-3", "ds-1", "ds-4"], "removed retired, new last")

  for (const bad of [
    { revision: 1, order: { deepseek: ["ds-2"] } },
    { revision: 1, order: { deepseek: ["oa-1"] } },
    { revision: 1, order: { openai: ["ds-1"] } },
    { revision: 1, order: { deepseek: ["ds-1", "ds-1"] } },
    { revision: 1, order: { other: [] } },
    { revision: 1, order: {}, threshold: 89 },
    { revision: 1, order: {}, minimums: { usd: "1" } },
    { revision: 1, order: {}, minimums: { EUR: "1" } },
    { revision: 1, order: {}, minimums: { USD: "-1" } },
    { revision: 1, order: {}, mode: "switch" },
  ]) assert.equal((await save(bad)).rpcError, "invalid", JSON.stringify(bad))
  assert.equal(storage.get("preferences").revision, 1, "nothing unauthorised was stored")
  assert.deepEqual(await save({ revision: 1, order: { deepseek: ["ds-4", "ds-1"] }, minimums: { USD: "1.10" }, threshold: 90 }), { revision: 2 })
  assert.deepEqual(order(await host.handlers.snapshot({}, call())), ["ds-4", "ds-1", "ds-3"])

  storage.set("preferences", { schema: 99, revision: 7, future: true })
  const unknown = await host.handlers.snapshot({}, call())
  assert.deepEqual(unknown.preferences, { state: "unsupported" })
  assert.equal((await save({ revision: 7, order: {} })).rpcError, "unavailable")
  assert.deepEqual(storage.get("preferences"), { schema: 99, revision: 7, future: true }, "never overwritten with defaults")
  await stop()
})

test("T10: new preferences start at USD 0.20; a stored {} or an unknown schema is never rewritten by loading", async () => {
  const writes = []
  const watched = (map) => ({ get: (key) => map.get(key), set: (key, value) => (writes.push(key), map.set(key, value)) })
  const fresh = new Map()
  const first = await start({ storage: watched(fresh) })
  assert.deepEqual((await first.host.handlers.snapshot({}, call())).preferences.minimums, { USD: "0.20" })
  assert.deepEqual([[...fresh.keys()], writes], [[], []], "defaults are shown, not written")
  await first.stop()

  const off = { schema: 1, revision: 4, mode: "recommend", threshold: 92, order: { deepseek: ["ds-2", "ds-1"] }, minimums: {} }
  const kept = new Map([["preferences", off]])
  const second = await start({ storage: watched(kept) })
  for (let i = 0; i < 2; i += 1) {
    const view = (await second.host.handlers.snapshot({}, call())).preferences
    assert.deepEqual(view, { state: "available", revision: 4, mode: "recommend", threshold: 92, minimums: {} }, "{} stays off")
  }
  assert.deepEqual([kept.get("preferences"), writes], [off, []])
  await second.stop()
})

test("one read of the preferences per save or snapshot; the active connections are asked at once, one failure stays its own", async () => {
  const gets = {}
  const map = new Map()
  const counted = { get: (key) => ((gets[key] = (gets[key] ?? 0) + 1), map.get(key)), set: (key, value) => map.set(key, value) }
  const { host, stop } = await start({ storage: counted })
  assert.deepEqual(await host.handlers.savePreferences({ revision: 0, threshold: 93, minimums: { USD: "0.20" }, order: {} }, call()), { revision: 1 })
  assert.equal(gets.preferences, 1, "a valid save reads the preferences once")
  await host.handlers.snapshot({}, call())
  assert.equal(gets.preferences, 2, "a snapshot reads them once")

  // deepseek and openai are listed: both active() calls are in flight together.
  const active = host.ctx.integration.connection.active
  let open = 0
  let peak = 0
  host.ctx.integration.connection.active = async (id) => {
    open += 1
    peak = Math.max(peak, open)
    await settle(30)
    open -= 1
    if (id === "openai") throw new Error("unreadable")
    return active(id)
  }
  const snapshot = await host.handlers.snapshot({}, call())
  assert.equal(peak, 2)
  assert.deepEqual(snapshot.integrations.map((item) => [item.id, item.active]), [["deepseek", "connection"], ["openai", "unknown"]])
  host.ctx.integration.connection.active = (id) => { if (id === "openai") throw new Error("sync"); return active(id) }
  assert.deepEqual((await host.handlers.snapshot({}, call())).integrations.map((item) => item.active), ["connection", "unknown"], "a synchronous throw too")
  await stop()
})

test("T10: the notice minimum is saved with the read revision; order, threshold and the other currency are kept", async () => {
  const storage = new Map()
  const { host, stop } = await start({ storage })
  const save = (input) => host.handlers.savePreferences(input, call())
  assert.deepEqual(await save({ revision: 0, threshold: 93, minimums: { USD: "0.20", CNY: "5" }, order: { deepseek: ["ds-2", "ds-1"] } }), { revision: 1 })
  const base = await host.handlers.snapshot({}, call())
  const usd = setAmount(startMinimum(base), "0.35")
  const other = turnOff(shiftCurrency(startMinimum(base), 1))
  assert.deepEqual(await save(proposalFrom(base, usd)), { revision: 2 })
  assert.deepEqual(storage.get("preferences"), { schema: 1, revision: 2, mode: "recommend", threshold: 93,
    order: { deepseek: ["ds-2", "ds-1"], openai: ["oa-1"] }, minimums: { USD: "0.35", CNY: "5" } })
  assert.equal((await save(proposalFrom(base, other))).rpcError, "conflict", "a second TUI editing from revision 1")
  assert.deepEqual(storage.get("preferences").minimums, { USD: "0.35", CNY: "5" }, "the conflict wrote nothing")
  const again = await host.handlers.snapshot({}, call())
  assert.deepEqual(await save(proposalFrom(again, turnOff(shiftCurrency(startMinimum(again), 1)))), { revision: 3 })
  assert.deepEqual(storage.get("preferences").minimums, { USD: "0.35" }, "CNY off after reloading")
  assert.deepEqual(await save(proposalFrom(await host.handlers.snapshot({}, call()), { ...startMinimum(again), revision: 3, minimums: {} })), { revision: 4 })
  assert.deepEqual((await host.handlers.snapshot({}, call())).preferences.minimums, {}, "both off is stored as {}")
  for (const minimums of [{ USD: "0,20" }, { USD: 0.2 }, { USD: "1e3" }, { CNY: "-0" }, { EUR: "1" }]) {
    assert.equal((await save({ revision: 4, threshold: 93, minimums, order: {} })).rpcError, "invalid", JSON.stringify(minimums))
  }
  assert.equal(storage.get("preferences").revision, 4)
  await stop()
})

test("simultaneous native events become one `changed` with only a newer revision; unload stops it", async () => {
  const { host, stop } = await start()
  assert.deepEqual(host.record.subscribed, [["credential.updated", "credential.switched", "integration.updated"],
    ["session.step.started", "session.execution.started", "session.execution.succeeded", "session.execution.failed"],
    ["session.model.selected"]], "native events, then the route subscriptions (R4), which act only for sessions set to preview")
  const before = (await host.handlers.snapshot({}, call())).revision
  host.events.push({ type: "credential.switched", data: { integrationID: "deepseek", credentialID: "ds-2" } })
  host.events.push({ type: "integration.updated", data: {} })
  await settle()
  assert.deepEqual(host.record.emitted, [["changed", { revision: before + 1 }]])
  assert.equal((await host.handlers.snapshot({}, call())).revision, before + 1)
  await stop()
  host.events.push({ type: "credential.updated", data: {} })
  await settle()
  assert.equal(host.record.emitted.length, 1)
})
