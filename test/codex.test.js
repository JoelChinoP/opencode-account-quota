// E06 Codex legacy usage, experimental (FIXTURE: T29). HTTP and credential doubles only; no request leaves the
// process and no real account is involved. The HOST side (T30) runs in scripts/check-host.py.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createCodexReader, parseUsage } from "../codex.js"
import { createPlugin } from "../server.js"
import { batchRefs, batchSummary, decide, staleRefs } from "../view.js"
import { call, contract, fakeHost, settle } from "./host.js"

const T0 = Date.UTC(2026, 10, 24, 12)
const MARK = "SYNTHETIC-CODEX-T29"
const URL_ = "https://chatgpt.com/backend-api/wham/usage"
const window = (seconds, used, extra = {}) => ({ used_percent: used, limit_window_seconds: seconds, ...extra })
const usage = (primary, secondary, extra = {}) => JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: primary, secondary_window: secondary }, ...extra })
const reply = (status, text = "", headers = {}) => new Response(status === 204 || (status >= 300 && status < 400) ? null : text, { status, headers })
const login = (methodID, account = `${MARK}-account-${methodID}`, extra = {}) => ({
  type: "oauth", methodID, access: `${MARK}-access-${methodID}`, refresh: `${MARK}-refresh`, expires: T0 + 86_400_000,
  metadata: { accountID: account }, ...extra,
})

function transport(handler = () => reply(200, usage(window(18_000, 42, { reset_at: (T0 + 3_600_000) / 1000 }), window(604_800, 61, { reset_after_seconds: 86_400 })))) {
  const requests = []
  const send = async (url, init) => {
    requests.push({ url, method: init.method, redirect: init.redirect, headers: { ...init.headers } })
    return handler(url, init, requests.length)
  }
  return { send, requests }
}

// One OpenAI integration with four logins; `active` picks the native active one. Nothing here is a real account.
async function server({ options = { experimentalCodexUsage: true }, active = "oa-browser", handler, credentials = {}, timeout = 50, claude } = {}) {
  const net = transport(handler)
  const clock = { t: T0 }
  const now = () => clock.t
  const logins = {
    "oa-browser": login("chatgpt-browser"),
    "oa-headless": login("chatgpt-headless"),
    "oa-siwc": login("chatgpt-token-sharing"),
    "oa-key": { type: "key", key: `${MARK}-api-key` },
    ...credentials,
  }
  const host = fakeHost({
    integrations: [{
      id: "openai", name: "OpenAI", methods: [],
      connections: Object.keys(logins).map((id) => ({ type: "credential", id, label: id, method: logins[id].type === "key" ? "key" : "oauth" })),
    }],
    active: { openai: { type: "credential", id: active } },
    credentials: logins,
  })
  if (options) host.ctx.options = options
  const plugin = createPlugin({ contract, now, claude, experimental: { openai: createCodexReader({ send: net.send, now, timeout }) } })
  const stop = await plugin.setup(host.ctx)
  const refresh = (connectionID, manual = true) => host.handlers.refresh({ integrationID: "openai", connectionID, ...(manual ? { manual: true } : {}) }, call())
  const snapshot = () => host.handlers.snapshot({}, call())
  const account = async (id) => (await snapshot()).integrations[0].connections.find((c) => c.id === id)
  const refreshAll = async () => Promise.all(batchRefs(await snapshot()).map((ref) => host.handlers.refresh({ ...ref, manual: true }, call())))
  return { net, host, stop, refresh, refreshAll, snapshot, account, logins, clock, plugin }
}

// A transport double that holds every request until `release()`, answers by the token it received and counts how
// many requests were in flight at once.
function held(answers = {}) {
  let open = 0
  let max = 0
  let release
  const ready = new Promise((resolve) => (release = resolve))
  const handler = async (_url, init) => {
    open += 1
    max = Math.max(max, open)
    try {
      await ready
      const answer = answers[init.headers.Authorization.slice("Bearer ".length)] ?? 50
      return typeof answer === "function" ? answer() : reply(200, usage(window(18_000, answer), window(604_800, 10)))
    } finally {
      open -= 1
    }
  }
  return { handler, release: () => release(), max: () => max, open: () => open }
}
const second = (account) => ({ "oa-browser-2": login("chatgpt-browser", `${MARK}-account-${account}`, { access: `${MARK}-access-browser-2` }) })
const pairs = (requests) => requests.map((r) => [r.url, r.method, r.redirect, r.headers.Authorization, r.headers["ChatGPT-Account-Id"]]).sort()
const own = (logins, ...ids) => ids.map((id) => [URL_, "GET", "manual", `Bearer ${logins[id].access}`, logins[id].metadata.accountID]).sort()

test("T29: windows are named by their duration, never by position; resets from reset_at or reset_after_seconds", () => {
  const observed = T0
  const swapped = parseUsage(usage(window(604_800, 61, { reset_at: 1_795_000_000 }), window(18_000, 42, { reset_after_seconds: 3_600 })), observed)
  assert.deepEqual(swapped, [
    { window: "weekly", scope: "general", observedAt: T0, used: 61, resetsAt: 1_795_000_000_000 },
    { window: "5h", scope: "general", observedAt: T0, used: 42, resetsAt: T0 + 3_600_000 },
  ])
  assert.deepEqual(parseUsage(usage(window(18_000, 0), null), observed), [{ window: "5h", scope: "general", observedAt: T0, used: 0 }], "a real 0, no reset invented")
  assert.deepEqual(parseUsage(usage(window(2_628_000, 10), window(604_800, 100)), observed).map((s) => [s.window, s.used]), [["weekly", 100]],
    "an unknown duration is ignored, not relabelled")
  assert.equal(parseUsage(usage(window(18_000, 40), window(18_000, 41)), observed), undefined, "same duration, different values: ambiguous, dropped")
  assert.deepEqual(parseUsage(usage(window(18_000, 40), window(18_000, 40)), observed).length, 1, "an identical duplicate is one window")
  for (const bad of [101, -1, NaN, "50", null, undefined]) {
    assert.equal(parseUsage(usage(window(18_000, bad), null), observed), undefined, `used_percent ${bad}`)
  }
  for (const reset of [{ reset_at: "soon" }, { reset_at: 9e15 }, { reset_after_seconds: -5 }, { reset_after_seconds: "1" }]) {
    assert.equal(parseUsage(usage(window(18_000, 40, reset), null), observed), undefined, JSON.stringify(reset))
  }
  for (const text of ["{", "null", "[]", JSON.stringify({ rate_limit: null }), JSON.stringify({ rate_limit: {} }), usage(window(18_000), null)]) {
    assert.equal(parseUsage(text, observed), undefined, text)
  }
})

test("T29: off by default; when enabled it is manual-only and never read when the view opens", async () => {
  for (const options of [null, {}, { experimentalCodexUsage: false }, { experimentalCodexUsage: "true" }, { experimentalCodexUsage: 1 }]) {
    const off = await server({ options })
    try {
      const view = await off.snapshot()
      assert.deepEqual([view.integrations[0].refreshable, "manual" in view.integrations[0]], [false, false], JSON.stringify(options))
      assert.equal((await off.refresh("oa-browser")).status, "unsupported")
      assert.deepEqual([off.net.requests.length, off.host.record.resolved], [0, []])
    } finally {
      await off.stop()
    }
  }
  const on = await server()
  const view = await on.snapshot()
  assert.deepEqual([view.integrations[0].refreshable, view.integrations[0].manual], [true, true])
  assert.deepEqual(staleRefs(view, T0), [], "opening the view lists no Codex read")
  assert.equal(decide(view, { providerID: "openai", modelID: "m" }, T0).kind, "idle")
  assert.equal((await on.refresh("oa-browser", false)).status, "unsupported", "a refresh without `manual` (view open) is refused")
  assert.equal((await on.refresh("oa-headless", false)).status, "unsupported", "active or not, never without `manual`")
  assert.deepEqual([on.net.requests.length, on.host.record.resolved], [0, []], "refused before resolving anything")
  for (const bad of [{ manual: false }, { manual: "yes" }, { manual: 1 }]) {
    const answer = await on.host.handlers.refresh({ integrationID: "openai", connectionID: "oa-browser", ...bad }, call())
    assert.equal(answer.rpcError, "not_found", JSON.stringify(bad))
  }
  await on.stop()
})

test("T29: the active Codex legacy login is read once at the fixed endpoint with its own token and account", async () => {
  for (const id of ["oa-browser", "oa-headless"]) {
    const { net, refresh, account, snapshot, logins, stop, host } = await server({ active: id })
    assert.equal((await refresh(id)).status, "read")
    assert.deepEqual(net.requests, [{ url: URL_, method: "GET", redirect: "manual", headers: {
      Authorization: `Bearer ${logins[id].access}`, "ChatGPT-Account-Id": logins[id].metadata.accountID, Accept: "application/json" } }])
    assert.deepEqual((await account(id)).samples, [
      { source: "codex-usage", window: "5h", scope: "general", observedAt: T0, used: 42, resetsAt: T0 + 3_600_000 },
      { source: "codex-usage", window: "weekly", scope: "general", observedAt: T0, used: 61, resetsAt: T0 + 86_400_000 },
    ])
    assert.deepEqual(host.record.resolved, [id, id], "resolved for the request and once more to confirm the same login")
    const all = JSON.stringify({ view: await snapshot(), emitted: host.record.emitted })
    assert.equal(all.includes(MARK), false, "no token, account ID or refresh token in the DTO or events")
    await stop()
  }
})

test("T29: Sign in with ChatGPT, API keys and logins without a native Codex methodID or account are not read", async () => {
  const cases = {
    "oa-siwc": undefined,
    "oa-key": undefined,
    "oa-none": { type: "oauth", access: `${MARK}-a`, refresh: "r", expires: T0 + 1e6, metadata: { accountID: `${MARK}-acc` } },
    "oa-other": login("codex-cli"),
    "oa-noaccount": login("chatgpt-browser", undefined, { metadata: {} }),
    "oa-emptyaccount": login("chatgpt-browser", ""),
    "oa-notoken": login("chatgpt-browser", `${MARK}-acc`, { access: "" }),
  }
  for (const [id, credential] of Object.entries(cases)) {
    const { net, refresh, account, host, stop } = await server({ active: id, credentials: credential ? { [id]: credential } : {} })
    assert.equal((await refresh(id)).status, "failed", id)
    const failure = (await account(id)).failure
    assert.deepEqual([failure.reason, failure.source], ["login", "codex-usage"], id)
    assert.equal(net.requests.length, 0, `${id}: no request`)
    assert.deepEqual(host.record.resolved, id === "oa-key" ? [] : [id], `${id}: an API key is not even resolved`)
    assert.equal((await account(id)).samples, undefined)
    await stop()
  }
  const expired = await server({ credentials: { "oa-browser": login("chatgpt-browser", `${MARK}-acc`, { expires: T0 }) } })
  assert.equal((await expired.refresh("oa-browser")).status, "failed")
  assert.deepEqual([(await expired.account("oa-browser")).failure.reason, expired.net.requests.length], ["auth", 0], "an expired token is not sent")
  await expired.stop()
})

test("T29: 401, 429 with Retry-After, redirect, 5xx, malformed, oversized and timeout are explicit; no retry", async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
  const cases = [
    [() => reply(401, `{"detail":"${MARK}"}`), "auth"],
    [() => reply(429, `{"detail":"${MARK}"}`, { "retry-after": "90" }), "rate-limit", 90_000],
    [() => reply(302, "", { location: "https://example.invalid/" }), "redirect"],
    [() => reply(403, `<html>${MARK}</html>`), "http"],
    [() => reply(503), "http"],
    [() => reply(200, `<html>${MARK}</html>`), "invalid"],
    [() => reply(200, usage(window(18_000, 140), null)), "invalid"],
    [() => reply(200, "x".repeat(70_000)), "too-large"],
    [hang, "timeout"],
  ]
  for (const [handler, reason, wait] of cases) {
    const { net, refresh, account, stop } = await server({ handler })
    assert.equal((await refresh("oa-browser")).status, "failed", reason)
    const { failure, samples } = await account("oa-browser")
    assert.deepEqual([failure.reason, failure.retryAt - failure.at, samples], [reason, wait ?? 15_000, undefined], reason)
    assert.equal(JSON.stringify(failure).includes(MARK), false)
    assert.equal((await refresh("oa-browser")).status, "deferred", `${reason}: no retry loop`)
    assert.equal(net.requests.length, 1, `${reason}: one request, redirects not followed`)
    await stop()
  }
})

test("T29: a switch, removal or re-login while the request is out drops the answer instead of charging another account", async () => {
  const gate = () => {
    let open
    const ready = new Promise((resolve) => (open = resolve))
    return { ready, open, handler: () => ready.then(() => reply(200, usage(window(18_000, 97), window(604_800, 20)))) }
  }
  // Switch: the user activates another login while the read is out. The reference asked for is still the same
  // login, so its numbers stay with it; the account active now gets nothing.
  const switched = gate()
  const a = await server({ handler: switched.handler })
  const pending = a.refresh("oa-browser")
  await settle(10)
  a.host.active.openai = { type: "credential", id: "oa-headless" }
  a.host.events.push({ type: "credential.switched", data: { integrationID: "openai", credentialID: "oa-headless" } })
  await settle(10)
  switched.open()
  assert.equal((await pending).status, "read")
  assert.deepEqual([(await a.account("oa-browser")).samples.map((s) => s.used), (await a.account("oa-browser")).active, (await a.account("oa-headless")).samples],
    [[97, 20], false, undefined], "a switch meanwhile never moves a reading to the account active now")
  await a.stop()

  // Removal while the request is out: the reference is no longer listed, so the answer is dropped.
  const removed = gate()
  const b = await server({ handler: removed.handler })
  const gone = b.refresh("oa-browser")
  await settle(10)
  b.host.integrations[0].connections = b.host.integrations[0].connections.filter((row) => row.id !== "oa-browser")
  removed.open()
  assert.equal((await gone).status, "failed")
  assert.equal(await b.account("oa-browser"), undefined, "a removed reference is not shown at all")
  assert.equal(b.net.requests.length, 1)
  await b.stop()

  // Sign-in required meanwhile (native status): the reference is no longer usable the same way; dropped.
  const signout = gate()
  const e = await server({ handler: signout.handler })
  const out = e.refresh("oa-browser")
  await settle(10)
  e.host.integrations[0].connections.find((row) => row.id === "oa-browser").status = { status: "needs_auth", message: MARK }
  signout.open()
  assert.equal((await out).status, "failed")
  assert.deepEqual([(await e.account("oa-browser")).failure.reason, (await e.account("oa-browser")).samples], ["changed", undefined])
  assert.equal((await e.refresh("oa-browser")).status, "unsupported", "Reconnect required: not read until signed in again")
  await e.stop()

  // Re-login under the same reference (another ChatGPT account), no event delivered yet: the second resolve sees it.
  const relogin = gate()
  const c = await server({ handler: relogin.handler })
  const again = c.refresh("oa-browser")
  await settle(10)
  c.logins["oa-browser"].metadata.accountID = `${MARK}-another-account`
  relogin.open()
  assert.equal((await again).status, "failed")
  assert.deepEqual([(await c.account("oa-browser")).failure.reason, (await c.account("oa-browser")).samples], ["changed", undefined])
  assert.equal(JSON.stringify(await c.snapshot()).includes(MARK), false)
  await c.stop()

  // Native token renewal under the same reference and account: same login, the reading stays. Identity is the
  // native methodID and account, never the token's content.
  const renewed = gate()
  const f = await server({ handler: renewed.handler })
  const kept = f.refresh("oa-browser")
  await settle(10)
  f.logins["oa-browser"].access = `${MARK}-renewed-access`
  renewed.open()
  assert.equal((await kept).status, "read")
  await f.stop()

  // A read that completes while nothing changed stays with its reference after a later switch.
  const d = await server()
  assert.equal((await d.refresh("oa-browser")).status, "read")
  d.host.active.openai = { type: "credential", id: "oa-headless" }
  const later = await d.snapshot()
  assert.deepEqual(later.integrations[0].connections.filter((c) => c.samples).map((c) => [c.id, c.active]), [["oa-browser", false]],
    "the numbers stay with the login they were read for, not with the account active now")
  await d.stop()
})

test("T29: r on an inactive legacy login reads that login only, with its own token and account; the active one stays", async () => {
  const { net, refresh, account, host, logins, stop } = await server({ active: "oa-browser" })
  assert.equal((await refresh("oa-headless")).status, "read")
  assert.deepEqual(pairs(net.requests), own(logins, "oa-headless"))
  assert.deepEqual([(await account("oa-headless")).samples.map((s) => [s.window, s.used]), (await account("oa-headless")).active],
    [[["5h", 42], ["weekly", 61]], false])
  assert.equal((await account("oa-browser")).samples, undefined, "the active login gets nothing from another's read")
  assert.deepEqual([host.active.openai, host.record.resolved], [{ type: "credential", id: "oa-browser" }, ["oa-headless", "oa-headless"]],
    "measuring never switches the active account")
  await stop()
})

test("T29: Refresh all Codex accounts: one request per legacy login, own token and account; SIWC and the key make none", async () => {
  const { net, refreshAll, account, host, logins, snapshot, stop } = await server({ active: "oa-siwc" })
  assert.deepEqual(batchRefs(await snapshot()).map((r) => r.connectionID), ["oa-browser", "oa-headless", "oa-siwc"],
    "OAuth logins only: the API key is not a candidate and is never resolved")
  const statuses = await refreshAll()
  assert.deepEqual(statuses.map((s) => s.status), ["read", "read", "failed"])
  assert.equal(batchSummary(statuses.map((s) => s.status)), "Refresh all: 2 read · 1 failed.")
  assert.deepEqual(pairs(net.requests), own(logins, "oa-browser", "oa-headless"), "two requests, fixed destination, each with its own login")
  assert.deepEqual([...host.record.resolved].sort(), ["oa-browser", "oa-browser", "oa-headless", "oa-headless", "oa-siwc"],
    "SIWC is resolved once to read its method, then no network; the key is not resolved")
  for (const id of ["oa-browser", "oa-headless"]) assert.equal((await account(id)).samples.length, 2, id)
  assert.deepEqual([(await account("oa-siwc")).failure.reason, (await account("oa-siwc")).samples], ["login", undefined])
  assert.deepEqual([(await account("oa-key")).failure, (await account("oa-key")).samples], [undefined, undefined])
  assert.deepEqual(host.active.openai, { type: "credential", id: "oa-siwc" })
  await stop()
  const off = await server({ options: {} })
  assert.deepEqual(batchRefs(await off.snapshot()), [], "with the option off there is nothing to refresh")
  await off.stop()
})

test("T29/E02: a mixed batch shares two slots across clients; neither reader's failure stops the other", async () => {
  const gate = held({ [`${MARK}-access-chatgpt-headless`]: () => reply(401, MARK) })
  const runs = []
  const claude = { source: "claude-usage", manual: true, bound: true, read({ connection }) {
    runs.push(connection.id)
    if (runs.length === 2) throw { reason: "exit" }
    return { window: "5h", scope: "general", observedAt: T0, used: 37 }
  } }
  const s = await server({ options: { experimentalCodexUsage: true, experimentalClaudeUsage: true }, claude,
    handler: gate.handler, credentials: second("browser-2") })
  s.host.integrations.push({ id: "claude-agent", connections: [{ type: "credential", id: "cl-1", label: "Claude", method: "external" }] })
  s.host.active["claude-agent"] = { type: "credential", id: "cl-1" }
  const active = structuredClone(s.host.active)
  assert.deepEqual(staleRefs(await s.snapshot(), T0), [], "opening schedules neither reader")
  const first = s.refreshAll()
  const other = s.refreshAll() // another client presses `a` at the same time
  await settle(20)
  assert.deepEqual([s.net.requests.length, gate.open(), runs], [2, 2, []], "Claude waits for the same slots as Codex")
  gate.release()
  const [a, b] = await Promise.all([first, other])
  assert.deepEqual(a.map((x) => x.status), ["read", "failed", "failed", "read", "read"], "browser, headless (401), SIWC, browser-2, Claude")
  assert.deepEqual(b.map((x) => x.status), a.map((x) => x.status), "the second client shares the same reads")
  assert.deepEqual(runs, ["cl-1"], "one Claude read for both clients despite the failed Codex reads")
  assert.deepEqual([s.net.requests.length, gate.max()], [3, 2], "one request per legacy login for both clients, never more than two at once")
  assert.equal((await s.account("oa-headless")).failure.reason, "auth")
  assert.equal((await s.account("oa-browser-2")).samples.length, 2, "one failure does not cancel the others")
  s.clock.t += 1_000
  const again = await s.refreshAll()
  assert.deepEqual(again.map((x) => x.status), ["read", "deferred", "deferred", "read", "failed"], "the Claude failure leaves Codex results intact")
  assert.deepEqual(runs, ["cl-1", "cl-1"])
  assert.deepEqual(s.host.active, active, "the batch never changes the active accounts")
  assert.equal(s.net.requests.length, 5)
  assert.equal(batchSummary(again.map((x) => x.status)), "Refresh all: 2 read · 1 failed · 2 deferred.")
  await s.stop()

  const limited = await server({ handler: () => reply(429, MARK, { "retry-after": "120" }) })
  assert.deepEqual((await limited.refreshAll()).map((x) => x.status), ["failed", "failed", "failed"])
  limited.clock.t += 60_000
  assert.deepEqual((await limited.refreshAll()).map((x) => x.status), ["deferred", "deferred", "failed"],
    "Retry-After 120 s still runs at 60 s; SIWC's own wait ended, it fails again without a request")
  assert.equal(limited.net.requests.length, 2)
  await limited.stop()
})

test("T29: removed or re-logged in while waiting: verified before access, dropped after; the others keep their reads", async () => {
  const gate = held()
  const s = await server({ handler: gate.handler, credentials: second("browser-2") })
  const expected = own(s.logins, "oa-browser", "oa-headless")
  const batch = s.refreshAll()
  await settle(20)
  assert.equal(s.net.requests.length, 2, "browser and headless in flight; SIWC and browser-2 wait for a slot")
  // browser-2 is removed while it waits; headless is re-logged into another ChatGPT account while its request is out.
  s.host.integrations[0].connections = s.host.integrations[0].connections.filter((row) => row.id !== "oa-browser-2")
  delete s.logins["oa-browser-2"]
  s.logins["oa-headless"].metadata.accountID = `${MARK}-another-account`
  gate.release()
  const statuses = (await batch).map((x) => x.status)
  assert.deepEqual(statuses, ["read", "failed", "failed", "failed"])
  assert.deepEqual(pairs(s.net.requests), expected, "nothing was sent for the removed login")
  assert.equal(s.host.record.resolved.includes("oa-browser-2"), false, "the removed login was not even resolved")
  assert.deepEqual([(await s.account("oa-headless")).failure.reason, (await s.account("oa-headless")).samples], ["changed", undefined])
  assert.deepEqual([(await s.account("oa-browser")).samples.length, await s.account("oa-browser-2")], [2, undefined])
  assert.equal(JSON.stringify(await s.snapshot()).includes(MARK), false)
  await s.stop()
})

test("T29: unloading with reads in flight and queued settles every promise; nothing is sent afterwards", async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
  const s = await server({ handler: hang, timeout: 60_000, credentials: second("browser-2") })
  const batch = s.refreshAll()
  await settle(20)
  assert.equal(s.net.requests.length, 2)
  await s.stop()
  const result = await Promise.race([batch, settle(500).then(() => "pending")])
  assert.notEqual(result, "pending", "no read is left waiting")
  assert.deepEqual(result.map((x) => x.status), ["failed", "failed", "failed", "failed"])
  await settle(20)
  assert.deepEqual([s.net.requests.length, s.host.record.resolved.includes("oa-browser-2")], [2, false], "the queued reads never started")
  const again = await s.plugin.setup(s.host.ctx)
  assert.equal((await s.snapshot()).integrations[0].connections.some((c) => c.samples || c.failure), false, "nothing survives the unload")
  await again()
})

test("T29: opening, reloading and loading never read Codex usage, even with the option on", async () => {
  const s = await server({ credentials: second("browser-2") })
  for (let i = 0; i < 3; i++) await s.snapshot()
  assert.deepEqual(staleRefs(await s.snapshot(), T0), [])
  await s.stop()
  const again = await s.plugin.setup(s.host.ctx)
  await s.snapshot()
  s.host.events.push({ type: "credential.switched", data: { integrationID: "openai", credentialID: "oa-headless" } })
  await settle(60)
  await s.snapshot()
  assert.deepEqual([s.net.requests.length, s.host.record.resolved], [0, []], "no request and no credential resolved without the user")
  await again()
})

test("T29: credentials stay in memory: nothing reaches the console, RPC answers, events or storage", async () => {
  const printed = []
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug }
  for (const name of Object.keys(saved)) console[name] = (...args) => printed.push(args.map(String).join(" "))
  try {
    const answers = []
    for (const handler of [undefined, () => reply(401, MARK), () => reply(200, `{"rate_limit":"${MARK}"}`)]) {
      const { refresh, snapshot, host, stop } = await server({ handler })
      answers.push(await refresh("oa-browser"), await refresh("oa-siwc"), await snapshot(), host.record.emitted, [...host.storage])
      await stop()
    }
    assert.equal(JSON.stringify({ answers, printed }).includes(MARK), false)
    assert.deepEqual(printed, [])
  } finally {
    Object.assign(console, saved)
  }
})
