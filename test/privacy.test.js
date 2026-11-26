// T16 (B07, FIXTURE): synthetic markers in credentials, native metadata, event payloads, history and response
// bodies never reach console output, RPC answers, events or storage. Only preferences persist; measurements are
// gone after a reload; no activation method and no process launch exist in the runtime files.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { createDeepseekReader } from "../deepseek.js"
import { createPlugin } from "../server.js"
import { call, contract, fakeHost, settle } from "./host.js"

const MARK = "SYNTHETIC-MARK-T16"
const runtime = ["index.js", "rpc.js", "tui.tsx", "inventory.js", "server.js", "sync.js", "view.js", "rules.js", "preferences.js", "routing.js", "deepseek.js", "codex.js", "claude.js"]

test("T16: markers stay out of logs, RPC, events and storage; only preferences persist", async () => {
  const printed = []
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug }
  for (const name of Object.keys(saved)) console[name] = (...args) => printed.push(args.map(String).join(" "))
  const requests = []
  try {
    const storage = new Map()
    const host = fakeHost({
      storage,
      integrations: [{
        id: "deepseek",
        connections: [
          { type: "credential", id: "ds-1", label: "Main", method: "key", key: MARK, metadata: { history: MARK } },
          { type: "credential", id: "ds-2", label: "Backup", method: "key", status: { status: "needs_auth", message: MARK } },
          { type: "credential", id: "ds-3", label: "Spare", method: "key" },
        ],
      }],
      active: { deepseek: { type: "credential", id: "ds-1", key: MARK } },
      credentials: { "ds-1": { type: "key", key: `${MARK}-key-1` }, "ds-2": { type: "key", key: `${MARK}-key-2` }, "ds-3": { type: "key", key: `${MARK}-key-3` } },
    })
    const send = async (url, init) => {
      requests.push(url)
      if (init.headers.Authorization.endsWith("-2")) return new Response(`{"error":"${MARK}"}`, { status: 401 })
      if (init.headers.Authorization.endsWith("-3")) return new Response(`<html>${MARK}</html>`, { status: 200 })
      return new Response(JSON.stringify({ is_available: true, note: MARK, balance_infos: [{ currency: "USD", total_balance: "3.00", extra: MARK }] }), { status: 200, headers: { "x-trace": MARK } })
    }
    const plugin = createPlugin({ contract, readers: { deepseek: createDeepseekReader({ send }) } })
    const stop = await plugin.setup(host.ctx)
    assert.deepEqual(Object.keys(host.handlers).sort(), ["refresh", "routingView", "savePreferences", "saveRouting", "setSessionRouting", "snapshot"],
      "no activate method, no model switch method")
    const answers = [await host.handlers.snapshot({}, call())]
    assert.equal(requests.length, 0, "no provider read at startup or on a snapshot")
    host.events.push({ type: "credential.updated", data: { credentialID: "ds-1", key: MARK } })
    for (const id of ["ds-1", "ds-2", "ds-3"]) answers.push(await host.handlers.refresh({ integrationID: "deepseek", connectionID: id }, call()))
    answers.push(await host.handlers.refresh({ integrationID: "deepseek", connectionID: MARK }, call()))
    answers.push(await host.handlers.savePreferences({ revision: 0, threshold: 95, minimums: { USD: "1.00" }, order: { deepseek: ["ds-3", "ds-1"] } }, call()))
    answers.push(await host.handlers.savePreferences({ revision: 0, threshold: 95, minimums: {}, order: { deepseek: [MARK] } }, call()))
    await settle()
    const snapshot = await host.handlers.snapshot({}, call())
    answers.push(snapshot)
    assert.deepEqual(snapshot.integrations[0].connections.map((c) => [c.id, c.samples?.[0]?.balances, c.failure?.reason]),
      [["ds-3", undefined, "invalid"], ["ds-1", [{ currency: "USD", total: "3.00" }], undefined], ["ds-2", undefined, "auth"]])
    const everything = JSON.stringify({ answers, emitted: host.record.emitted, storage: [...storage], printed })
    assert.equal(everything.includes(MARK), false)
    assert.deepEqual([...storage.keys()], ["preferences"])
    assert.deepEqual(storage.get("preferences"), { schema: 1, revision: 1, mode: "recommend", threshold: 95, order: { deepseek: ["ds-3", "ds-1"] }, minimums: { USD: "1.00" } })
    await stop()

    const again = await plugin.setup(host.ctx)
    const reloaded = await host.handlers.snapshot({}, call())
    assert.equal(reloaded.integrations[0].connections.some((c) => c.samples || c.failure), false, "measurements vanish on reload")
    assert.deepEqual(reloaded.integrations[0].connections.map((c) => c.id), ["ds-3", "ds-1", "ds-2"], "preferences persist")
    await again()
  } finally {
    Object.assign(console, saved)
  }
})

test("T16: runtime files never activate accounts, spawn processes, send prompts or log", () => {
  // The one exception is the TUI's own text-entry dialog (`context.ui.dialog.prompt`, S08) for the DeepSeek
  // notice amount: local input, not a message to a model. Any other `.prompt(` still fails.
  const dialog = "context.ui.dialog.prompt("
  // The one process: claude.js may import spawn once and call it once, with the fixed `/usage` arguments (E02 manual
  // reader, explicit refresh only). No other runtime file launches anything.
  const launcher = 'import { spawn } from "node:child_process"\n'
  const call = "launch(bin, [...USAGE_ARGS], "
  const args = 'export const USAGE_ARGS = Object.freeze(["-p", "/usage", "--output-format", "stream-json", "--verbose", "--setting-sources", "",\n' +
    '  "--strict-mcp-config", "--tools", "", "--no-session-persistence"])'
  for (const file of runtime) {
    const raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    assert.equal(raw.split(dialog).length - 1, file === "tui.tsx" ? 1 : 0, `${file}: text-entry dialogs`)
    const own = file === "claude.js" ? 1 : 0
    for (const fixed of [launcher, call, args]) assert.equal(raw.split(fixed).length - 1, own, `${file}: the /usage launch`)
    assert.equal((raw.match(/\blaunch\(/g) ?? []).length, own, `${file}: one launch call`)
    assert.equal((raw.match(/launch = spawn\b/g) ?? []).length, own, `${file}: spawn only as the launcher's default`)
    const source = raw.replaceAll(dialog, "").replace(launcher, "").replace("launch = spawn", "")
    for (const forbidden of [/\.activate\(/, /child_process|spawn\(|Bun\.spawn|exec\(/, /switchModel|\.variant\.set\(|\.prompt\(/, /console\./]) {
      assert.equal(forbidden.test(source), false, `${file}: ${forbidden}`)
    }
  }
  const network = runtime.filter((file) => /fetch\(|WebSocket|node:(http|https|net|tls|dgram)/.test(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")))
  // Only the two adapters reach the network: DeepSeek (B06) and the experimental, off-by-default Codex reader (E06).
  assert.deepEqual(network, ["deepseek.js", "codex.js"], "only the provider adapters may reach the network")
  const destinations = (file) => [...new Set(readFileSync(new URL(`../${file}`, import.meta.url), "utf8").match(/https:\/\/[^\s"'`]+/g))]
  assert.deepEqual(network.map(destinations), [["https://api.deepseek.com/user/balance"], ["https://chatgpt.com/backend-api/wham/usage"]],
    "each adapter has one fixed destination")
})
