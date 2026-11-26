// Rotation plan R3 (FIXTURE): the route order editor and the next-turn preview in /quota, as plain text at
// 40/80/120 columns, native picker choices, cancellation and the saved proposal. The preview evaluates held data only.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createAdvisor } from "../rules.js"
import {
  accountChoices, activeAccount, alertRows, compactLine, decide, legend, modalLayout, nextExpiry, pickDestination, proposalFrom, putRoute,
  routeMove, routePreview, routeProposal, routeRemove, routeStep, screenText, startRoute,
} from "../view.js"

const T0 = Date.UTC(2026, 10, 25, 12)
const q = (window, used, extra = {}) => ({ source: "s", window, scope: "general", observedAt: T0, used, ...extra })
const targets = [
  { integrationID: "openai", providerID: "openai", modelID: "gpt-5", binding: "exact", connectionID: "oa-1" },
  { integrationID: "openai", providerID: "openai", modelID: "gpt-5", binding: "exact", connectionID: "oa-2" },
  { integrationID: "claude-agent", providerID: "claude-agent", modelID: "opus", binding: "current" },
  { integrationID: "deepseek", providerID: "deepseek", modelID: "deepseek-chat", binding: "current" },
]
// The plan's example: Opus at 91 %, ChatGPT personal weekly at 94 %, ChatGPT work at 42 % or less, DeepSeek API.
const snapshot = (session = { mode: "off", paid: false }) => ({
  schema: 2, revision: 1, scope: "personal-server", inventory: "available",
  preferences: { state: "available", revision: 2, mode: "recommend", threshold: 90, minimums: { USD: "0.20" } },
  integrations: [
    { id: "openai", active: "connection", refreshable: true, manual: true, connections: [
      { id: "oa-1", label: "ChatGPT personal", method: "oauth", active: true, samples: [q("5h", 20), q("weekly", 94, { resetsAt: T0 + 86_400_000 })] },
      { id: "oa-2", label: "ChatGPT work", method: "oauth", active: false, samples: [q("5h", 42), q("weekly", 30)] }] },
    { id: "claude-agent", active: "connection", refreshable: true, manual: true, passive: true, connections: [
      { id: "cl", label: "TURING", method: "external", active: true, samples: [q("5h", 91), q("weekly", 50)] }] },
    { id: "deepseek", active: "connection", refreshable: true, connections: [{ id: "ds", label: "Main", method: "key", active: true }] },
  ],
  routing: { state: "available", revision: 4, targets, session },
})
const opus = { providerID: "claude-agent", modelID: "opus" }

test("R3: the order shows compact account rows and one next turn; skipped details follow the selected row", () => {
  const route = startRoute(snapshot())
  assert.deepEqual(route, { revision: 4, targets, index: 0 })
  for (const [columns, rows] of [[40, 24], [80, 24], [120, 40]]) {
    const layout = modalLayout(snapshot(), { now: T0 + 60_000, route, selection: opus, columns, rows })
    const text = screenText(layout)
    const all = text.join("\n")
    assert.ok(text.every((line) => line.length <= columns), `${columns}: every line fits`)
    assert.ok(text.length <= Math.min(rows - 2, 22), `${columns}×${rows}: the modal fits the terminal`)
    assert.match(all, /Route order/)
    assert.match(all, /┃1\. ChatGPT personal · gpt-5/)
    assert.match(all, /Preview next turn/)
    assert.match(all.replace(/\s+/g, " "), /Suggested: 2\. ChatGPT work · OpenAI · gpt-5/, "the ideal destination")
    if (columns >= 80) {
      assert.match(all, /5 h: 91% used/)
      assert.match(all, /Manual: Account switch is global · \/connect/, "and that it is not applied")
      assert.match(all, /Weekly: 94% used/, "only the selected row's reason")
    }
    assert.deepEqual(layout.footer.flatMap((line) => line.items.map((item) => item.action)), ["routeAdd", "routeEdit", "routeOptions", "save"])
    assert.doesNotMatch(all, /Unchecked|Enter model|Watch turns|r Refresh|a Refresh all/)
  }
  // Below the threshold the selection stays, whatever its place in the list.
  const below = snapshot()
  below.integrations[1].connections[0].samples = [q("5h", 84), q("weekly", 50)]
  assert.match(screenText(modalLayout(below, { now: T0 + 60_000, route, selection: opus, columns: 120, rows: 40 })).join("\n"), /Keep current model/)
  // No selection, no guess.
  assert.match(screenText(modalLayout(snapshot(), { now: T0, route, columns: 120, rows: 40 })).join("\n"), /Open a chat to preview its next turn/)
})

test("R3: the preview uses held data only and never offers a reader", () => {
  const d = routePreview(snapshot(), targets, opus, T0 + 10 * 60_000)
  assert.deepEqual([d.kind, d.reason], ["keep", "Refresh required"], "stale origin: say what to refresh, read nothing")
})

test("R3: add, move, edit and remove accounts locally; duplicate checks ignore key order", () => {
  let draft = { revision: 4, targets: [], index: 0 }
  draft = putRoute(draft, targets[2])
  assert.equal(putRoute(draft, { binding: "current", modelID: "opus", providerID: "claude-agent", integrationID: "claude-agent" }), undefined)
  const account = accountChoices(snapshot()).find((c) => c.title === "ChatGPT work").value
  draft = putRoute(draft, account)
  assert.equal(draft.index, 1)
  draft = routeMove(draft, -1)
  assert.deepEqual(draft.targets.map((t) => t.modelID), [undefined, "opus"])
  assert.equal(routeMove(draft, -1), draft, "the first row does not move up")
  draft = putRoute(draft, { ...account, variant: "high" }, 0)
  draft = routeRemove(routeStep(draft, 1))
  assert.deepEqual(routeProposal(draft), { revision: 4, targets: [{ ...account, variant: "high" }] })
  assert.equal(startRoute({ routing: { state: "unsupported" } }), undefined, "a future schema is read-only")
})

test("R3: native pickers use this provider's catalog, preserve cancellation, and work outside a session", async () => {
  const models = [
    { providerID: "claude-agent", id: "cl/sonnet", name: "Friendly Sonnet", enabled: true, variants: [{ id: "thorough" }] },
    { providerID: "claude-agent", id: "opus", name: "Opus", enabled: true, variants: [] },
    { providerID: "claude-agent", id: "hidden", enabled: false, variants: [] },
    { providerID: "openai", id: "gpt-5", name: "Chat model", enabled: true, variants: [{ id: "quick" }] },
  ]
  const run = async (target, edit, choices, selection, catalog = models) => {
    const menus = []
    const row = await pickDestination({ snapshot: snapshot(), target, edit, selection, catalog: async () => catalog,
      pick: async ({ title, options }) => {
        menus.push([title, options.map((o) => o.title)])
        const wanted = choices.shift()
        if (wanted === undefined) return undefined
        const option = options.find((o) => o.title === wanted)
        assert.ok(option, `${wanted} in ${title}`)
        return option.value
      } })
    assert.equal(choices.length, 0)
    return { row, menus }
  }
  const cl = { integrationID: "claude-agent", providerID: "claude-agent", connectionID: "cl", binding: "exact" }
  const added = await run(undefined, "add", ["Claude", "Friendly Sonnet", "thorough"])
  assert.deepEqual(added.row, { ...cl, modelID: "cl/sonnet", variant: "thorough" })
  assert.deepEqual(added.menus.slice(1), [["Choose model", ["Keep current model", "Friendly Sonnet", "Opus"]], ["Choose effort", ["Automatic", "thorough"]]])
  assert.deepEqual((await run(added.row, "model", ["Opus"])).row, { ...cl, modelID: "opus" }, "another model does not inherit a pinned effort")
  const noEfforts = models.map((m) => ({ ...m, variants: [] }))
  assert.deepEqual((await run(added.row, "model", ["Friendly Sonnet", "Automatic"], undefined, noEfforts)).row, { ...cl, modelID: "cl/sonnet" },
    "a previously pinned effort that has vanished from this same model can be cleared explicitly")
  const before = structuredClone(added.row)
  assert.equal((await run(added.row, "account", ["ChatGPT work", "Chat model", undefined])).row, undefined)
  assert.deepEqual(added.row, before, "cancel at the last step did not partially edit the old row")
  const work = { integrationID: "openai", providerID: "openai", connectionID: "oa-2", binding: "exact" }
  assert.deepEqual((await run(before, "account", ["ChatGPT work", "Keep current model"], opus)).row, work, "neither Claude ID crosses to ChatGPT")
  assert.deepEqual((await run(work, "effort", ["quick"], { providerID: "openai", modelID: "gpt-5" })).row, { ...work, variant: "quick" })
  assert.deepEqual((await run({ ...work, variant: "quick" }, "effort", ["Automatic"])).row, work)
  assert.deepEqual((await run(undefined, "add", ["ChatGPT work", "Keep current model"], undefined, null)).row, work, "unloaded catalog offers only inheritance")
})

test("R3: the threshold uses the preferences revision, keeping the rest", () => {
  const snap = snapshot()
  snap.integrations.forEach((i) => (i.connections = i.connections.map((c) => ({ ...c }))))
  assert.deepEqual(proposalFrom(snap, { revision: snap.preferences.revision, threshold: 90 }),
    { revision: 2, threshold: 90, minimums: { USD: "0.20" }, order: { openai: ["oa-1", "oa-2"], "claude-agent": ["cl"], deepseek: ["ds"] } })
  assert.deepEqual(legend({ route: { targets: [] } }, 110).map((k) => k.key), ["a", "o", "s"], "no Edit on an empty list")
})

// The turn-end notice (rules.createAdvisor over view.decide), evaluated on the held snapshot as the TUI does.
const sel = opus
const view = (snap, now) => ({ account: (s) => activeAccount(snap, s), evaluate: (s) => decide(snap, s, now) })
const context = (snap, now) => ({ sessionID: "ses-1", selection: sel, ...view(snap, now) })
const ended = (advisor, snap, now, id) => advisor.turnEnded({ id, type: "session.execution.succeeded", data: { sessionID: "ses-1" } }, context(snap, now))
const shownNotice = (advisor, snap, now) => {
  const current = advisor.current(context(snap, now))
  return current && { ...current, integrationID: current.selection.providerID }
}
const previewOf = (snap, now) => screenText(modalLayout(snap, { now, route: startRoute(snap), selection: sel, columns: 120, rows: 40 })).join("\n")
const nextTurnOf = (all) => all.match(/│ (Suggested: [^\n]+|No destination · [^\n]+)/)[1].trimEnd()

test("R3: with a saved route order the turn-end notice names the preview's destination, provider and reason", () => {
  const snap = snapshot()
  const now = T0 + 60_000
  const advisor = createAdvisor()
  assert.equal(ended(advisor, snap, now, "e1"), true, "Opus at 91 % raises a notice at the turn end")
  const notice = shownNotice(advisor, snap, now)
  const all = previewOf(snap, now)
  assert.match(nextTurnOf(all), /^Suggested: 2\. ChatGPT work · OpenAI · gpt-5$/)
  const [alert] = alertRows(snap, { notice }, 400)
  assert.equal(alert.text, "5 h: 91% used. Suggested: 2. ChatGPT work · OpenAI · gpt-5. Manual: Account switch is global · /connect")
  assert.ok(all.includes("Manual: Account switch is global · /connect"), "the same manual reason as the preview")
  assert.equal(compactLine(snap, sel, notice),
    "Claude · 5 h: 91% used · Suggested: 2. ChatGPT work · OpenAI · gpt-5 · /quota")
  assert.doesNotMatch(alert.text, /TURING|No confirmed alternative/, "not the per-integration recommendation")
  // The same destination as the global engine on the same held data, whatever the integration of the selection.
  const d = routePreview(snap, snap.routing.targets, sel, now)
  assert.deepEqual([d.kind, d.target, d.reason], ["suggest", 1, "Account switch is global"])

  // Paid API allowed for the session and both ChatGPT rows high: DeepSeek is the preview's and the notice's answer.
  const paid = snapshot({ mode: "preview", paid: true })
  paid.integrations[0].connections[1].samples = [q("5h", 95), q("weekly", 30)]
  paid.integrations[2].connections[0].samples = [{ source: "b", window: "balance", scope: "general", observedAt: T0, available: true, balances: [{ currency: "USD", total: "5.00" }] }]
  const other = createAdvisor()
  assert.equal(ended(other, paid, now, "p1"), true)
  assert.match(nextTurnOf(previewOf(paid, now)), /^Suggested: 4\. DeepSeek · Active account · deepseek-chat$/)
  assert.equal(alertRows(paid, { notice: shownNotice(other, paid, now) }, 400)[0].text,
    "5 h: 91% used. Suggested: 4. DeepSeek · Active account · deepseek-chat. Manual: Model switch not enabled · /models")
  // Without paid consent nothing is eligible: the preview's first reason, word for word.
  const unpaid = snapshot()
  unpaid.integrations[0].connections[1].samples = paid.integrations[0].connections[1].samples
  unpaid.integrations[2].connections[0].samples = paid.integrations[2].connections[0].samples
  const none = createAdvisor()
  assert.equal(ended(none, unpaid, now, "u1"), true)
  assert.match(nextTurnOf(previewOf(unpaid, now)), /^No destination · Weekly: 94% used$/)
  assert.equal(alertRows(unpaid, { notice: shownNotice(none, unpaid, now) }, 400)[0].text, "5 h: 91% used. No destination · Weekly: 94% used")
})

test("R3: the route notice keeps the advisor's rules: event only, held data only, TTL withdrawal, recovery, dismissal", () => {
  const snap = snapshot()
  const advisor = createAdvisor()
  const now = T0 + 60_000
  assert.equal(advisor.turnEnded({ id: "s1", type: "session.step.ended", data: { sessionID: "ses-1" } }, context(snap, now)), false, "a step is no turn end")
  assert.equal(advisor.pending(), false, "a snapshot alone never raises a notice")
  advisor.observe(view(snap, now))
  assert.equal(advisor.pending(), false)
  assert.equal(ended(advisor, snap, now, "t1"), true)
  assert.equal(ended(advisor, snap, now, "t1"), false, "one event, once")
  // The clock revalidates it at the first freshness expiry or known reset of a held sample: the ChatGPT and Opus samples
  // share the default 150 s, before the weekly reset.
  assert.equal(nextExpiry(snap, now), T0 + 150_000, "the 150 s freshness comes first")
  assert.ok(shownNotice(advisor, snap, T0 + 149_000))
  // At T0 + 150 s the data is stale: the advice changes, so this notice is withdrawn, not rewritten.
  assert.equal(shownNotice(advisor, snap, T0 + 150_000), undefined, "withdrawn when the held data no longer gives the same advice")
  // A fresh sample below the threshold for what triggered ends the episode; crossing again notifies again.
  const fresh = (used, at) => {
    const s = snapshot()
    s.integrations[1].connections[0].samples = [q("5h", used, { observedAt: at }), q("weekly", 50, { observedAt: at })]
    s.integrations[0].connections.forEach((c) => (c.samples = c.samples.map((x) => ({ ...x, observedAt: at }))))
    return s
  }
  assert.equal(ended(advisor, fresh(91, T0 + 200_000), T0 + 200_000, "t2"), true)
  advisor.dismiss()
  assert.equal(ended(advisor, fresh(91, T0 + 210_000), T0 + 210_000, "t3"), false, "dismissed: not repeated in the episode")
  advisor.observe(view(fresh(50, T0 + 220_000), T0 + 220_000))
  assert.equal(ended(advisor, fresh(91, T0 + 230_000), T0 + 230_000, "t4"), true, "recovered by a fresh sample, then crossed again")
  // Saving another order changes the advice: the held notice is withdrawn, and only a turn end raises a new one.
  const reordered = fresh(91, T0 + 230_000)
  reordered.routing = { ...reordered.routing, revision: 5, targets: [targets[3], targets[0]] }
  advisor.observe(view(reordered, T0 + 231_000))
  assert.equal(advisor.pending(), false)
})

test("R3: the snapshot's usageFreshnessSeconds governs the preview, the notice and its timer; DeepSeek keeps 2 min", () => {
  const now = T0 + 60_000
  const short = { ...snapshot(), usageFreshnessSeconds: 30 }
  assert.equal(nextExpiry(short, T0 + 1), T0 + 30_000, "the clock revalidates at this location's freshness")
  // Opus at 91 % and the reserve were read a minute ago: fresh by default, stale with 30 s.
  assert.match(nextTurnOf(previewOf(snapshot(), now)), /^Suggested: 2\. ChatGPT work/)
  assert.deepEqual([routePreview(short, targets, opus, now).kind, routePreview(short, targets, opus, now).reason], ["keep", "Refresh required"])
  assert.match(previewOf(short, now), /Keep current model · Refresh required/)
  assert.equal(ended(createAdvisor(), snapshot(), now, "default"), true)
  assert.equal(ended(createAdvisor(), short, now, "short"), false, "no notice from data this location calls stale")
  assert.equal(decide(short, opus, now).kind, "idle")
  // A long option keeps them fresh past 150 s, never past a reset, and leaves DeepSeek's 2 min alone.
  const long = { ...snapshot(), usageFreshnessSeconds: 3600 }
  assert.equal(ended(createAdvisor(), long, T0 + 10 * 60_000, "long"), true)
  assert.equal(nextExpiry(long, T0 + 1), T0 + 3_600_000)
  const balance = (snap) => {
    snap.routing = undefined
    snap.integrations[2].connections[0].samples = [{ source: "b", window: "balance", scope: "general", observedAt: T0, available: true, balances: [{ currency: "USD", total: "0.20" }] }]
    return snap
  }
  assert.equal(nextExpiry(balance(long), T0 + 1), T0 + 120_000)
  assert.equal(decide(balance(long), { providerID: "deepseek", modelID: "deepseek-chat" }, T0 + 120_000).kind, "idle", "a 2 min old balance is stale")
})

test("R3: preview and notice name the same effective ChatGPT model and effort for an unpinned account", () => {
  const snap = snapshot()
  const { modelID, ...reserve } = targets[1]
  snap.routing.targets = [reserve]
  snap.catalog = [{ providerID: "openai", id: modelID, name: "Chat model", enabled: true, variants: [{ id: "high" }] }]
  const selection = { providerID: "openai", modelID, variant: "high" }
  const next = decide(snap, selection, T0 + 1)
  assert.equal(next.next, "Suggested: 1. ChatGPT work · OpenAI · Chat model #high")
  const text = screenText(modalLayout(snap, { route: startRoute(snap), selection, now: T0 + 1 })).join("\n")
  assert.equal(nextTurnOf(text), next.next)
})

test("R3: without a saved route order the notice stays the per-integration recommendation over the legacy order", () => {
  for (const routing of [{ state: "available", revision: 0, targets: [] }, { state: "unavailable" }, undefined]) {
    const snap = snapshot()
    snap.routing = routing
    // Two DeepSeek keys in their saved order; the active one at its minimum.
    snap.integrations[2].connections = [
      { id: "ds", label: "Main", method: "key", active: true, samples: [{ source: "b", window: "balance", scope: "general", observedAt: T0, available: true, balances: [{ currency: "USD", total: "0.20" }] }] },
      { id: "ds-2", label: "Backup", method: "key", active: false, reconnectRequired: true },
    ]
    const ds = { providerID: "deepseek", modelID: "deepseek-chat" }
    const result = decide(snap, ds, T0 + 1)
    assert.deepEqual([result.kind, result.route, result.reason, result.trigger.text], ["none", undefined, "Reconnect required", "Low balance: USD 0.20"])
    assert.equal(nextExpiry(snap, T0 + 1), T0 + 120_000)
    const advisor = createAdvisor()
    const ctx = { sessionID: "ses-1", selection: ds, account: (s) => activeAccount(snap, s), evaluate: (s) => decide(snap, s, T0 + 1) }
    assert.equal(advisor.turnEnded({ id: "d1", type: "session.execution.failed", data: { sessionID: "ses-1" } }, ctx), true)
    const notice = { ...advisor.current(ctx), integrationID: "deepseek" }
    assert.equal(alertRows(snap, { notice }, 400)[0].text, "Last turn failed. Low balance: USD 0.20. No confirmed alternative: Reconnect required")
  }
  // A saved order that cannot be read (future schema) is not used either.
  assert.equal(decide({ ...snapshot(), routing: { state: "unsupported" } }, opus, T0 + 60_000).route, undefined)
})
