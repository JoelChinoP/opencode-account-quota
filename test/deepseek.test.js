// B06 DeepSeek balance with HTTP and credential doubles (FIXTURE: T13, T14). No request leaves the process.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createDeepseekReader, parseBalance } from "../deepseek.js"
import { parseStored } from "../preferences.js"
import { compareDecimal, recommend } from "../rules.js"
import { createPlugin } from "../server.js"
import { call, contract, fakeHost, settle } from "./host.js"

const T0 = Date.UTC(2026, 10, 24, 12)
const KEY = (id) => `SYNTHETIC-DEEPSEEK-${id}`
const body = (balances, available = true) => JSON.stringify({
  is_available: available,
  balance_infos: balances.map(([currency, total]) => ({ currency, total_balance: total, granted_balance: "0.00", topped_up_balance: total })),
})
const reply = (status, text = "", headers = {}) => new Response(status === 204 || (status >= 300 && status < 400) ? null : text, { status, headers })

function transport(handler) {
  const requests = []
  let open = 0
  let peak = 0
  const send = async (url, init) => {
    open += 1
    peak = Math.max(peak, open)
    requests.push({ url, method: init.method, redirect: init.redirect, auth: init.headers.Authorization })
    try {
      return await handler(url, init, requests.length)
    } finally {
      open -= 1
    }
  }
  return { send, requests, peak: () => peak }
}

async function server(handler, ids = ["ds-1", "ds-2", "ds-3"], options = {}) {
  const net = transport(handler)
  const host = fakeHost({
    integrations: [{ id: "deepseek", connections: ids.map((id) => ({ type: "credential", id, label: id, method: "key" })) }],
    active: { deepseek: { type: "credential", id: ids[0] } },
    credentials: Object.fromEntries(ids.map((id) => [id, { type: "key", key: KEY(id) }])),
  })
  const plugin = createPlugin({ contract, now: () => T0, readers: { deepseek: createDeepseekReader({ send: net.send, now: () => T0, ...options }) } })
  const stop = await plugin.setup(host.ctx)
  const refresh = (connectionID) => host.handlers.refresh({ integrationID: "deepseek", connectionID }, call())
  const account = async (id) => (await host.handlers.snapshot({}, call())).integrations[0].connections.find((c) => c.id === id)
  return { net, host, stop, refresh, account }
}

test("T13: reads the requested connection's own key at the fixed official endpoint; currencies stay separate", async () => {
  const { net, stop, refresh, account } = await server(() => reply(200, body([["USD", "8.42"], ["CNY", "0.00"]])))
  assert.equal((await refresh("ds-2")).status, "read")
  assert.deepEqual(net.requests, [{ url: "https://api.deepseek.com/user/balance", method: "GET", redirect: "manual", auth: `Bearer ${KEY("ds-2")}` }])
  const backup = await account("ds-2")
  assert.deepEqual(backup.samples, [{ source: "deepseek-balance", window: "balance", scope: "general", observedAt: T0, available: true,
    balances: [{ currency: "USD", total: "8.42" }, { currency: "CNY", total: "0.00" }] }])
  assert.equal(JSON.stringify(backup).includes("SYNTHETIC"), false)
  await stop()
})

test("T13: response validation: decimals preserved, absent or malformed amounts are not zero", () => {
  assert.deepEqual(parseBalance(body([["USD", "1.1000000001"]])), { available: true, balances: [{ currency: "USD", total: "1.1000000001" }] })
  for (const bad of [
    "{", "null", JSON.stringify({ balance_infos: [] }), JSON.stringify({ is_available: true }), JSON.stringify({ is_available: true, balance_infos: [] }),
    JSON.stringify({ is_available: "yes", balance_infos: [{ currency: "USD", total_balance: "1" }] }),
    JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD" }] }),
    JSON.stringify({ is_available: true, balance_infos: [{ total_balance: "1" }] }),
    JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: 1.1 }] }),
    JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1e3" }] }),
    body([["USD", "1"], ["USD", "2"]]),
  ]) assert.equal(parseBalance(bad), undefined, bad)
})

test("T13: exact decimal minimum per currency, on the active account's balance; currencies are never added", () => {
  assert.equal(compareDecimal("1.10", "1.1000"), 0)
  assert.equal(compareDecimal("1.1000000001", "1.10"), 1)
  assert.equal(compareDecimal("0.00", "0"), 0)
  assert.equal(compareDecimal("-0.5", "0"), -1)
  const sel = { providerID: "deepseek", modelID: "deepseek-chat" }
  const sample = (id, balances) => ({ integrationID: "deepseek", connectionID: id, source: "deepseek-balance", window: "balance", scope: "general", observedAt: T0, available: true, balances })
  const run = (source, minimums = { USD: "1.10" }) => recommend({
    integration: { id: "deepseek", connections: ["A", "B"].map((id) => ({ id, label: id, method: "key", active: id === "A" })) },
    selection: sel, threshold: 95, minimums, now: T0 + 1, samples: [sample("A", source), sample("B", [{ currency: "USD", total: "9" }])],
  })
  assert.equal(run([{ currency: "USD", total: "1.1000000001" }]).kind, "idle", "above the minimum")
  const equal = run([{ currency: "USD", total: "1.1000" }])
  assert.deepEqual([equal.kind, equal.trigger.text], ["none", "Low balance: USD 1.1000"], "equal to 1.10 triggers (<=)")
  assert.equal(run([{ currency: "USD", total: "0.00" }, { currency: "CNY", total: "500" }]).trigger.text,
    "Low balance: USD 0.00", "CNY is never added to or converted into USD")
  assert.equal(run([{ currency: "USD", total: "0" }], {}).kind, "idle", "no minimum: report only")
})

test("T13: new preferences notify at USD 0.20 or below, on the active account's fresh balance only; CNY has no default", () => {
  const defaults = parseStored(undefined).value.minimums
  assert.deepEqual(defaults, { USD: "0.20" }, "USD 0.20 for new preferences; CNY only if the user sets one")
  assert.deepEqual(parseStored({ schema: 1, revision: 4, mode: "recommend", threshold: 95, order: {}, minimums: {} }).value.minimums, {},
    "a stored {} is off and stays off")
  const sel = { providerID: "deepseek", modelID: "deepseek-chat" }
  const sample = (id, balances, observedAt = T0) => ({ integrationID: "deepseek", connectionID: id, source: "deepseek-balance", window: "balance", scope: "general", observedAt, available: true, balances })
  const run = (active, samples, minimums = defaults, now = T0 + 1) => recommend({
    integration: { id: "deepseek", connections: ["A", "B"].map((id) => ({ id, label: id, method: "key", active: id === active })) },
    selection: sel, threshold: 95, minimums, now, samples,
  })
  const at = (total, currency = "USD") => [sample("A", [{ currency, total }]), sample("B", [{ currency: "USD", total: "0.01" }])]
  const low = run("A", at("0.20"))
  assert.deepEqual([low.kind, low.trigger.text], ["none", "Low balance: USD 0.20"], "<= 0.20 notifies (no proven alternative)")
  assert.deepEqual(run("A", at("0.21")), { kind: "idle", measured: ['["balance","USD"]'] }, "0.21 does not, and it is a fresh measurement")
  assert.equal(run("A", at("0.2000")).kind, "none", "exact decimal: 0.2000 equals 0.20")
  assert.equal(run("A", at("0.2000000001")).kind, "idle")
  assert.equal(run("B", at("9.00")).kind, "none", "only the active account counts: B at 0.01 notifies when B is active")
  assert.equal(run("A", at("9.00")).kind, "idle", "an inactive low account never notifies")
  assert.equal(run("A", at("0.10"), defaults, T0 + 120_000).kind, "idle", "a stale balance does not notify")
  assert.deepEqual(run("A", at("0.10"), defaults, T0 + 120_000).measured, [], "and it is not a measured recovery")
  assert.equal(run("A", at("0.05", "CNY")).kind, "idle", "CNY has no default minimum and never compares with USD")
  assert.equal(run("A", at("0.05", "CNY"), { CNY: "0" }).kind, "idle", "CNY 0 is a minimum: 0.05 is above it")
  assert.equal(run("A", at("0", "CNY"), { CNY: "0" }).kind, "none", "CNY 0 notifies at zero; off would not")
  assert.equal(run("A", at("0.10"), {}).kind, "idle", "{} is off: balance only")
})

test("T14: 401, 402, 429 with Retry-After, redirect, 5xx, malformed and oversized bodies become explicit states", async () => {
  const cases = [
    [() => reply(401, "{\"error\":\"SYNTHETIC\"}"), "auth"],
    [() => reply(402), "balance"],
    [() => reply(429, "", { "retry-after": "120" }), "rate-limit", 120_000],
    [() => reply(302, "", { location: "https://example.invalid/" }), "redirect"],
    [() => reply(503), "http"],
    [() => reply(200, "<html>"), "invalid"],
    [() => reply(200, "x".repeat(70_000)), "too-large"],
    [() => new Response(new Uint8Array([0x7b, 0xff]), { status: 200 }), "invalid"],
  ]
  for (const [handler, reason, wait] of cases) {
    const { net, stop, refresh, account } = await server(handler)
    assert.equal((await refresh("ds-1")).status, "failed", reason)
    const failure = (await account("ds-1")).failure
    assert.deepEqual([failure.reason, failure.retryAt - failure.at], [reason, wait ?? 15_000], reason)
    assert.equal(JSON.stringify(failure).includes("SYNTHETIC"), false)
    assert.equal((await refresh("ds-1")).status, "deferred", "no retry loop")
    assert.equal(net.requests.length, 1, `${reason}: one request, redirects not followed`)
    await stop()
  }
})

test("T14: timeout and unload cancel the request; a missing key is not sent anywhere", async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
  const slow = await server(hang, undefined, { timeout: 30 })
  assert.equal((await slow.refresh("ds-1")).status, "failed")
  assert.equal((await slow.account("ds-1")).failure.reason, "timeout")
  await slow.stop()
  const unload = await server(hang)
  const pending = unload.refresh("ds-2")
  await settle(10)
  await unload.stop()
  assert.equal((await pending).status, "failed", "unload aborts the read in flight")
  const keyless = await server(() => reply(200, body([["USD", "1"]])))
  keyless.host.integrations[0].connections.push({ type: "credential", id: "oauth-1", label: "x", method: "oauth" })
  assert.equal((await keyless.refresh("oauth-1")).status, "failed")
  assert.equal(keyless.net.requests.length, 0)
  await keyless.stop()
})

test("T14: two clients share one read per account; three accounts never exceed two requests in flight", async () => {
  const gates = []
  const { net, host, stop, refresh } = await server(() => new Promise((resolve) => gates.push(() => resolve(reply(200, body([["USD", "5"]]))))))
  const second = fakeHost({ integrations: host.integrations, active: host.active })
  const plugin = createPlugin({ contract, readers: { deepseek: createDeepseekReader({ send: net.send, now: () => T0 }) } })
  const stopSecond = await plugin.setup(second.ctx)
  // Second "client" refreshes the same account through another location's instance of the same server.
  second.ctx.integration.connection.resolve = host.ctx.integration.connection.resolve
  const runs = [refresh("ds-1"), second.handlers.refresh({ integrationID: "deepseek", connectionID: "ds-1" }, call()), refresh("ds-2"), refresh("ds-3")]
  await settle(20)
  assert.equal(net.requests.length, 2, "ds-1 shared, ds-3 waits for a slot")
  while (gates.length > 0) {
    gates.shift()()
    await settle(20)
  }
  assert.deepEqual((await Promise.all(runs)).map((r) => r.status), ["read", "read", "read", "read"])
  assert.deepEqual([net.requests.length, net.peak()], [3, 2])
  await stopSecond()
  await stop()
})
