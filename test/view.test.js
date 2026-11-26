// Plain-text views (support for T10, T11, T12): states are words, not colors; native labels cannot inject
// terminal controls; the notice minimum is edited locally until Save. The modal is laid out as lines of a known width, so
// these tests read the text the TUI draws; the HOST cases check it on screen.
import assert from "node:assert/strict"
import { test } from "node:test"
import { refKey } from "../inventory.js"
import { createAdvisor } from "../rules.js"
import {
  accountRefs, activeAccount, alertRows, batchRefs, batchSummary, compactLine, compactParts, conflicted, decide, fitBody, keyAction, legend, minimumText, refreshRpcError,
  modalFooter, modalLayout, modalRows, modalWidth, nextExpiry, pickCurrency, proposalFrom, screenText, scrollStart,
  sessionRef, setAmount, shiftCurrency, staleRefs, startMinimum, turnOff, windowRows, wrap,
} from "../view.js"

const T0 = Date.UTC(2026, 10, 24, 12)
const HOUR = 3_600_000
const prefs = { state: "available", revision: 3, mode: "recommend", threshold: 95, minimums: {} }
// Text as a terminal shows it: no trailing blanks, no blank spacer lines.
const text = (rows) => rows.map((row) => row.text.trimEnd()).filter((line) => line !== "")
const quota = (window, used, extra = {}) => ({ source: "lab", window, scope: "general", observedAt: T0, used, ...extra })
const detailOf = (rows) => text(rows.filter((row) => row.zone === "detail" && !row.rule))
const listOf = (rows) => text(rows.filter((row) => row.zone !== "detail"))
const keysText = (items) => items.map(({ key, label }) => `${key} ${label}`).join("   ")
const squeeze = (line) => line.replace(/ +/g, " ")

const snapshot = () => ({
  schema: 2, revision: 9, scope: "personal-server", inventory: "available", preferences: prefs,
  integrations: [
    {
      id: "openai", active: "connection", refreshable: false,
      connections: [
        { id: "oa-1", label: "Work\u001b[31m", method: "oauth", active: true, samples: [quota("5h", 100, { resetsAt: T0 + HOUR }), quota("weekly", 61)] },
        { id: "oa-2", label: " ", method: "oauth", active: false },
      ],
    },
    { id: "claude-agent", active: "connection", refreshable: false, connections: [{ id: "cl-1", label: "Claude", method: "external", active: true }] },
    {
      id: "deepseek", active: "connection", refreshable: true,
      connections: [
        { id: "ds-1", label: "Main", method: "key", active: true, samples: [{ source: "deepseek-balance", window: "balance", scope: "general", observedAt: T0, available: true, balances: [{ currency: "USD", total: "8.42" }, { currency: "CNY", total: "0.10" }] }] },
        { id: "ds-2", label: "Backup", method: "key", active: false, reconnectRequired: true },
        { id: "ds-3", label: "Spare", method: "key", active: false, failure: { source: "deepseek-balance", at: T0, reason: "rate-limit", retryAt: T0 + 60_000 } },
        { id: "ds-4", label: "Fourth", method: "key", active: false },
      ],
    },
  ],
})
// The experimental Codex reader on, with figures for the active login.
const codexOn = () => {
  const snap = snapshot()
  snap.integrations[0] = { ...snap.integrations[0], refreshable: true, manual: true }
  snap.integrations[0].connections[0].samples = [quota("5h", 42, { source: "codex-usage", resetsAt: T0 + HOUR }),
    quota("weekly", 16, { source: "codex-usage", resetsAt: T0 + 4 * 24 * HOUR })]
  return snap
}

test("unavailable, empty and unknown-format states are distinct, in one column, and point to native management once", () => {
  assert.deepEqual(text(modalRows(undefined)), ["Inventory unavailable.", "Manage accounts: /connect"])
  assert.deepEqual(text(modalRows({ inventory: "available", preferences: prefs, integrations: [] })),
    ["No saved connections.", "Manage accounts: /connect"])
  assert.equal(text(modalRows({ inventory: "available", preferences: { state: "unsupported" }, integrations: [] }))[0],
    "Preferences use an unknown format; not changed.")
  for (const snap of [undefined, { inventory: "available", preferences: prefs, integrations: [] }]) {
    const layout = modalLayout(snap, { columns: 160, rows: 40 })
    assert.equal(layout.mode, "stacked", "nothing to split")
    assert.match(layout.header.text, /^Accounts +esc$/)
  }
  const down = modalLayout(snapshot(), { columns: 120, rows: 40, flags: { failed: true } })
  assert.deepEqual([down.mode, text(down.left.rows), down.footer], ["stacked", ["Account data is unavailable.", "Manage accounts: /connect"], []])
  const unknown = modalLayout({ ...snapshot(), preferences: { state: "unsupported" } }, { columns: 120, rows: 40 })
  assert.deepEqual(text(unknown.left.rows).slice(0, 2), ["Preferences use an unknown format;", "  not changed."], "above the list, in its width")
})

test("order: Logins before API keys; OpenAI, then Claude Code, then the rest; a mixed provider in both; no group counts", () => {
  const base = snapshot()
  // The inventory lists them in another order; the screen order does not depend on it.
  const snap = { ...base, integrations: [
    base.integrations[2],
    { id: "anthropic", active: "connection", refreshable: false, connections: [{ id: "an-1", label: "API", method: "key", active: true }] },
    { id: "google", active: "environment", refreshable: false, connections: [] },
    base.integrations[1],
    { ...base.integrations[0], connections: [...base.integrations[0].connections, { id: "oa-k", label: "Key", method: "key", active: false }] },
  ] }
  const layout = modalLayout(snap, { now: T0 + 1, columns: 120, rows: 40 })
  const rows = modalRows(snap, { now: T0 + 1 }).filter((row) => row.zone !== "detail")
  const list = text(rows)
  assert.deepEqual(list.filter((line) => !/^[ ┃]/.test(line)).map(squeeze),
    ["Logins", "◎ OpenAI", "✻ Claude Code", "API keys", "◎ OpenAI", "✻ Anthropic API", "◆ DeepSeek", "◇ google env"])
  const at = rows.findIndex((row) => row.text.startsWith("API keys"))
  assert.equal(rows[at - 1].text.trim(), "", "a blank line before the second section")
  assert.deepEqual(accountRefs(snap).map((key) => JSON.parse(key)[1]), ["oa-1", "oa-2", "cl-1", "oa-k", "an-1", "ds-1", "ds-2", "ds-3", "ds-4"],
    "↑↓ walk the screen order")
  const groups = rows.filter((row) => row.click?.kind === "group").map((row) => [squeeze(row.text.trim()), JSON.parse(row.click.ref)[1]])
  assert.deepEqual(groups, [["◎ OpenAI", "oa-1"], ["✻ Claude Code", "cl-1"], ["◎ OpenAI", "oa-k"], ["✻ Anthropic API", "an-1"], ["◆ DeepSeek", "ds-1"]],
    "a provider row picks its group's first account; one without saved accounts picks nothing")
  assert.equal(/Subscri|\bplan\b/i.test(screenText(layout).join("\n")), false, "an OAuth login proves no billed plan (S16)")
  // A provider whose connection in use is not a saved one says which instead of its count, and its accounts say so too.
  const env = snapshot()
  env.integrations[2].active = "environment"
  const detail = text(modalLayout(env, { now: T0 + 1, cursor: refKey("deepseek", "ds-1"), columns: 120, rows: 40 }).right.rows)
  assert.ok(text(modalLayout(env, { columns: 120 }).left.rows).some((line) => /^◆ DeepSeek +env$/.test(line)))
  assert.ok(detail.includes("In use        Environment variable"), detail.join("\n"))
})

test("one row per account: ┃ focus margin, ● active, ○ inactive and one short figure at the right; — for no data", () => {
  const rows = modalRows(snapshot(), { now: T0 + 60_000, cursor: refKey("openai", "oa-1") })
  const list = listOf(rows)
  const at = (needle) => list.find((row) => /^[ ┃][●○] /.test(row) && row.includes(needle))
  assert.match(at("Work"), /^┃● Work \[31m +5 h {2}100% used$/, "control characters neutralized; the window of the figure is named")
  assert.match(at("(no alias)"), /^ ○ \(no alias\) +—$/, "unfocused: no margin; absence is a dash")
  assert.match(at(" Claude "), /^ ● Claude +—$/)
  assert.match(at("Main"), /^ ● Main +USD 8\.42 · CNY 0\.10$/, "a balance per currency, no bar, no conversion")
  assert.match(at("Backup"), /^ ○ Backup +Sign in again$/)
  assert.match(at("Spare"), /^ ○ Spare +Failed$/)
  assert.match(at("Fourth"), /^ ○ Fourth +—$/)
  assert.equal(list.filter((row) => row.startsWith("┃")).length, 1, "exactly one focused row")
  const accounts = rows.filter((row) => row.ref)
  assert.equal(new Set(accounts.map((row) => row.text.length)).size, 1, "rows are one even band")
  assert.equal(new Set(accounts.map((row) => row.text.trimEnd().length)).size, 1, "figures end at one right edge")
  assert.ok(!list.some((row) => /Active/.test(row)))
  assert.equal(list.some((row) => /[█░]/.test(row)), false, "no meters in the list")
  assert.equal(list.some((row) => /Notice at|experimental|\/connect|reset|Updated/i.test(row)), false, "shared facts are not repeated per row")
  const focused = rows.find((row) => row.selected)
  assert.ok(focused.anchor && focused.ref === refKey("openai", "oa-1"))
  const marks = focused.parts.slice(0, 2)
  assert.deepEqual(marks.map((part) => [part.text, part.tone, part.keep]), [["┃", "focus", true], ["●", "success", true]],
    "the margin and the dot keep their roles inside the focus band")
  assert.ok(!focused.parts.some((part) => part.chip))
  // Not current: the state in one word; the value stays in the detail.
  const stale = listOf(modalRows(snapshot(), { now: T0 + 5 * 60_000 }))
  assert.match(stale.find((row) => row.includes("Work")), / +Stale$/)
  assert.match(stale.find((row) => row.includes("Main")), / +Stale$/)
})

test("freshness comes from the snapshot's own location: ChatGPT at 150 s by default or its option; DeepSeek keeps 2 min", () => {
  const work = (snap, now) => listOf(modalRows(snap, { now })).find((row) => row.includes("Work"))
  assert.match(work(snapshot(), T0 + 150_000 - 1), /5 h {2}100% used$/)
  assert.match(work(snapshot(), T0 + 150_000), / +Stale$/)
  assert.match(work({ ...snapshot(), usageFreshnessSeconds: 0 }, T0 + 150_000 - 1), /5 h {2}100% used$/, "an invalid value is the default")
  const short = { ...snapshot(), usageFreshnessSeconds: 30 }
  assert.match(work(short, T0 + 30_000 - 1), /5 h {2}100% used$/)
  assert.match(work(short, T0 + 30_000), / +Stale$/)
  assert.match(detailOf(modalRows(short, { now: T0 + 30_000, cursor: refKey("openai", "oa-1"), width: 72 }))[1], /^5 h +█+ 100% used · Stale$/)
  const long = { ...snapshot(), usageFreshnessSeconds: 3600 }
  assert.match(work(long, T0 + 10 * 60_000), /5 h {2}100% used$/)
  assert.match(work(long, T0 + HOUR), / +Stale$/, "never past the window's reset")
  const main = listOf(modalRows(long, { now: T0 + 2 * 60_000 })).find((row) => row.includes("Main"))
  assert.match(main, / +Stale$/, "a DeepSeek balance keeps its 2 min")
  assert.ok(staleRefs(long, T0 + 2 * 60_000).some((ref) => ref.connectionID === "ds-1"), "and opening the modal reads it again")
})

test("account list compares 5 h only; weekly-only usage stays in the selected detail", () => {
  const snap = snapshot()
  const account = snap.integrations[0].connections[0]
  const show = () => modalRows(snap, { now: T0, cursor: refKey("openai", account.id) })
  account.samples = [quota("weekly", 99), quota("5h", 0)]
  for (const columns of [32, 40, 80, 100, 120]) {
    const { left } = modalLayout(snap, { now: T0, columns, cursor: refKey("openai", account.id) })
    const row = left.rows.find((row) => row.selected && row.text.includes("0% used"))
    assert.match(row.text, /5 h {2}0% used $/, `${columns} columns: label gap and one-column right gutter`)
    assert.equal(row.text.length, left.width, "the clickable focus band includes the gutter")
    assert.equal(row.parts.map((part) => part.text).join(""), row.text)
  }
  account.samples.pop()
  assert.match(listOf(show()).find((row) => row.startsWith("┃")), /—$/)
  assert.match(detailOf(show())[1], /^Weekly +█+░+ 99% used$/)
})

test("detail of the focused account: heading with its chips, a meter and its renewal per window, then one fact per row", () => {
  const rows = modalRows(snapshot(), { now: T0 + 60_000, cursor: refKey("openai", "oa-1"), width: 72 })
  const detail = detailOf(rows)
  assert.match(detail[0], /^◎ Work \[31m$/, "whose figures they are")
  assert.match(detail[1], /^5 h +█+ 100% used$/)
  assert.match(detail[2], /^ {7}Resets \S/)
  assert.match(detail[3], /^Weekly +█+░+ 61% used$/)
  assert.deepEqual(detail.slice(4), ["Updated       1 min ago", "Type          OAuth login"])
  for (const row of rows) assert.ok(row.text.length <= 72, row.text)
  assert.deepEqual(rows.filter((row) => row.text.includes("█")).map((row) => row.parts.map((part) => part.tone)),
    [["base", "warning", "faint", "warning"], ["base", "accent", "faint", "base"]])

  const stale = modalRows(snapshot(), { now: T0 + 5 * 60_000, cursor: refKey("openai", "oa-1"), width: 72 })
  assert.match(detailOf(stale)[1], /^5 h +█+ 100% used · Stale$/, "an old value says Stale, without a renewal")
  assert.equal(detailOf(stale).some((row) => row.includes("Resets")), false)
  assert.ok(detailOf(stale).includes("Updated       5 min ago"))
  assert.deepEqual(stale.filter((row) => row.text.includes("█")).map((row) => row.parts[1].tone), ["warning", "muted"], "a stale fill is dimmed")

  const none = detailOf(modalRows(snapshot(), { now: T0, cursor: refKey("deepseek", "ds-4") }))
  assert.deepEqual(none, ["◆ Fourth", "Usage         —", "Notice at     USD off · CNY off", "Type          API key"],
    "no data: a dash, never 0 or an empty meter")
  const failed = detailOf(modalRows(snapshot(), { now: T0 + 1, cursor: refKey("deepseek", "ds-3") }))
  assert.ok(failed.some((row) => /^Error {9}Rate limited \(429\) at \S/.test(row)), failed.join("\n"))
  assert.ok(failed.some((row) => /^Retry {9}After \S/.test(row)), failed.join("\n"))
  const lost = detailOf(modalRows(snapshot(), { now: T0, cursor: refKey("deepseek", "ds-2") }))
  assert.match(lost[0], /^◆ Backup +Sign in again$/)
  const main = modalRows(snapshot(), { now: T0 + 60_000, cursor: refKey("deepseek", "ds-1") })
  assert.deepEqual(detailOf(main).slice(1, 3), ["Balance       USD 8.42", "              CNY 0.10"], "one currency per line")
  const blocked = snapshot()
  blocked.integrations[2].connections[0].samples[0].available = false
  assert.ok(detailOf(modalRows(blocked, { now: T0 + 1, cursor: refKey("deepseek", "ds-1") })).includes("API calls     Not available"))
  const old = detailOf(modalRows(snapshot(), { now: T0 + 5 * 60_000, cursor: refKey("deepseek", "ds-1") }))
  assert.equal(old[1], "Balance       USD 8.42 · Stale")
})

test("— for no data and one fact per detail row: · only joins a list of the same kind or a value with its state", () => {
  const snaps = [snapshot(), codexOn()]
  snaps[1].integrations[1].passive = true
  for (const snap of snaps) {
    for (const cursor of accountRefs(snap)) {
      for (const columns of [40, 80, 100, 120, 160]) {
        const layout = modalLayout(snap, { now: T0 + 60_000, cursor, columns, rows: 60 })
        const all = screenText(layout).join("\n")
        assert.equal(/No data|OpenAI OAuth|experimental source|Low-balance notice \(informational|Manage usage|Manage accounts|Refresh failed:|Source:/.test(all), false, all)
        const detail = text(layout.mode === "split" ? layout.right.rows : layout.left.rows.filter((row) => row.zone === "detail"))
        for (const row of detail.filter((line) => line.includes(" · "))) {
          assert.match(row, /^(Notice at {5}USD \S+ · CNY \S+|Balance {7}[A-Z]{3} [\d.?]+ · (Stale|Refresh failed)|.*\d% used · (Stale|Refresh failed))$/, row)
        }
        for (const row of detail.filter((line) => /^[A-Z][A-Za-z ]+ {2,}\S/.test(line) && !/% used/.test(line))) {
          assert.ok(row.length - 14 <= 40, `a short value: ${row}`)
        }
      }
    }
  }
})

test("meters: empty at 0, full only at 100, never a bar without its number", () => {
  const snap = (samples) => ({ ...snapshot(), integrations: [{ id: "openai", active: "connection", refreshable: false,
    connections: [{ id: "x", label: "X", method: "oauth", active: true, samples }] }] })
  const detail = (samples, width = 60) => detailOf(modalRows(snap(samples), { now: T0 + 1, cursor: refKey("openai", "x"), width }))
  const bar = (samples) => detail(samples)[1].match(/[█░]+/)[0]
  assert.equal(bar([quota("5h", 0)]), "░".repeat(45), "0% is the empty track")
  assert.equal(bar([quota("5h", 99.99)]), "█".repeat(40) + "░", "never full before 100")
  assert.equal(bar([quota("5h", 100)]), "█".repeat(43))
  assert.deepEqual(detail([quota("5h", 40)], 20)[1], "5 h    █░░░ 40% used", "narrow: the same, shorter")
  for (const snapshotOf of [snapshot, codexOn]) {
    for (const columns of [40, 80, 100, 120, 160]) {
      for (const cursor of accountRefs(snapshotOf())) {
        const layout = modalLayout(snapshotOf(), { now: T0 + 1, cursor, columns, rows: 60, message: "Preferences changed. Reload before saving." })
        for (const line of screenText(layout)) assert.ok(line.length <= layout.width, `${columns} columns: ${JSON.stringify(line)}`)
        const panel = layout.mode === "split" ? text(layout.right.rows) : text(layout.left.rows)
        panel.forEach((row) => {
          if (/[█░]/.test(row)) assert.match(row, /\d+(\.\d+)?% used/, "a meter never appears without its number")
        })
      }
    }
  }
  assert.deepEqual([40, 80, 91, 92, 100, 120, 160].map(modalWidth), [34, 74, 85, 86, 94, 112, 112], "xlarge dialog: min(116, columns − 2) − 2 − 2")
  assert.deepEqual(wrap("   one two three", 9, "   "), ["   one", "   two", "   three"])
  assert.deepEqual(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"], "a long word is cut, not lost")
  assert.deepEqual(wrap("Mode: Recommend · Threshold: 95% used", 34), ["Mode: Recommend · Threshold:", "95% used"],
    "a percentage keeps its unit on its line")
})

test("header: Accounts at the left, esc alone at the right; no key of the footer says Esc", () => {
  for (const columns of [20, 40, 64, 120]) {
    const { header, width } = modalLayout(snapshot(), { columns })
    assert.match(header.text, /^Accounts +esc$/)
    assert.equal(header.text.length, width)
  }
  for (const mode of [{}, { refreshAll: true, deepseek: true, notice: {} }, { minimum: {} }, { route: {} }]) {
    for (const width of [32, 72, 110]) assert.equal(legend(mode, width).some((item) => /esc/i.test(`${item.key} ${item.label}`)), false)
  }
})

test("keys: one action per key, centered with equal gaps when they fit, otherwise centered lines that keep a key with its action", () => {
  assert.deepEqual(legend({ refreshAll: true, deepseek: true, notice: {} }).map((item) => item.action), ["refresh", "refreshAll", "route", "notice", "dismiss"])
  assert.deepEqual(legend({ minimum: {} }).map((item) => item.action), ["amount", "off", "save"])
  assert.deepEqual(legend({ route: { targets: [{}] } }).map((item) => item.action), ["routeAdd", "routeEdit", "routeOptions", "save"])
  assert.equal(keysText(legend({})), "r Refresh   o Route order")
  // No decorative entry in any mode: no ↑↓ (the arrows still move the focus), no Priorities editor, every key acts.
  for (const mode of [{}, { refreshAll: true, deepseek: true, notice: {} }, { minimum: {} }, { route: {} }]) {
    for (const width of [32, 110]) {
      const items = legend(mode, width)
      assert.ok(items.every((item) => item.action), JSON.stringify(mode))
      assert.equal(/↑|↓|Select|Currency|Priorit/.test(items.map((item) => `${item.key} ${item.label}`).join("\n")), false, JSON.stringify(mode))
      assert.equal(items.some((item) => item.key === "p"), false)
    }
  }
  for (const mode of [{}, { refreshAll: true, deepseek: true }, { refreshAll: true, deepseek: true, notice: {} }, { minimum: {} }, { route: {} }]) {
    for (const width of [20, 32, 50, 72, 84, 110]) {
      const items = legend(mode, width)
      const lines = modalFooter(items, width)
      assert.deepEqual(lines.flatMap((line) => line.items), items, "every key once, in order")
      assert.ok(Math.abs(width - lines[0].text.length - lines[0].left) <= 1, "the full grid is centered")
      for (const line of lines) {
        assert.equal(line.left, lines[0].left)
        assert.ok(line.text.length <= width)
        for (const cell of line.cells) assert.ok(line.text.includes(`${cell.key} ${cell.label}`))
      }
    }
  }
  const narrow = modalFooter(legend({ deepseek: true }, 34), 34)
  assert.deepEqual(narrow.map((line) => line.text.trim().split(/ {2,}/)), [["r Refresh", "o Route", "m Notice"]], "40 columns: one line")
  const four = modalFooter(legend({ refreshAll: true, deepseek: true }, 34), 34)
  assert.deepEqual(four.map((line) => line.items.length), [2, 2])
  assert.equal(four[0].text.indexOf("r Refresh"), four[1].text.indexOf("o Route"))
  assert.equal(four[0].text.indexOf("a All"), four[1].text.indexOf("m Notice"))
  for (const width of [34, 84]) {
    assert.equal(/Low balance|No confirmed/.test(keysText(legend({ deepseek: true, refreshAll: true }, width))), false, "a key never reads like the notice itself")
  }
})

// The HOST's footer_grid (scripts/check-host.py), over plain key lines: why they are not a centered grid, or null.
function footerGrid(keys, width) {
  if (!keys.length || !keys.every((line) => line.trim())) return "an empty key line"
  const left = Math.min(...keys.map((line) => line.length - line.trimStart().length))
  const widest = Math.max(...keys.map((line) => line.trimEnd().length))
  if (widest > width || Math.abs(left - (width - widest)) > 1) return "keys not centered"
  const labels = keys.map((line) => [...line.trimEnd().matchAll(/(\S+) (\S.*?)(?= {2,}|$)/g)].map((m) => m.index + m[1].length + 1))
  const full = labels[0].length
  if (labels.slice(0, -1).some((row) => row.length !== full) || !(labels.at(-1).length > 0 && labels.at(-1).length <= full)) return "only the last key row may be shorter"
  if (labels.some((row) => row.some((at, i) => at !== labels[0][i]))) return "key row off the grid's columns"
  return null
}

test("T11 fixture: the footer on screen is a centered grid; a short last row keeps the columns instead of centering alone", () => {
  // The HOST terminals of T11 (40/80/120 columns are 34/74/112 text columns) and narrower, every mode.
  for (const columns of [24, 36, 40, 54, 80, 88, 120]) {
    for (const mode of [{}, { minimum: {} }]) {
      const layout = modalLayout(snapshot(), { columns, ...mode })
      const lines = screenText(layout)
      const keys = lines.slice(lines.lastIndexOf("─".repeat(layout.width)) + 1)
      assert.equal(keys.length, layout.footer.length)
      assert.equal(footerGrid(keys, layout.width), null, `${columns} cols ${JSON.stringify(mode)}:\n${keys.join("\n")}`)
    }
    // A populated route editor and a shown notice use the same footer grid.
    const width = modalWidth(columns)
    for (const mode of [{ route: { targets: [{}] } }, { notice: {}, deepseek: true, refreshAll: true }]) {
      const keys = modalFooter(legend(mode, width), width).map((line) => line.text.trimEnd())
      assert.equal(footerGrid(keys, width), null, `${columns} cols ${Object.keys(mode)}:\n${keys.join("\n")}`)
    }
  }
  // T11's 40 columns (34 of text): the three main keys on one centered line.
  const layout = modalLayout(snapshot(), { columns: 40 })
  assert.equal(layout.width, 34)
  assert.deepEqual(screenText(layout).slice(-1).map((line) => line.trim().split(/ {2,}/)), [["r Refresh", "o Route", "m Notice"]])
  assert.equal(layout.footer.length, 1)
  // A short last row, as with a notice up: five keys in 34 columns, three over two, the short row under the first
  // columns. The rules reject the short row centered alone, and a grid off center or with a ragged column.
  const keys = modalFooter(legend({ deepseek: true, refreshAll: true, notice: {} }, 34), 34).map((line) => line.text)
  assert.deepEqual(keys.map((line) => line.trim().split(/ {2,}/)), [["r Refresh", "a All", "o Route"], ["m Notice", "x Dismiss"]])
  assert.equal(footerGrid(keys, 34), null)
  assert.equal(keys[0].indexOf("r Refresh"), keys[1].indexOf("m Notice"))
  assert.equal(keys[0].indexOf("a All"), keys[1].indexOf("x Dismiss"))
  const alone = " ".repeat(Math.floor((34 - keys[1].trim().length) / 2)) + keys[1].trim()
  assert.equal(footerGrid([keys[0], alone], 34), "key row off the grid's columns")
  assert.equal(footerGrid(keys.map((line) => `  ${line}`), 34), "keys not centered", "the whole grid two columns right")
  const wide = modalFooter(legend({ deepseek: true }, 74), 74).map((line) => line.text)
  assert.equal(wide.length, 1)
  assert.equal(footerGrid(wide, 74), null)
  assert.equal(footerGrid([wide[0].slice(2)], 74), "keys not centered", "80 cols: one line two columns left")
  assert.equal(footerGrid([keys[0], keys[1].replace("m Notice  ", "m Notice ")], 34), "key row off the grid's columns")
  assert.equal(footerGrid([keys[1], keys[0]], 34), "only the last key row may be shorter")
})

test("renewals sit under their own meter; on short terminals the gap, then captions give way before usage", () => {
  const snap = codexOn()
  const cursor = refKey("openai", "oa-1")
  for (const [rows, distance] of [[40, 3], [14, 2], [12, 1]]) {
    const detail = modalLayout(snap, { now: T0, cursor, columns: 120, rows }).right.rows
    const five = detail.findIndex((row) => /^5 h +█/.test(row.text))
    assert.ok(five >= 0)
    if (distance >= 2) assert.match(detail[five + 1].text, /^ {7}Resets \S/)
    if (distance === 3) assert.equal(detail[five + 2].text, "")
    assert.match(detail[five + distance].text, /^Weekly +█/)
    if (distance >= 2) assert.match(detail[five + distance + 1].text, /^ {7}Resets \S/)
  }
  const late = new Date(2026, 10, 25, 23, 55).getTime()
  snap.integrations[0].connections[0].samples = [quota("5h", 42, { observedAt: late, resetsAt: late + 10 * 60_000 })]
  const afterMidnight = detailOf(modalRows(snap, { now: late, cursor }))
  assert.match(afterMidnight[2], /^ {7}Resets Thu /, "a reset ten minutes away can already be on the next local day")
})

test("two panels from 84 text columns (90 terminal columns), one column below; the divider runs the body's height", () => {
  const snap = codexOn()
  for (const [columns, mode, left, right] of [[160, "split", 36, 73], [120, "split", 36, 73], [100, "split", 30, 61], [90, "split", 27, 54], [89, "stacked"], [80, "stacked"], [40, "stacked"]]) {
    const layout = modalLayout(snap, { now: T0 + 1, cursor: refKey("openai", "oa-1"), columns, rows: 40 })
    assert.equal(layout.mode, mode, `${columns} columns`)
    if (mode === "split") {
      assert.deepEqual([layout.left.width, layout.right.width, layout.left.width + 3 + layout.right.width], [left, right, layout.width])
      for (const row of layout.left.rows) assert.ok(row.text.length <= left, row.text)
      for (const row of layout.right.rows) assert.ok(row.text.length <= right, row.text)
      const body = screenText(layout).slice(2, 2 + Math.max(layout.left.rows.length, layout.right.rows.length))
      assert.ok(body.every((line) => line.slice(left, left + 3) === " │ " || line.slice(left) === " │"), body.join("\n"))
      assert.ok(layout.left.rows.filter((row) => row.ref).every((row) => row.text.length === left), "the focus band spans the list")
    }
  }
})

test("switching providers keeps the footer in place inside 22 total rows", () => {
  const snap = codexOn()
  for (const columns of [40, 80, 120]) {
    const screens = accountRefs(snap).map((cursor) => screenText(modalLayout(snap, { now: T0, cursor, columns, rows: 40 })))
    assert.equal(new Set(screens.map((screen) => screen.length)).size, 1)
    assert.equal(screens[0].length + 2, 22, "includes the host's top padding and the bottom margin")
    assert.equal(screens[0].filter((line) => line.includes("Resets ")).length, 2, `${columns} columns: both renewal times fit`)
  }
})

test("40 columns: one column; alias, dot and the figure stay; a long alias takes a line of its own, never cut", () => {
  const snap = snapshot()
  snap.integrations[0].connections[0].label = "Synthetic OpenAI login"
  snap.integrations[2].connections[3].label = "Synthetic C"
  const width = modalWidth(40)
  const rows = modalRows(snap, { now: T0 + 1, cursor: refKey("openai", "oa-1"), width })
  const list = listOf(rows)
  assert.ok(list.includes(" ○ Synthetic C".padEnd(width - 2) + "—"), "the shared columns fit: one line\n" + list.join("\n"))
  const at = list.findIndex((row) => row.includes("Synthetic OpenAI login"))
  assert.equal(list[at], "┃● Synthetic OpenAI login")
  assert.match(list[at + 1], /^ +5 h {2}100% used$/, "The figure, right-aligned, under the alias")
  const lines = rows.filter((row) => row.click?.kind === "account" && row.click.ref === refKey("openai", "oa-1"))
  assert.equal(lines.length, 2)
  assert.ok(lines.every((row) => row.selected && row.anchor && row.text.length === width), "both lines are the account: one band, one click")
  const main = list.findIndex((row) => row.includes("Main"))
  assert.equal(squeeze(list[main]), " ● Main USD 8.42 · CNY 0.10", "the full balance fits beside its alias")
  for (const row of rows) assert.ok(row.text.length <= width, row.text)
  // In a split panel a long alias is cut with …; the detail names it whole.
  const split = modalLayout(snap, { now: T0 + 1, cursor: refKey("openai", "oa-1"), columns: 100, rows: 40 })
  assert.ok(text(split.left.rows).some((row) => /^┃● Synthe[^ ]*… +5 h {2}100% used$/.test(row)), text(split.left.rows).join("\n"))
  assert.ok(text(split.left.rows).some((row) => /^ ● Main +USD 8\.42 · C.*…$/.test(row)), "a balance wider than the column is cut there")
  assert.match(text(split.right.rows)[0], /^◎ Synthetic OpenAI login$/)
})

test("a low terminal keeps the focused account visible down to one line; the detail is cut from its end", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ text: `line ${i}`, ...(i >= 12 && i <= 14 ? { anchor: true } : {}) }))
  assert.deepEqual(windowRows(rows.slice(0, 8), 8).rows.map((r) => r.text), rows.slice(0, 8).map((r) => r.text), "fits: no indicators")
  const down = windowRows(rows, 10, 0)
  assert.deepEqual(down.rows.map((r) => r.text), ["↑ 7 more", ...rows.slice(7, 15).map((r) => r.text), "↓ 15 more"], "the block ends at the bottom")
  assert.equal(scrollStart(rows, 8, 9), 9, "already visible: no movement")
  assert.equal(scrollStart(rows, 8, 20), 11, "moving up keeps one line of context above the block")
  const top = rows.map((r, i) => ({ text: r.text, ...(i >= 3 && i <= 5 ? { anchor: true } : {}) }))
  assert.equal(scrollStart(top, 8, 2), 0, "back near the top: the header comes back into view")
  assert.equal(windowRows(rows.map(({ anchor, ...r }) => r), 10, 0).rows[0].text, "", "nothing hidden above: blank, the layout does not jump")
  assert.deepEqual(windowRows(rows, 3, 0).rows.map((r) => r.text), ["↑ 12 more", "line 12", "↓ 17 more"], "one line of room: the selection, not its context")
  assert.deepEqual(windowRows(rows, 1, 0).rows.map((r) => r.text), ["line 12"], "a single line: the focused one")
  const near = rows.slice(0, 5).map((r, i) => ({ text: r.text, ...(i === 1 ? { anchor: true } : {}) }))
  assert.deepEqual(windowRows(near, 3, 1).rows.map((r) => r.text), ["line 0", "line 1", "↓ 3 more"],
    "one hidden line is shown in place of `↑ 1 more`, so a provider row is not lost")
  assert.deepEqual(windowRows(rows.slice(0, 5).map((r, i) => ({ text: r.text, ...(i === 3 ? { anchor: true } : {}) })), 3, 3).rows.map((r) => r.text),
    ["↑ 3 more", "line 3", "line 4"], "and in place of `↓ 1 more`")

  // Many accounts, the focus deep in the list. One column: the body in 1, 2, 3, 10 and 80×24 lines.
  const snap = snapshot()
  snap.integrations[2].connections.push(...Array.from({ length: 12 }, (_, i) => ({ id: `ds-x${i}`, label: `Extra ${i}`, method: "key", active: false })))
  const cursor = refKey("deepseek", "ds-x9")
  const body = modalRows(snap, { now: T0 + 1, cursor, width: 72 })
  for (const height of [1, 2, 3, 10, 24 - 7 - 1]) {
    const fit = fitBody(body, height, 0).rows
    assert.ok(fit.length <= height, `${height} lines: ${fit.length}`)
    assert.ok(fit.some((row) => row.text.startsWith("┃○ Extra 9")), `${height} lines: the focused account is on screen`)
  }
  assert.deepEqual(fitBody(body, 1, 0).rows.map((r) => squeeze(r.text.trimEnd())), ["┃○ Extra 9 —"], "alias and figure on the one line")
  const tall = fitBody(body, 16, 0).rows.map((r) => r.text.trimEnd())
  assert.ok(tall.includes("┄".repeat(72)) && tall.includes("Usage         —"), "80×24: the detail still shows\n" + tall.join("\n"))
  assert.ok(tall.some((t) => /^↑ \d+ more$/.test(t)), "and the list says what is hidden")
  assert.equal(tall.includes("Accounts      /connect"), false, "the pointer to native management goes first")
  const editor = fitBody(modalRows(snap, { now: T0, minimum: startMinimum(snap), width: 72 }), 6, 0).rows.map((r) => r.text.trimEnd())
  assert.deepEqual(editor.slice(0, 3), ["Low-balance notice", "┃USD    off", " CNY    off"], "the open editor is the focus: it goes first, no rule above it")

  // Two panels: the list scrolls with its focus; the detail loses its end, never its heading nor the source of
  // experimental figures.
  const low = modalLayout(snap, { now: T0 + 1, cursor, columns: 120, rows: 14 })
  assert.equal(low.mode, "split")
  assert.ok(low.left.rows.length <= 7 && low.left.rows.some((row) => row.selected && row.text.startsWith("┃○ Extra 9")))
  assert.ok(low.left.rows.some((row) => /^↑ \d+ more$/.test(row.text)))
  const cut = text(modalLayout(codexOn(), { now: T0 + 1, cursor: refKey("openai", "oa-1"), columns: 120, rows: 12 }).right.rows)
  assert.equal(cut.length, 4, cut.join("\n"))
  assert.match(cut[0], /^◎ Work \[31m +Experimental$/)
  assert.equal(cut.at(-1), "Source        ChatGPT, not a public API", "kept to the last: experimental figures say they are not a public API")
  assert.equal(cut.some((row) => /^(Type|Accounts)/.test(row)), false, "cut from the end")
  assert.ok(cut.some((row) => /^5 h +█+░+ 42% used$/.test(row)))
})

test("clicks: each line of an account row selects it, a provider row its first account, a currency row its currency", () => {
  const snap = snapshot()
  const layout = modalLayout(snap, { now: T0 + 1, cursor: refKey("deepseek", "ds-1"), columns: 120 })
  const clicks = layout.left.rows.map((row) => row.click)
  assert.deepEqual(clicks.filter((click) => click?.kind === "account").map((click) => JSON.parse(click.ref)[1]), ["oa-1", "oa-2", "cl-1", "ds-1", "ds-2", "ds-3", "ds-4"])
  assert.equal(layout.left.rows.filter((row) => /^(Logins|API keys)/.test(row.text)).some((row) => row.click), false, "a section heading is not a target")
  assert.equal(layout.right.rows.some((row) => row.click), false, "the detail is not a target")
  assert.ok(layout.footer.every((line) => line.items.every((item) => item.action)), "every key in the footer is clickable")
  const editor = modalLayout(snap, { now: T0 + 1, minimum: { ...startMinimum(snap), currency: "CNY" }, columns: 120 })
  assert.deepEqual(editor.right.rows.filter((row) => row.click).map((row) => [row.click, !!row.selected]),
    [[{ kind: "currency", currency: "USD" }, false], [{ kind: "currency", currency: "CNY" }, true]])
  assert.equal(editor.left.rows.some((row) => row.selected), false, "no account cursor while the notice editor is open")
  assert.deepEqual(pickCurrency(startMinimum(snap), "CNY").currency, "CNY")
  assert.deepEqual(pickCurrency(startMinimum(snap), "EUR").currency, "USD", "only the notice's currencies")
})

test("T12 (view): an OpenAI OAuth login without a verifiable signal gets neutral rows; nothing experimental while the reader is off", () => {
  const snap = snapshot()
  const rows = modalRows(snap, { now: T0, cursor: refKey("openai", "oa-2") })
  assert.match(listOf(rows).find((row) => row.startsWith("┃")), /^┃○ \(no alias\) +—$/)
  assert.deepEqual(detailOf(rows), ["◎ (no alias)", "Usage         —", "Type          OAuth login"], "one fact per row")
  snap.integrations[0].connections = [{ id: "oa-2", label: "Personal", method: "oauth", active: true }]
  assert.equal(compactLine(snap, { providerID: "openai", modelID: "m" }), undefined, "no notice: nothing above the composer")
  for (const columns of [40, 80, 120]) {
    const all = screenText(modalLayout(snap, { now: T0, cursor: refKey("openai", "oa-2"), columns })).join("\n")
    assert.equal(/ChatGPT|Manage usage|Using|experimental|\bplan\b|Subscription/i.test(all), false, all)
  }
})

test("E06 (view): with the experimental reader on, every OAuth login says Experimental and not a public API; a refreshes them all", () => {
  const snap = codexOn()
  const active = detailOf(modalRows(snap, { now: T0 + 1, cursor: refKey("openai", "oa-1") }))
  assert.match(active[0], /^◎ Work \[31m +Experimental$/)
  assert.match(active[1], /^5 h +█+░+ 42% used$/)
  assert.match(active[3], /^Weekly +█+░+ 16% used$/)
  assert.ok(active.includes("Source        ChatGPT, not a public API"), active.join("\n"))
  const tones = modalRows(snap, { now: T0 + 1, cursor: refKey("openai", "oa-1") }).filter((row) => row.text.includes("█")).map((row) => row.parts[1].tone)
  assert.deepEqual(tones, ["success", "accent"], "5 h in the success role, the weekly window in the accent")
  const inactive = modalRows(snap, { now: T0 + 1, cursor: refKey("openai", "oa-2") })
  assert.match(detailOf(inactive)[0], /^◎ \(no alias\) +Experimental$/)
  assert.deepEqual(detailOf(inactive).slice(1), ["Usage         Press r to read", "Source        ChatGPT, not a public API",
    "Type          OAuth login"], "an inactive login can be read too")
  // Each account shows its own data: the inactive one has none even though the active one was read.
  assert.match(listOf(inactive).find((row) => row.startsWith("┃")), /—$/)
  snap.integrations[0].connections.push(
    { id: "oa-key", label: "Key", method: "key", active: false },
    { id: "oa-wait", label: "Wait", method: "oauth", active: false, reconnectRequired: true })
  assert.deepEqual(batchRefs(snap).map((r) => r.connectionID), ["oa-1", "oa-2"], "keys and logins waiting for a sign-in are left out")
  const key = detailOf(modalRows(snap, { now: T0 + 1, cursor: refKey("openai", "oa-key") }))
  assert.equal(/Experimental|ChatGPT|Press r/.test(key.join("\n")), false, "an API key is never offered to the Codex reader")
  assert.equal(detailOf(modalRows(snap, { now: T0 + 1, cursor: refKey("openai", "oa-wait") })).includes("Usage         —"), true, "waiting for a sign-in: no invitation to read")
  assert.equal(keysText(legend({ refreshAll: true })), "r Refresh   a Refresh all   o Route order")
  assert.equal(keysText(legend({})).includes("Refresh all"), false, "no a without the experimental reader")
  assert.deepEqual(batchRefs(snapshot()), [], "reader off: nothing to refresh")
  const denied = refreshRpcError({ response: { status: 403 }, message: "secret" })
  assert.equal(batchSummary(["read", "read", "read"]), "Refresh all: 3 read.")
  assert.equal(batchSummary(["failed"]), "Refresh all: 1 failed.")
  assert.equal(batchSummary(["read", "failed", "unsupported", "deferred", denied, denied]), "Refresh all: 1 read · 1 failed · 1 deferred · 1 unsupported · RPC: HTTP 403 (2).")
  assert.equal(refreshRpcError({ data: { type: "not_found" } }), "RPC: unknown account reference")
  assert.equal(refreshRpcError({ name: "sensitive-name", message: "secret" }), "RPC: refresh call failed")
  snap.integrations[0].connections[0].samples = undefined
  snap.integrations[0].connections[0].failure = { source: "codex-usage", at: T0, reason: "login" }
  const login = modalRows(snap, { now: T0 + 1, cursor: refKey("openai", "oa-1") })
  assert.match(listOf(login).find((row) => row.startsWith("┃")), / +Failed$/)
  assert.ok(detailOf(login).some((row) => /^Error {9}Not a verified Codex legacy login at /.test(row)), detailOf(login).join("\n"))
  assert.ok(detailOf(login).includes("Usage         —"))
  snap.integrations[0].connections[0].failure = { source: "codex-usage", at: T0, reason: "changed" }
  assert.ok(detailOf(modalRows(snap, { now: T0 + 1, cursor: refKey("openai", "oa-1") })).join(" ").replace(/ +/g, " ")
    .includes("The account changed during the read; data discarded at"))
})

test("Refresh all: a lone eligible Claude profile gets the same footer action even without Codex", () => {
  const snap = snapshot()
  const claude = { ...snap.integrations[1], passive: true, refreshable: true, manual: true }
  const [login] = claude.connections
  const withClaude = (changes) => ({ ...snap, integrations: [snap.integrations[0], { ...claude, ...changes }, snap.integrations[2],
    { ...claude, id: "anthropic" }] })
  const action = (view) => modalLayout(view).footer.flatMap((line) => line.items).find((item) => item.key === "a")
  const eligible = withClaude({})
  assert.deepEqual(batchRefs(eligible), [{ integrationID: "claude-agent", connectionID: "cl-1" }])
  assert.deepEqual(action(eligible), { key: "a", label: "Refresh all", action: "refreshAll" })
  for (const changes of [{ refreshable: false }, { manual: false }, { connections: [] }, { connections: [login, { ...login, id: "cl-2" }] },
    { connections: [{ ...login, reconnectRequired: true }] }, { connections: [{ ...login, method: "key" }] },
    { connections: [{ ...login, method: "oauth" }] }]) {
    const view = withClaude(changes)
    assert.deepEqual(batchRefs(view), [], JSON.stringify(changes))
    assert.equal(action(view), undefined)
  }
})

test("E02 (view): Claude without a provable source is —, never 0; an API key infers no plan", () => {
  const snap = snapshot()
  snap.integrations.push({ id: "anthropic", active: "connection", refreshable: false, connections: [{ id: "an-1", label: "API", method: "key", active: true }] })
  const claude = modalRows(snap, { now: T0, cursor: refKey("claude-agent", "cl-1") })
  assert.match(listOf(claude).find((row) => row.startsWith("┃")), /^┃● Claude +—$/)
  assert.match(detailOf(claude)[0], /^✻ Claude$/)
  assert.deepEqual(detailOf(claude).slice(1), ["Usage         —", "Type          External (unverified)"])
  assert.equal(text(claude).filter((line) => line.includes("In Claude Code")).length, 0, "no Limits row")
  assert.equal(compactLine(snap, { providerID: "claude-agent", modelID: "m" }), undefined)
  const key = modalRows(snap, { now: T0, cursor: refKey("anthropic", "an-1") })
  assert.match(listOf(key).find((row) => row.startsWith("┃")), /^┃● API +—$/)
  assert.ok(listOf(key).some((row) => row.startsWith("✻ Anthropic API")) && listOf(key).some((row) => row.startsWith("✻ Claude Code")))
  const all = [...detailOf(claude), ...detailOf(key)].join("\n")
  assert.equal(/%|5 h|Weekly|\bPro\b|\bMax\b|plan/.test(all), false, "no invented meters, plan or zero")
  assert.equal(detailOf(key).some((line) => line.includes("Claude Code")), false, "an API key is not a Claude Code profile")
})

test("synthetic screens at 40, 80, 100, 120 and 160 columns: one focus, esc once at the top right, nothing past the width (printed for review)", (t) => {
  const snap = snapshot()
  snap.preferences = { ...prefs, minimums: { USD: "0.20" } }
  snap.integrations[0] = { ...snap.integrations[0], refreshable: true, manual: true }
  snap.integrations[0].connections[0].label = "Personal"
  snap.integrations[0].connections[0].samples = [quota("5h", 42, { source: "codex-usage", resetsAt: T0 + 2 * HOUR }),
    quota("weekly", 16, { source: "codex-usage", resetsAt: T0 + 4 * 24 * HOUR })]
  snap.integrations[0].connections[1] = { id: "oa-2", label: "Secondary", method: "oauth", active: false, samples: [quota("5h", 100, { source: "codex-usage" }), quota("weekly", 76, { source: "codex-usage" })] }
  snap.integrations[2].connections[0].samples[0].balances = [{ currency: "USD", total: "0.31" }, { currency: "CNY", total: "2.00" }]
  const cursor = refKey("openai", "oa-1")
  for (const [columns, lines] of [[160, 40], [120, 40], [100, 30], [80, 24], [40, 24], [120, 14], [80, 9]]) {
    const layout = modalLayout(snap, { now: T0 + 60_000, cursor, columns, rows: lines })
    const screen = screenText(layout)
    t.diagnostic(`${columns}×${lines} (${layout.mode})\n` + screen.map((line) => `| ${line.padEnd(layout.width)} |`).join("\n"))
    assert.equal(layout.mode, modalWidth(columns) >= 84 ? "split" : "stacked")
    assert.ok(screen.length <= lines - 3, `${columns}×${lines}: ${screen.length} lines`)
    for (const line of screen) assert.ok(line.length <= layout.width, `${columns}: ${line}`)
    assert.equal(screen.filter((line) => /┃[●○]/.test(line)).length, 1, "one focus mark")
    assert.ok(screen.some((line) => /┃● Personal/.test(line)), "the focused account is on screen")
    assert.match(screen[0], /^Accounts +esc$/)
    assert.equal(screen.filter((line) => /\besc\b/i.test(line)).length, 1, "esc is named once, at the top")
    assert.deepEqual([screen[1], screen.at(-1 - layout.footer.length)], ["─".repeat(layout.width), "─".repeat(layout.width)], "a rule under the title and over the keys")
    const words = screen.map((line) => line.replace(/^.*│ /, "").trim()).join(" ")
    if (screen.some((line) => /[█░]/.test(line))) {
      assert.ok(/Experimental/.test(words) && /not a public API/.test(words), `${columns}×${lines}: experimental figures say so even when the detail is cut`)
    }
    assert.ok(words.split("not a public API").length <= 2, "the source once, never per row")
  }
  const wide = screenText(modalLayout(snap, { now: T0 + 60_000, cursor, columns: 120, rows: 40 }))
  assert.ok(wide.some((line) => /^ ○ Second[^ ]* +5 h {2}100% used {2}│/.test(line)), "one inset cell before the panel divider")
  assert.equal(wide.filter((line) => /Notice at/.test(line)).length, 0, "the DeepSeek notice is read in its own detail, not here")
})

test("composer line: nothing without a notice; with one, the account, what crossed, what to do and where; sessionRef", () => {
  const sel = (providerID) => ({ providerID, modelID: "m" })
  for (const id of ["openai", "deepseek", "claude-agent", "google"]) assert.equal(compactLine(snapshot(), sel(id)), undefined, id)
  const notice = (result) => ({ result, integrationID: "openai", selection: sel("openai") })
  const crossed = { kind: "none", reason: "Independent quota not proven", trigger: { text: "5 h: 100% used" } }
  assert.equal(compactLine(snapshot(), sel("openai"), notice(crossed)), "Work [31m · 5 h: 100% used · No confirmed alternative · /quota")
  assert.deepEqual(compactParts(snapshot(), sel("openai"), notice(crossed)).map((part) => part.tone), ["muted", "warning", "muted"],
    "what crossed in the warning tone, the rest dimmed")
  // The modal opens on the account in use for the session's model.
  assert.equal(sessionRef(snapshot(), sel("deepseek")), refKey("deepseek", "ds-1"))
  assert.equal(sessionRef(snapshot(), sel("claude-agent")), refKey("claude-agent", "cl-1"))
  assert.equal(sessionRef(snapshot(), sel("google")), undefined)
  assert.equal(sessionRef(snapshot(), undefined), undefined)
  const none = snapshot()
  none.integrations[2].connections[0].active = false
  assert.equal(sessionRef(none, sel("deepseek")), undefined, "no account in use: the cursor stays where it was")
  assert.ok(accountRefs(snapshot()).includes(sessionRef(snapshot(), sel("openai"))))
})

test("turn evaluation uses only the held snapshot; this inventory proves no independent holder", () => {
  const result = decide(snapshot(), { providerID: "openai", modelID: "m" }, T0 + 1)
  assert.deepEqual([result.kind, result.reason, result.trigger.text], ["none", "Independent quota not proven", "5 h: 100% used"])
  assert.deepEqual(staleRefs(snapshot(), T0 + 1), [{ integrationID: "deepseek", connectionID: "ds-4" }],
    "fresh, reconnect-required and backing-off accounts are not read on open")
})

test("T10 (view): the modal edits no account order: the list shows the saved (legacy) order and a preferences save keeps it whole", () => {
  const snap = snapshot()
  // The server already lists each integration's accounts in the saved order; the modal shows it as it is.
  snap.integrations[2].connections = [3, 0, 2, 1].map((i) => snap.integrations[2].connections[i])
  const layout = modalLayout(snap, { cursor: refKey("deepseek", "ds-4"), now: T0, columns: 120 })
  const list = text(layout.left.rows)
  assert.deepEqual(list.slice(list.indexOf("◆ DeepSeek")).map(squeeze), ["◆ DeepSeek", "┃○ Fourth —", " ● Main USD 8.42 · CNY 0.10", " ○ Spare Failed", " ○ Backup Sign in again"])
  assert.equal(list.some((line) => /Priorities/.test(line)), false, "no priorities editor heading")
  assert.equal(screenText(layout).some((line) => /Priorities|↑↓|p Priorit/.test(line)), false, "no p key, no ↑↓ legend")
  assert.deepEqual(accountRefs(snap).slice(-4), ["ds-4", "ds-1", "ds-3", "ds-2"].map((id) => refKey("deepseek", id)), "↑↓ walk the saved order")
  // The threshold and the notice minimums are the preferences the modal still saves: the stored order travels with
  // them unchanged, with the preferences' own revision.
  const order = { openai: ["oa-1", "oa-2"], "claude-agent": ["cl-1"], deepseek: ["ds-4", "ds-1", "ds-3", "ds-2"] }
  assert.deepEqual(proposalFrom(snap, { revision: 3, threshold: 90 }), { revision: 3, threshold: 90, minimums: {}, order })
  assert.deepEqual(proposalFrom(snap, { ...startMinimum(snap), minimums: { USD: "1" } }), { revision: 3, threshold: 95, minimums: { USD: "1" }, order })
  assert.deepEqual(alertRows(snap, { message: "Low-balance notice saved." }, 72), [{ text: "Low-balance notice saved.", tone: "warning" }], "the message sits over the keys")
})

test("T10 (view): DeepSeek low-balance notice: one minimum per currency, in the DeepSeek detail, edited locally, off is not 0", () => {
  const snap = snapshot()
  snap.preferences = { ...prefs, minimums: { USD: "0.20" } }
  const rows = text(modalRows(snap, { now: T0, cursor: refKey("deepseek", "ds-1") }))
  assert.equal(rows.filter((row) => row.includes("Notice at")).length, 1, "one policy, not one per account")
  assert.deepEqual(detailOf(modalRows(snap, { now: T0, cursor: refKey("deepseek", "ds-1") })).slice(1),
     ["Balance       USD 8.42", "              CNY 0.10", "Updated       just now", "Notice at     USD 0.20 · CNY off", "Type          API key"])
  assert.equal(text(modalRows(snap, { now: T0, cursor: refKey("openai", "oa-1") })).some((row) => row.includes("Notice at")), false, "only with a DeepSeek account")
  assert.ok(rows.some((row) => /Main +USD 8\.42 · CNY 0\.10$/.test(row)), "currency and balance shown with no notice")
  assert.equal(minimumText({}), "USD off · CNY off")
  assert.equal(minimumText({ CNY: "0" }), "USD off · CNY 0", "0 is a minimum, absent is off")
  assert.ok(text(modalRows({ ...snap, preferences: { state: "unsupported" } }, { cursor: refKey("deepseek", "ds-1") })).includes("Notice at     Unavailable"))
  assert.equal(keysText(legend({ deepseek: true })), "r Refresh   o Route order   m Balance notice")

  const draft = startMinimum(snap)
  assert.deepEqual(draft, { revision: 3, minimums: { USD: "0.20" }, currency: "USD" })
  assert.equal(startMinimum({ ...snap, preferences: { state: "unsupported" } }), undefined, "unknown format: not editable")
  assert.equal(startMinimum({ ...snap, integrations: snap.integrations.slice(0, 2) }), undefined, "no DeepSeek account")
  for (const bad of ["1,5", "1e3", ".5", "5.", "-1", "-0", "+1", "01", "0x1", "1 000", "Infinity", "NaN", "0.2.0", "", "  ", 0.2, undefined]) {
    assert.equal(setAmount(draft, bad), undefined, String(bad))
  }
  assert.deepEqual(setAmount(draft, " 0.30 ").minimums, { USD: "0.30" }, "exact text, trimmed")
  assert.deepEqual(setAmount(draft, "0").minimums, { USD: "0" })
  assert.deepEqual(setAmount(draft, "1.1000000001").minimums, { USD: "1.1000000001" }, "no float rounding")
  const cny = setAmount(shiftCurrency(draft, 1), "12.5")
  assert.deepEqual([cny.currency, cny.minimums], ["CNY", { USD: "0.20", CNY: "12.5" }], "the other currency is kept")
  assert.equal(shiftCurrency(cny, 1).currency, "CNY")
  const usdOff = turnOff(shiftCurrency(cny, -1))
  assert.deepEqual(usdOff.minimums, { CNY: "12.5" }, "off removes only that currency")
  assert.deepEqual(draft.minimums, { USD: "0.20" }, "the draft is local until Save")

  const editingRows = modalRows(snap, { now: T0, cursor: refKey("deepseek", "ds-1"), minimum: usdOff, width: 74 })
  const lines = detailOf(editingRows)
  assert.deepEqual(lines.slice(0, 3), ["Low-balance notice", "┃USD    off", " CNY    12.5"])
  const note = lines.slice(3).join(" ").replace(/\s+/g, " ")
  for (const words of ["Informational only, not a spending limit", "when a turn ends", "active DeepSeek account", "fresh balance",
    "at or below", "same currency", "Usage is never blocked", "accounts are never switched", "esc discards changes."]) assert.ok(note.includes(words), words)
  assert.ok(editingRows.filter((row) => row.anchor).every((row) => row.zone === "detail"), "the open editor, not an account, is what stays on screen")
  assert.equal(listOf(editingRows).some((row) => row.startsWith("┃")), false, "no account cursor while the minimum is edited")
  assert.ok(listOf(editingRows).some((row) => /^ ● Main +USD/.test(row)))
  assert.equal(editingRows.find((row) => row.selected)?.text.trimEnd(), "┃USD    off", "the current currency has the focus band")
  assert.equal(keysText(legend({ minimum: usdOff, deepseek: true })), "e Edit amount   o Off   s Save", "↑↓ still change the currency; the footer does not spell it")
  assert.deepEqual(proposalFrom(snap, usdOff), {
    revision: 3, threshold: 95, minimums: { CNY: "12.5" },
    order: { openai: ["oa-1", "oa-2"], "claude-agent": ["cl-1"], deepseek: ["ds-1", "ds-2", "ds-3", "ds-4"] },
  }, "complete proposal: order and threshold preserved, read revision")
})

test("keys: every key the footer shows runs the footer's own action in that mode; a save conflict is recognised one way", () => {
  for (const mode of [{ refreshAll: true, deepseek: true, notice: true }, { minimum: {} }, { route: { targets: [{}] } }]) {
    for (const { key, action } of legend(mode)) {
      const bind = key === "Enter" ? "return" : key
      assert.equal(keyAction(bind, mode), action, `${JSON.stringify(mode)} ${key}`)
    }
  }
  const route = { route: { targets: [{}] } }
  for (const bind of ["r", "m", "x", "e"]) assert.equal(keyAction(bind, route), undefined, `${bind} does nothing in the route editor`)
  assert.equal(keyAction("r", { minimum: {} }), "refresh", "the notice editor falls back to the list's keys")
  assert.deepEqual([keyAction("z"), keyAction("constructor", route)], [undefined, undefined], "an unknown key runs nothing")
  for (const error of [{ type: "conflict" }, { data: { type: "conflict" } }, { message: "Preferences changed. Reload before saving." },
    { message: "Route order changed. Reload before saving." }]) assert.equal(conflicted(error), true, JSON.stringify(error))
  for (const error of [{ type: "invalid" }, undefined]) assert.equal(conflicted(error), false, JSON.stringify(error))
})

test("E02 (view): a failed /usage read leaves Claude's turn figures standing; a failure of their own source does not", () => {
  const now = T0 + 20_000
  const sel = { providerID: "claude-agent", modelID: "sonnet" }
  const cursor = refKey("claude-agent", "cl-1")
  const snap = (source) => ({ schema: 2, revision: 9, scope: "personal-server", inventory: "available", usageFreshnessSeconds: 150, preferences: prefs,
    integrations: [{ id: "claude-agent", active: "connection", refreshable: true, manual: true, passive: true, connections: [{ id: "cl-1", label: "Claude",
      method: "external", active: true, failure: { source, at: T0 + 10_000, reason: "timeout", retryAt: T0 + 25_000 },
      samples: [quota("5h", 97, { source: "claude-turns", resetsAt: T0 + HOUR }), quota("weekly", 30, { source: "claude-turns", resetsAt: T0 + 48 * HOUR })] }] }] })
  const rows = (source) => modalRows(snap(source), { now, cursor, selection: sel, width: 84 })
  const usage = rows("claude-usage")
  assert.match(listOf(usage).find((row) => row.startsWith("┃")), /5 h {2}97% used/, "not Failed")
  assert.equal(usage.some((row) => row.measure && row.text.includes("Refresh failed")), false)
  assert.ok(detailOf(usage).some((line) => /^Error\b.*timed out/i.test(line)), detailOf(usage).join("\n"))
  const turns = rows("claude-turns")
  assert.match(listOf(turns).find((row) => row.startsWith("┃")), /Failed/)
  assert.ok(turns.some((row) => row.measure && row.text.includes("Refresh failed")))
})

test("T08 (view): a turn end is evaluated with the snapshot read after it; a later reload never raises the notice", () => {
  const sel = { providerID: "claude-agent", modelID: "sonnet" }
  const now = T0 + 4 * 60_000
  const snap = (used, observedAt) => ({ schema: 2, revision: 9, scope: "personal-server", inventory: "available", usageFreshnessSeconds: 150, preferences: prefs,
    integrations: [{ id: "claude-agent", active: "connection", refreshable: true, manual: true, passive: true, connections: [{ id: "cl-1", label: "Claude",
      method: "external", active: true, samples: [quota("5h", used, { source: "claude-turns", observedAt }), quota("weekly", 10, { source: "claude-turns", observedAt })] }] }] })
  const context = (held) => ({ sessionID: "ses-1", selection: sel, account: (s) => activeAccount(held, s), evaluate: (s) => decide(held, s, now) })
  const end = { id: "end-1", type: "session.execution.succeeded", data: { sessionID: "ses-1" } }
  const [held, reloaded] = [snap(90, T0), snap(97, now)]
  const before = createAdvisor()
  assert.equal(before.turnEnded(end, context(held)), false, "the held figure is 4 min old: stale, no notice")
  before.observe(context(reloaded))
  assert.equal(before.current(context(reloaded)), undefined, "the reload that arrives afterwards raises nothing")
  const after = createAdvisor()
  assert.equal(after.turnEnded(end, context(reloaded)), true, "read first, then evaluated: the turn's 97 % notifies")
  assert.equal(after.current(context(reloaded)).result.trigger.text, "5 h: 97% used")
})

test("T08/T13 (view): the low-balance notice follows the snapshot the TUI holds, not the invalidation counter", () => {
  const advisor = createAdvisor()
  const sel = { providerID: "deepseek", modelID: "deepseek-chat" }
  const held = (total, observedAt = T0, revision = 9) => {
    const snap = snapshot()
    snap.revision = revision
    snap.preferences = { ...prefs, minimums: { USD: "0.20" } }
    snap.integrations[2].connections[0].samples = [{ source: "deepseek-balance", window: "balance", scope: "general", observedAt, available: true, balances: [{ currency: "USD", total }] }]
    return snap
  }
  const view = (snap, now) => ({ account: (s) => activeAccount(snap, s), evaluate: (s) => decide(snap, s, now) })
  const context = (snap, now) => ({ sessionID: "ses-1", selection: sel, ...view(snap, now) })
  const turn = (snap, now, id) => advisor.turnEnded({ id, type: "session.execution.succeeded", data: { sessionID: "ses-1" } }, context(snap, now))
  const line = (snap, now) => compactLine(snap, sel, advisor.current(context(snap, now)) && { ...advisor.current(context(snap, now)), integrationID: "deepseek" })

  assert.equal(turn(held("0.21"), T0 + 1, "a"), false, "USD 0.21 does not notify")
  assert.equal(turn(held("0.20"), T0 + 1, "b"), true, "USD 0.20 does")
  assert.equal(line(held("0.20"), T0 + 2), "Main · Low balance: USD 0.20 · No confirmed alternative · /quota")
  const shown = advisor.current(context(held("0.20"), T0 + 2))
  const [first] = alertRows(held("0.20"), { notice: { ...shown, integrationID: "deepseek" } }, 84)
  assert.deepEqual([first.text, first.tone], ["Low balance: USD 0.20. No confirmed alternative: Reconnect required", "warning"],
    "the notice sits over the keys, with the first skipped account's reason")
  const layout = modalLayout(held("0.20"), { now: T0 + 2, cursor: refKey("deepseek", "ds-1"), columns: 120, notice: { ...shown, integrationID: "deepseek" } })
  assert.deepEqual([text(layout.alerts), keysText(layout.footer.flatMap((l) => l.items)).includes("x Dismiss")],
    [["Low balance: USD 0.20. No confirmed alternative: Reconnect required"], true], "with a notice the keys offer x Dismiss")
  assert.equal(nextExpiry(held("0.20"), T0 + 2), T0 + 120_000, "the clock revalidates at the sample's TTL")
  const bumped = held("0.20", T0, 10)
  advisor.observe(view(bumped, T0 + 3))
  assert.ok(advisor.current(context(bumped, T0 + 3)), "only the invalidation counter moved: still shown")
  const topped = held("0.21", T0 + 60_000, 11)
  advisor.observe(view(bumped, T0 + 60_000))
  advisor.observe(view(topped, T0 + 60_000))
  assert.equal(line(topped, T0 + 60_001), undefined, "a fresh 0.21 withdraws it at once, and the line with it")
  const low = held("0.20", T0 + 61_000)
  assert.equal(turn(low, T0 + 61_000, "c"), true, "recovered, so crossing again notifies at a turn end")
  assert.equal(line(low, T0 + 181_000), undefined, "withdrawn at the TTL")
  assert.equal(line(held("0.20", T0 + 182_000), T0 + 182_000), undefined, "a refresh does not raise it")
  const moved = held("0.20", T0 + 190_000)
  assert.equal(turn(moved, T0 + 190_000, "d"), true)
  moved.integrations[2].connections[0].active = false
  moved.integrations[2].connections[3].active = true
  advisor.observe(view(moved, T0 + 191_000))
  assert.equal(advisor.current(context(moved, T0 + 191_000)), undefined, "native switch to another account ends it")
})
