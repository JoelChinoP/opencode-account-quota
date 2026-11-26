// B03 rules with synthetic samples and a controlled clock (FIXTURE: T05, T06, T07, T08). No host, no network.
import assert from "node:assert/strict"
import { test } from "node:test"
import { TTL, createAdvisor, createCache, freshness, percent, recommend, sampleState, selectionKey, usageFreshness, validSample, validThreshold } from "../rules.js"

const T0 = Date.UTC(2026, 10, 24, 12, 0, 0)
const MIN = 60_000
const FRESH = 150_000 // the default usage freshness of ChatGPT and Claude Code
const SEL = { providerID: "openai", modelID: "gpt-6.2-sol", variant: "high" }
const MODEL = selectionKey(SEL)

// Accounts with every identity field an older DTO could carry (holder, billing, models): none makes another account a destination.
const account = (id, extra = {}) => ({ id, label: id, method: "oauth", active: false, holder: `holder-${id}`, billing: "personal", models: [MODEL], ...extra })
const quota = (connectionID, window, used, extra = {}) =>
  ({ integrationID: "openai", connectionID, source: "fixture", window, scope: "general", observedAt: T0, used, ...extra })

function decide({ order = ["A", "B", "C"], active = "B", accounts = {}, samples = [], failures = [], now = T0 + MIN, threshold = 95, refreshable = false, selection = SEL, ttl }) {
  const integration = { id: "openai", activeID: active, connections: order.map((id) => account(id, { active: id === active, ...accounts[id] })) }
  return recommend({ integration, selection, threshold, samples, failures, now, refreshable, ttl })
}

test("percent: two decimals, truncated after removing binary noise; never rounded up", () => {
  assert.deepEqual([8.2, 16.9, 4.35, 94.996, 99.999, 100, 0, 94.99].map(percent), ["8.2%", "16.9%", "4.35%", "94.99%", "99.99%", "100%", "0%", "94.99%"])
})

test("T05: threshold is an integer from 90 to 100 and compares the real value with >=", () => {
  assert.deepEqual([89, 90, 95, 100, 101, 95.5, "95", NaN, null].map(validThreshold), [false, true, true, true, false, false, false, false, false])
  const fresh = (used) => [quota("B", "5h", used), quota("A", "5h", 10), quota("A", "weekly", 10), quota("B", "weekly", 10)]
  assert.equal(decide({ samples: fresh(94.99) }).kind, "idle", "94.99 is below 95; no display rounding")
  assert.equal(decide({ samples: fresh(95) }).kind, "none")
  assert.equal(decide({ samples: fresh(100) }).kind, "none")
  for (const bad of [89, 101, 95.5]) assert.equal(decide({ samples: fresh(100), threshold: bad }).kind, "idle")
  const at90 = decide({ samples: fresh(94.99), threshold: 90 })
  assert.equal(at90.kind, "none")
  assert.equal(at90.trigger.text, "5 h: 94.99% used")
})

test("T05: one source window at the threshold triggers", () => {
  const weekly = [quota("B", "5h", 40), quota("B", "weekly", 95)]
  const result = decide({ samples: [...weekly, quota("A", "5h", 20), quota("A", "weekly", 30)] })
  assert.deepEqual([result.kind, result.trigger.text], ["none", "Weekly: 95% used"])
})

test("T06: no other account is a confirmed destination; none names why the next one after the active (wrapping) is not", () => {
  const samples = [quota("B", "5h", 97), quota("A", "5h", 10), quota("C", "5h", 10)]
  const reason = (extra) => decide({ samples, ...extra }).reason
  assert.equal(reason({ accounts: { C: { reconnectRequired: true } } }), "Reconnect required")
  assert.equal(reason({ accounts: { C: { method: "external" } } }), "Profile not verified")
  assert.equal(reason({}), "Independent quota not proven", "even with holder, billing and models: the snapshot never proves them")
  assert.equal(reason({ active: "C", samples: [quota("C", "5h", 97)], accounts: { A: { reconnectRequired: true } } }), "Reconnect required", "after the last comes the first")
  assert.equal(reason({ order: ["B"] }), "No other account in this integration")
  const outside = decide({ samples: [quota("X", "5h", 99), quota("A", "5h", 1)], active: "X" })
  assert.deepEqual([outside.kind, outside.reason], ["none", "Active account is not in the priority order"])
  assert.equal("skipped" in decide({ samples }), false)
})

test("T06: never crosses provider, model or variant", () => {
  const model = (id, used) => quota(id, "weekly", used, { scope: MODEL })
  const samples = [quota("B", "5h", 10), model("B", 96), quota("A", "5h", 10)]
  assert.equal(decide({ samples }).trigger.text, "Weekly (gpt-6.2-sol#high): 96% used", "the exact selection's window")
  const otherVariant = { ...SEL, variant: "low" }
  assert.equal(decide({ samples, selection: otherVariant }).kind, "idle", "the high-variant sample does not apply to low")
  assert.equal(decide({ samples, selection: { ...SEL, providerID: "anthropic" } }).kind, "idle")
})

test("T07: freshness of 150 s for ChatGPT and Claude Code (or the option), 2 min DeepSeek, 5 min Anthropic; resetsAt first, late samples and new failures", () => {
  const chat = quota("A", "5h", 50)
  const claude = { ...chat, integrationID: "claude-agent" }
  for (const s of [chat, claude]) {
    assert.equal(sampleState(s, undefined, T0 + FRESH - 1), "Fresh", s.integrationID)
    assert.equal(sampleState(s, undefined, T0 + FRESH), "Stale", `${s.integrationID}: the same 150 s by default`)
  }
  const deepseek = { ...chat, integrationID: "deepseek" }
  const api = { ...chat, integrationID: "anthropic" }
  assert.equal(sampleState(deepseek, undefined, T0 + 2 * MIN - 1), "Fresh")
  assert.equal(sampleState(deepseek, undefined, T0 + 2 * MIN), "Stale")
  assert.equal(sampleState(api, undefined, T0 + 5 * MIN - 1), "Fresh")
  assert.equal(sampleState(api, undefined, T0 + 5 * MIN), "Stale")
  // The plugin option `usageFreshnessSeconds`: a positive safe integer up to an hour; missing or anything else is 150.
  assert.deepEqual([1, 30, 150, 3600].map(usageFreshness), [1, 30, 150, 3600])
  for (const bad of [undefined, null, 0, -30, 1.5, 3601, 2 ** 53, NaN, Infinity, "30", true, [30], { seconds: 30 }]) {
    assert.equal(usageFreshness(bad), 150, String(bad))
  }
  const short = freshness(30)
  assert.deepEqual(short, { openai: 30_000, "claude-agent": 30_000, deepseek: 120_000, anthropic: 300_000 })
  assert.deepEqual(freshness("30"), TTL, "an invalid option is the default table")
  assert.ok(Object.isFrozen(short) && Object.isFrozen(TTL), "no caller can change a shared table")
  assert.equal(sampleState(chat, undefined, T0 + 30_000 - 1, short), "Fresh")
  assert.equal(sampleState(claude, undefined, T0 + 30_000, short), "Stale")
  assert.equal(sampleState(chat, undefined, T0 + 59 * MIN, freshness(3600)), "Fresh")
  assert.equal(sampleState(deepseek, undefined, T0 + 2 * MIN, freshness(3600)), "Stale", "the option never touches DeepSeek")
  assert.equal(sampleState(api, undefined, T0 + 5 * MIN, freshness(1)), "Stale")
  assert.equal(sampleState(api, undefined, T0 + 5 * MIN - 1, freshness(1)), "Fresh", "nor the Anthropic API")
  const resets = { ...chat, resetsAt: T0 + 30_000 }
  assert.equal(sampleState(resets, undefined, T0 + 29_999), "Fresh")
  assert.equal(sampleState(resets, undefined, T0 + 30_000), "Stale", "resetsAt before the TTL wins")
  assert.equal(sampleState(resets, undefined, T0 + 30_000, freshness(3600)), "Stale", "also before a long option")
  assert.equal(resets.used, 50, "no invented 0% at reset")

  const cache = createCache()
  assert.equal(cache.record(chat), true)
  assert.equal(cache.record({ ...chat, used: 99, observedAt: T0 - 1 }), false, "late sample dropped")
  assert.equal(cache.record({ ...chat, used: 0, observedAt: T0 + 1 }), true, "a real 0 is a value")
  assert.equal(cache.list().samples[0].used, 0)
  assert.equal(cache.fail(chat, T0 + 2, "rate-limit"), true)
  const { samples, failures } = cache.list()
  assert.equal(sampleState(samples[0], failures[0], T0 + 3), "Refresh failed", "visible but no longer decisive")
  assert.equal(cache.record({ ...chat, used: 5, observedAt: T0 + 1 }), false, "older than the failure")
  assert.equal(cache.record({ ...chat, used: 5, observedAt: T0 + 3 }), true)
  assert.equal(sampleState(cache.list().samples[0], cache.list().failures[0], T0 + 4), "Fresh")
  assert.equal(sampleState(undefined, undefined, T0), "No data")

  for (const bad of [null, Infinity, -1, 101, NaN, "50"]) assert.equal(validSample({ ...chat, used: bad }), false, String(bad))
  assert.equal(validSample({ ...chat, used: undefined }), false, "null/absent is No data, not zero")
  assert.equal(validSample({ ...chat, resetsAt: 8.64e15 + 1 }), false, "invalid date")
  assert.equal(validSample({ ...chat, observedAt: NaN }), false)
  assert.equal(cache.record({ ...chat, window: "weekly", used: Infinity }), false)

  const stale = [quota("B", "5h", 99, { observedAt: T0 - FRESH })]
  assert.equal(decide({ samples: stale, now: T0 }).kind, "idle", "a stale value does not trigger")
  assert.equal(decide({ samples: stale, now: T0, ttl: freshness(300) }).trigger.text, "5 h: 99% used", "with a longer option it is still fresh")
  assert.equal(decide({ samples: [quota("B", "5h", 99, { observedAt: T0 - 30_000 })], now: T0, ttl: short }).kind, "idle", "and stale sooner with a shorter one")
  const failedSource = decide({ samples: [quota("B", "5h", 99), quota("A", "5h", 1)], failures: [{ integrationID: "openai", connectionID: "B", source: "fixture", at: T0 + 1, reason: "rate-limit" }] })
  assert.equal(failedSource.kind, "idle", "a generic 429 is a failed read, not an exhausted quota")
})

test("T07: a newer sample clears the failure of its own source only", () => {
  const cache = createCache()
  const chat = quota("A", "5h", 50)
  const other = { integrationID: "openai", connectionID: "A", source: "other" }
  assert.equal(cache.fail(chat, T0 + 1, "auth"), true)
  assert.equal(cache.fail(other, T0 + 1, "rate-limit"), true)
  assert.equal(cache.record({ ...chat, observedAt: T0 + 2 }), true)
  assert.deepEqual(cache.list().failures, [{ ...other, at: T0 + 1, reason: "rate-limit" }], "an old auth failure is not kept forever")
})

// What the TUI hands to the advisor: the held data at one instant (`active` is the native active account). These
// timelines were written for a 2 min freshness: they run with the option set to 120 s (`usageFreshnessSeconds: 120`).
const OPTION_120 = freshness(120)
const view = (held, now = T0 + MIN, active = "B", count = () => {}) => ({
  account: () => active,
  evaluate: (selection) => {
    count()
    return decide({ samples: held.samples, failures: held.failures ?? [], threshold: held.threshold ?? 95, selection, active, now, ttl: OPTION_120 })
  },
})
const ev = (id, type = "session.execution.succeeded", sessionID = "ses-1") => ({ id, type, data: { sessionID } })

test("T08: only a final turn result of the session evaluates, once; a notice ends with its context; dismissed is not repeated", () => {
  const advisor = createAdvisor()
  let evaluations = 0
  const held = { samples: [quota("B", "5h", 96), quota("A", "5h", 10)] }
  const context = (selection = SEL, active = "B") => ({ sessionID: "ses-1", selection, ...view(held, T0 + MIN, active, () => { evaluations += 1 }) })
  const ignored = ["session.step.ended", "session.step.failed", "session.tool.success", "session.tool.failed",
    "session.compaction.ended", "session.retry.scheduled", "session.execution.started", "session.execution.interrupted"]
  for (const [i, type] of ignored.entries()) assert.equal(advisor.turnEnded(ev(`e${i}`, type), context()), false, type)
  assert.equal(advisor.turnEnded(ev("other", "session.execution.succeeded", "ses-2"), context()), false, "another session")
  assert.equal(evaluations, 0)

  assert.equal(advisor.turnEnded(ev("t1"), context()), true)
  assert.equal(advisor.turnEnded(ev("t1"), context()), false, "duplicate delivery")
  assert.equal(advisor.turnEnded(ev("t2"), context()), false, "same notice, not a second one")
  assert.equal(evaluations, 2, "one evaluation per final turn event")
  const notice = advisor.current(context())
  assert.deepEqual([notice.result.kind, notice.result.reason, Object.keys(notice).sort()],
    ["none", "Independent quota not proven", ["account", "afterFailure", "key", "motive", "result", "selection", "sessionID"]])
  assert.equal(JSON.stringify(notice).includes("activate"), false, "advice only; nothing to execute")
  assert.equal(advisor.current(context(SEL, "C")), undefined, "another active account ends it")
  assert.equal(advisor.current(context()), undefined, "and it does not come back")

  assert.equal(advisor.turnEnded(ev("t3", "session.execution.failed"), context()), true, "a final failure explains")
  assert.equal(advisor.current(context()).afterFailure, true)
  assert.equal(advisor.current({ ...context(), sessionID: "ses-2" }), undefined, "another session ends it")
  assert.equal(advisor.current(context()), undefined)
  assert.equal(advisor.turnEnded(ev("t3b"), context()), true)
  advisor.dismiss()
  assert.equal(advisor.turnEnded(ev("t4"), context()), false, "dismissed: same motive")
  const base = { ...SEL, variant: undefined }
  assert.equal(advisor.turnEnded(ev("t5"), context(base)), true, "another variant is another selection: its own motive")
  assert.equal(advisor.current(context(SEL)), undefined, "the selection on screen is not the one it was raised for")
  assert.equal(advisor.turnEnded(ev("t5b"), context(base)), true)
  assert.equal(advisor.turnEnded(ev("t6"), context()), true, "selection changed and back")
  advisor.dismiss()
  held.samples = [quota("B", "5h", 50), quota("A", "5h", 10)]
  assert.equal(advisor.turnEnded(ev("t7"), context()), false, "margin recovered")
  held.samples = [quota("B", "5h", 97), quota("A", "5h", 10)]
  assert.equal(advisor.turnEnded(ev("t8"), context()), true, "crossing again notifies")
  held.samples = [quota("B", "5h", 97), quota("B", "weekly", 99), quota("A", "5h", 10)]
  advisor.dismiss()
  assert.equal(advisor.turnEnded(ev("t9"), context()), true, "motive changed: another window crossed")
  assert.equal(advisor.current(context()).result.kind, "none")
})

test("T08: the advisor is watching while a notice is up or its episode waits for a confirmed recovery", () => {
  const advisor = createAdvisor()
  const read = (observedAt, used) => ({ samples: [quota("B", "5h", used, { observedAt }), quota("A", "5h", 10, { observedAt })] })
  assert.equal(advisor.watching(), false)
  assert.equal(advisor.turnEnded(ev("w1"), { sessionID: "ses-1", selection: SEL, ...view(read(T0, 96), T0 + MIN) }), true)
  assert.equal(advisor.watching(), true)
  advisor.dismiss()
  assert.deepEqual([advisor.pending(), advisor.watching()], [false, true], "dismissed: the episode stays open")
  advisor.observe(view(read(T0, 96), T0 + 3 * MIN))
  assert.equal(advisor.watching(), true, "only stale: not a recovery")
  advisor.observe(view(read(T0 + 4 * MIN, 40), T0 + 4 * MIN))
  assert.equal(advisor.watching(), false, "a fresh sample below the threshold confirms the recovery")
})

test("T08: a visible notice follows the held data and the clock; withdrawing never raises one", () => {
  const advisor = createAdvisor()
  let n = 0
  const at = (held, now, extra = {}) => ({ sessionID: "ses-1", selection: SEL, ...view(held, now, extra.active ?? "B"), ...extra })
  const turn = (held, now, type) => advisor.turnEnded(ev(`turn-${++n}`, type), at(held, now))
  const shown = (held, now, extra) => advisor.current(at(held, now, extra))?.result.trigger.text
  const read = (observedAt, used = 96) => ({ samples: [quota("B", "5h", used, { observedAt }), quota("A", "5h", 10, { observedAt })] })

  // TTL: shown until the source sample expires, withdrawn at that instant by the clock alone.
  const first = read(T0)
  assert.equal(turn(first, T0 + MIN), true)
  assert.equal(shown(first, T0 + 2 * MIN - 1), "5 h: 96% used")
  advisor.observe(view(first, T0 + 2 * MIN))
  assert.equal(shown(first, T0 + 2 * MIN), undefined, "stale at the TTL, no turn needed")
  const again = read(T0 + 3 * MIN)
  advisor.observe(view(again, T0 + 3 * MIN))
  assert.equal(shown(again, T0 + 3 * MIN), undefined, "a refresh that is still high does not bring it back")
  assert.equal(turn(again, T0 + 3 * MIN), true, "only a turn end raises it again: not dismissed, still crossed")

  // A re-read before the expiry keeps it with the current value; after a gap without any render, the data held
  // until then is checked first, so the notice cannot survive a stale interval.
  const higher = read(T0 + 3 * MIN + 30_000, 98)
  advisor.observe(view(again, T0 + 3 * MIN + 30_000))
  advisor.observe(view(higher, T0 + 3 * MIN + 30_000))
  assert.equal(shown(higher, T0 + 4 * MIN), "5 h: 98% used", "same advice, current numbers")
  assert.equal(shown(read(T0 + 3 * MIN + 30_000, 98), T0 + 4 * MIN), "5 h: 98% used", "same data read again: the invalidation counter is no reason")
  const later = read(T0 + 8 * MIN)
  advisor.observe(view(higher, T0 + 8 * MIN))
  advisor.observe(view(later, T0 + 8 * MIN))
  assert.equal(shown(later, T0 + 8 * MIN), undefined, "it went stale in between")

  // A newer failure withdraws it, and neither failure nor staleness is a recovery: a dismissed motive stays quiet.
  assert.equal(turn(later, T0 + 8 * MIN), true)
  const failed = { ...later, failures: [{ integrationID: "openai", connectionID: "B", source: "fixture", at: T0 + 8 * MIN + 1, reason: "rate-limit" }] }
  advisor.observe(view(failed, T0 + 8 * MIN + 2))
  assert.equal(shown(failed, T0 + 8 * MIN + 2), undefined, "Refresh failed is not decisive")
  const fresh = read(T0 + 9 * MIN)
  assert.equal(turn(fresh, T0 + 9 * MIN), true)
  advisor.dismiss()
  assert.equal(shown(fresh, T0 + 9 * MIN), undefined)
  assert.equal(turn(fresh, T0 + 11 * MIN), false, "stale at this turn end: not a recovery")
  const broken = { ...read(T0 + 11 * MIN + 1), failures: [{ integrationID: "openai", connectionID: "B", source: "fixture", at: T0 + 11 * MIN + 2, reason: "network" }] }
  assert.equal(turn(broken, T0 + 11 * MIN + 3), false, "failed at this turn end: not a recovery")
  const still = read(T0 + 12 * MIN)
  assert.equal(turn(still, T0 + 12 * MIN), false, "same episode: the dismissed notice is not repeated")

  // A fresh sample below the threshold ends the episode even outside a turn; crossing again needs a turn end.
  const recovered = read(T0 + 13 * MIN, 40)
  advisor.observe(view(recovered, T0 + 13 * MIN))
  const crossed = read(T0 + 14 * MIN, 97)
  advisor.observe(view(crossed, T0 + 14 * MIN))
  assert.equal(shown(crossed, T0 + 14 * MIN), undefined, "observing never raises")
  assert.equal(turn(crossed, T0 + 14 * MIN), true, "new episode after a confirmed recovery")
  advisor.observe(view(read(T0 + 14 * MIN + 1, 40), T0 + 14 * MIN + 1))
  assert.equal(shown(read(T0 + 14 * MIN + 1, 40), T0 + 14 * MIN + 1), undefined, "recovery withdraws it at once")

  // A reset before the TTL withdraws it at the reset, and the value is not turned into 0%.
  const resetting = { samples: [quota("B", "5h", 97, { observedAt: T0 + 14 * MIN, resetsAt: T0 + 14 * MIN + 30_000 }), quota("A", "5h", 10, { observedAt: T0 + 14 * MIN })] }
  assert.equal(turn(resetting, T0 + 14 * MIN + 1), true)
  assert.equal(shown(resetting, T0 + 14 * MIN + 29_999), "5 h: 97% used")
  advisor.observe(view(resetting, T0 + 14 * MIN + 30_000))
  assert.equal(shown(resetting, T0 + 14 * MIN + 30_000), undefined, "withdrawn at resetsAt")
  assert.equal(turn(resetting, T0 + 14 * MIN + 30_001), false, "a reset is not a measured recovery, and nothing fresh to notify")

  // The host may change its selection object in place: the notice keeps the selection it was raised for.
  const live = { ...SEL }
  assert.equal(advisor.turnEnded(ev("live"), { ...at(crossed, T0 + 14 * MIN + 2), selection: live }), true)
  live.modelID = "another-model"
  advisor.observe(view(crossed, T0 + 14 * MIN + 2))
  assert.equal(shown(crossed, T0 + 14 * MIN + 2), "5 h: 97% used")
  assert.equal(shown(crossed, T0 + 14 * MIN + 2, { selection: live }), undefined, "the other model is another context")

  // The account or the selection disappears.
  assert.equal(turn(crossed, T0 + 14 * MIN + 2), true)
  advisor.observe(view(crossed, T0 + 14 * MIN + 3, null))
  assert.equal(shown(crossed, T0 + 14 * MIN + 3), undefined, "active account gone from the snapshot")
  assert.equal(turn(crossed, T0 + 14 * MIN + 4), true)
  assert.equal(shown(crossed, T0 + 14 * MIN + 5, { selection: undefined }), undefined, "no selection")
  assert.equal(shown(crossed, T0 + 14 * MIN + 5), undefined)
  assert.equal(advisor.pending(), false)
})
