// Rotation plan R2 (FIXTURE, A1–A4): the pure route engine with a controlled clock and snapshot DTOs. No host, reader,
// network or storage: the engine only says what it would do and why.
import assert from "node:assert/strict"
import { test } from "node:test"
import { decideRoute } from "../routing.js"

const T0 = Date.UTC(2026, 10, 25, 12)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const q = (window, used, extra = {}) => ({ source: "s", window, scope: "general", observedAt: T0, used, ...extra })
const conn = (id, method, samples = [], extra = {}) => ({ id, label: id, method, active: false, samples, ...extra })
const opus = { providerID: "claude-agent", modelID: "opus" }
const gpt = (connectionID) => ({ integrationID: "openai", providerID: "openai", modelID: "gpt", binding: connectionID ? "exact" : "current", ...(connectionID ? { connectionID } : {}) })
const claudeRow = { integrationID: "claude-agent", providerID: "claude-agent", modelID: "opus", binding: "current" }
const deepseekRow = { integrationID: "deepseek", providerID: "deepseek", modelID: "chat", binding: "current" }

function world({ opusUsed = 91, gpt1 = [q("5h", 20), q("weekly", 94, { resetsAt: T0 + DAY })], gpt2 = [q("5h", 42), q("weekly", 30)], ds = [] } = {}) {
  return [
    { id: "openai", active: "connection", refreshable: true, manual: true, connections: [{ ...conn("gpt-1", "oauth", gpt1), active: true }, conn("gpt-2", "oauth", gpt2)] },
    { id: "claude-agent", active: "connection", refreshable: true, manual: true, passive: true, connections: [{ ...conn("cl", "external", [q("5h", opusUsed), q("weekly", 50)]), active: true }] },
    { id: "deepseek", active: "connection", refreshable: true, connections: [{ ...conn("ds-1", "key", ds), active: true }] },
  ]
}
const base = (over = {}) => ({ selection: opus, targets: [gpt("gpt-1"), gpt("gpt-2"), claudeRow, deepseekRow], integrations: world(),
  threshold: 90, minimums: { USD: "0.20" }, now: T0 + MIN, readable: new Set(), visited: new Set(), budget: { origin: 1, candidates: 2 }, paid: false, ...over })

test("A1: the user's selection is kept below the threshold, even when it is not first; at 90.00% the walk starts at row 1", () => {
  const below = decideRoute(base({ integrations: world({ opusUsed: 89.99 }) }))
  assert.equal(below.kind, "keep")
  assert.equal(below.read, undefined, "no candidate is read before a trigger")
  const at = decideRoute(base({ integrations: world({ opusUsed: 90 }) }))
  assert.equal(at.trigger, "5 h: 90% used")
  assert.deepEqual(at.rows.map((r) => r.status), ["skipped", "eligible", "not-checked", "not-checked"])
  // A row with the current selection and account is the origin, never a destination.
  const self = decideRoute(base({ targets: [claudeRow, gpt("gpt-2")] }))
  assert.deepEqual(self.rows[0], { status: "origin", reason: "In use now" })
  assert.equal(self.target, 1)
})

test("A2: ideal ≠ executable; a high weekly window skips despite a low 5 h; reset → unknown, not 0; only a new reading recovers", () => {
  const d = decideRoute(base())
  assert.equal(d.rows[0].reason, "Weekly: 94% used")
  assert.deepEqual([d.kind, d.target, d.manual, d.reason], ["suggest", 1, true, "Account switch is global"], "ChatGPT 2 is ideal, but manual")
  const current = decideRoute(base({ targets: [gpt()] }))
  assert.deepEqual([current.kind, current.reason], ["noTarget", "Weekly: 94% used"], "the active OpenAI account is the high one")
  const other = world()
  other[0].connections = [conn("gpt-1", "oauth", [q("5h", 20), q("weekly", 94, { resetsAt: T0 + DAY })]), { ...conn("gpt-2", "oauth", [q("5h", 42), q("weekly", 30)]), active: true }]
  const model = decideRoute(base({ targets: [gpt()], integrations: other }))
  assert.deepEqual([model.kind, model.reason], ["suggest", "Model switch not enabled"], "a model row is only suggested: no model switch")
  // Past the freshness (150 s by default), before the weekly reset: a confirmed mark still skips, without reading.
  const laterWorld = world({ gpt2: [q("5h", 42, { observedAt: T0 + 9 * MIN }), q("weekly", 30, { observedAt: T0 + 9 * MIN })] })
  laterWorld[1].connections[0].samples = [q("5h", 91, { observedAt: T0 + 9 * MIN }), q("weekly", 50, { observedAt: T0 + 9 * MIN })]
  const later = decideRoute(base({ now: T0 + 10 * MIN, integrations: laterWorld }))
  assert.equal(later.rows[0].reason, "Waiting for reset (Weekly)")
  assert.equal(later.target, 1)
  // At the reset the old value is no figure at all: unknown, and a manual reader means "Refresh required".
  const reset = decideRoute(base({ now: T0 + DAY + MIN, integrations: world({ opusUsed: 91, gpt2: [] }) }))
  assert.equal(reset.kind, "keep", "the origin's own data expired too: unverified, not 0%")
  const fresh = (used) => world({ gpt1: [q("5h", 10, { observedAt: T0 + DAY }), q("weekly", used, { observedAt: T0 + DAY })] })
  const sample = (w) => w.map((i) => i.id === "claude-agent" ? { ...i, connections: [{ ...i.connections[0], samples: [q("5h", 95, { observedAt: T0 + DAY }), q("weekly", 50, { observedAt: T0 + DAY })] }] } : i)
  const recovered = decideRoute(base({ now: T0 + DAY + MIN, integrations: sample(fresh(5)) }))
  assert.deepEqual([recovered.rows[0].status, recovered.target], ["eligible", 0], "a fresh reading after the reset makes it first again")
  const missing = decideRoute(base({ now: T0 + DAY + MIN, integrations: sample(world({ gpt1: [], gpt2: [] })) }))
  assert.deepEqual(missing.rows.slice(0, 2).map((r) => r.reason), ["Refresh required", "Refresh required"], "manual readers are never read here")
})

test("A3: partial reports, scoped windows, failures and model-specific quotas", () => {
  const partial = decideRoute(base({ integrations: world({ gpt2: [q("5h", 10)] }) }))
  assert.equal(partial.rows[1].reason, "Refresh required", "only 5 h does not prove there is no weekly window")
  const scoped = decideRoute(base({ integrations: world({ gpt2: [q("5h", 10), q("weekly", 10), q("weekly", 99, { scope: "openai/other" })] }) }))
  assert.equal(scoped.rows[1].status, "eligible", "a window scoped to another model is not applied by name")
  const own = decideRoute(base({ integrations: world({ gpt2: [q("5h", 10), q("weekly", 10), q("weekly", 99, { scope: "openai/gpt" })] }) }))
  assert.equal(own.rows[1].reason, "Weekly (gpt): 99% used", "a window scoped to this exact model applies")
  const failedLater = world()
  failedLater[0].connections[1].failure = { source: "s", at: T0 + 30_000, reason: "timeout" }
  assert.equal(decideRoute(base({ integrations: failedLater })).rows[1].reason, "Refresh required", "a newer failure leaves no fresh value")
  const auth = world()
  auth[0].connections[1] = { ...auth[0].connections[1], samples: [], failure: { source: "s", at: T0, reason: "auth" } }
  assert.equal(decideRoute(base({ integrations: auth })).rows[1].reason, "Reconnect required", "401 is not retried by a decision")
  const reconnect = world()
  reconnect[0].connections[1].reconnectRequired = true
  assert.equal(decideRoute(base({ integrations: reconnect })).rows[1].reason, "Reconnect required")
  const removed = decideRoute(base({ targets: [gpt("gone")] }))
  assert.equal(removed.rows[0].reason, "Account removed", "never replaced by an account with the same name")
  const unattributed = world()
  delete unattributed[1].passive
  assert.equal(decideRoute(base({ selection: { providerID: "openai", modelID: "gpt" }, integrations: unattributed, targets: [claudeRow] })).rows[0].reason,
    "Usage unknown", "Claude data counts only while the single profile is attributable")
  assert.equal(decideRoute(base({ selection: undefined })).reason, "Selection unknown")
})

test("A4: money is compared exactly in its own currency; paid keys need the session's consent; no reader → manual", () => {
  const ds = (balances, available = true) => world({ gpt1: [q("weekly", 99)], gpt2: [q("weekly", 99)], ds: [{ source: "b", window: "balance", scope: "general", observedAt: T0, available, balances }] })
  const run = (w, over = {}) => decideRoute(base({ integrations: w, paid: true, ...over })).rows[3]
  assert.deepEqual(run(ds([{ currency: "USD", total: "0.21" }])), { status: "eligible", reason: "" })
  assert.equal(run(ds([{ currency: "USD", total: "0.20" }])).reason, "Balance: USD 0.20", "at the minimum is not above it")
  assert.equal(run(ds([{ currency: "CNY", total: "99.00" }])).reason, "No USD balance", "CNY never stands in for USD")
  assert.equal(run(ds([{ currency: "USD", total: "5.00" }], false)).reason, "Balance not available")
  assert.equal(run(ds([{ currency: "USD", total: "5.00" }]), { minimums: {} }).reason, "No balance criterion")
  assert.equal(decideRoute(base({ integrations: ds([{ currency: "USD", total: "5.00" }]) })).rows[3].reason, "Metered API not enabled")
  const anthropic = [...world(), { id: "anthropic", active: "connection", refreshable: false, connections: [{ ...conn("an-1", "key"), active: true }] }]
  const row = { integrationID: "anthropic", providerID: "anthropic", modelID: "m", binding: "current" }
  assert.equal(decideRoute(base({ integrations: anthropic, targets: [row], paid: true })).rows[0].reason, "No budget reader")
})

test("R3: an unpinned ChatGPT reserve follows the conversation, including its quota scope and effort", () => {
  const { modelID, ...reserve } = gpt("gpt-2")
  const selection = { providerID: "openai", modelID: "new-gpt", variant: "high" }
  const route = (over = {}) => decideRoute(base({ selection, targets: [reserve], ...over }))
  assert.deepEqual(route().model, selection)
  assert.deepEqual(route({ targets: [{ ...reserve, modelID: "new-gpt" }] }).model, selection, "omitting effort on the same explicit model also keeps it")
  assert.deepEqual(route({ targets: [{ ...reserve, modelID: "other" }] }).model, { providerID: "openai", modelID: "other" }, "a different model starts at its default")
  const origin = route({ targets: [{ ...reserve, connectionID: "gpt-1" }, reserve] })
  assert.deepEqual([origin.rows[0].status, origin.target], ["origin", 1])
  const scoped = world({ gpt2: [q("5h", 10), q("weekly", 15), q("weekly", 99, { scope: "openai/new-gpt#high" })] })
  assert.equal(route({ integrations: scoped }).kind, "noTarget", "the inherited variant's high window is not skipped")
  assert.equal(route({ selection: { ...selection, variant: "low" }, integrations: scoped }).kind, "suggest")
  const unrelated = world({ gpt1: [q("weekly", 99, { scope: "openai/other" })] })
  assert.equal(route({ integrations: unrelated }).origin.state, "unknown", "no applicable fresh origin window")
  assert.equal(route({ selection: opus }).rows[0].reason, "Choose a model for this provider", "no GPT is invented from Opus")
  const claude = route({ targets: [claudeRow], integrations: world({ opusUsed: 42 }) })
  assert.deepEqual(claude.model, opus, "a Claude model set on another provider never inherits GPT effort")
})

test("R3: a fixed effort on a floating model needs proof from this session or the location catalog", () => {
  const { modelID, ...reserve } = gpt("gpt-2")
  const selection = { providerID: "openai", modelID, variant: "low" }
  const model = { providerID: "openai", id: modelID, enabled: true, variants: [{ id: "high" }] }
  const route = (catalog, sel = selection) => decideRoute(base({ selection: sel, catalog, targets: [{ ...reserve, variant: "high" }] }))
  assert.deepEqual(route([model]).model, { ...selection, variant: "high" })
  assert.deepEqual(route(undefined, { ...selection, variant: "high" }).model, { ...selection, variant: "high" }, "already in use is proof")
  for (const catalog of [undefined, [], [{ ...model, enabled: false }], [{ ...model, providerID: "claude-agent" }], [{ ...model, id: "different" }]]) {
    assert.equal(route(catalog).rows[0].reason, "Choose an effort for this model")
  }
})

test("A6 (engine): reads are asked one at a time — the origin only when unverified, then candidates within the budget", () => {
  const unknownOrigin = world()
  unknownOrigin[2].connections[0].samples = []
  const sel = { providerID: "deepseek", modelID: "chat" }
  const origin = decideRoute(base({ selection: sel, integrations: unknownOrigin, readable: new Set(["deepseek"]) }))
  assert.deepEqual([origin.kind, origin.read], ["needRead", { integrationID: "deepseek", connectionID: "ds-1", purpose: "origin" }])
  assert.deepEqual([decideRoute(base({ selection: sel, integrations: unknownOrigin })).kind, decideRoute(base({ selection: sel, integrations: unknownOrigin })).reason],
    ["keep", "Refresh required"], "without a policy reader: say what to refresh and stop; no candidate is read")
  const visited = decideRoute(base({ selection: sel, integrations: unknownOrigin, readable: new Set(["deepseek"]), visited: new Set([JSON.stringify(["deepseek", "ds-1"])]) }))
  assert.deepEqual([visited.kind, visited.reason], ["keep", "Usage unknown"], "a reference is read at most once per decision")
  const keys = [1, 2, 3].map((n) => ({ ...conn(`k${n}`, "key") }))
  const many = world({ gpt1: [q("weekly", 99)], gpt2: [q("weekly", 99)] })
  many[2].connections.push(...keys)
  const rows = keys.map((k) => ({ ...deepseekRow, binding: "exact", connectionID: k.id }))
  const first = decideRoute(base({ integrations: many, targets: rows, paid: true, readable: new Set(["deepseek"]) }))
  assert.deepEqual([first.kind, first.read.connectionID, first.rows.map((r) => r.status)], ["needRead", "k1", ["pending", "not-checked", "not-checked"]])
  const spent = decideRoute(base({ integrations: many, targets: rows, paid: true, readable: new Set(["deepseek"]), budget: { origin: 1, candidates: 0 } }))
  assert.deepEqual([spent.kind, spent.reason], ["noTarget", "Not verified (read budget used)"], "out of budget: say what is left unverified")
})
