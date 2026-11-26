// T03 (B02, FIXTURE): pure inventory projection with synthetic native reads only.
import assert from "node:assert/strict"
import { test } from "node:test"
import { inventorySnapshot } from "../inventory.js"

const MARK = "SYNTHETIC-MARKED-CREDENTIAL-T03"
const UNAVAILABLE = { schema: 1, revision: 0, inventory: "unavailable", integrations: [] }
const available = (integrations) => ({ schema: 1, revision: 0, inventory: "available", integrations })

// Native reads of one server as S07 shapes them, plus raw values a careless caller could forward.
const inventory = () => [
  {
    integrationID: "openai",
    active: { type: "credential", id: "oa-1", access: MARK },
    connections: [
      { type: "credential", id: "oa-1", label: "Work", method: "oauth", access: MARK, refresh: MARK, metadata: { accountID: MARK } },
      { type: "credential", id: "oa-2", label: "Work", method: "oauth", value: { access: MARK } },
    ],
  },
  {
    integrationID: "deepseek",
    active: { type: "env", id: "ds-1", key: MARK },
    connections: [
      { type: "credential", id: "ds-1", label: "Main", method: "key", key: MARK },
      { type: "credential", id: "ds-2", label: "Backup", method: "key", key: MARK },
      { type: "credential", id: "ds-9", label: "Main", method: "key", key: MARK, authorized: true, project: "current" },
    ],
  },
  { integrationID: "anthropic", active: { type: "env", key: MARK }, connections: [] },
  {
    integrationID: "claude-agent",
    active: { type: "credential", id: "cl-1" },
    connections: [
      { type: "credential", id: "cl-1", label: "Claude Code login", method: "external", methodID: "claude-login", configDir: MARK },
    ],
  },
]

test("without an inventory read the snapshot is unavailable", () => {
  for (const notAList of [undefined, null, "openai:oa-1", { connections: inventory() }]) {
    assert.deepEqual(inventorySnapshot(notAList), UNAVAILABLE)
  }
})

test("an empty inventory read is an available, empty inventory, not unavailable", () => {
  assert.deepEqual(inventorySnapshot([]), available([]))
})

test("an environment-only integration has an active access method, not a saved account; without it, it is not listed", () => {
  const anthropic = inventory().find((read) => read.integrationID === "anthropic")
  assert.deepEqual(inventorySnapshot([anthropic]), available([{ id: "anthropic", active: "environment", connections: [] }]))
  assert.deepEqual(inventorySnapshot([{ ...anthropic, active: null }]), available([]))
})

test("T03: saved, environment, ambiguous external, repeated alias and two unproven keys stay separate", () => {
  const snapshot = inventorySnapshot(inventory())
  // Exact DTO: nothing merged by label, no holder/quota/eligibility fields, env and external are not presented as accounts.
  assert.deepEqual(
    snapshot,
    available([
      {
        id: "openai",
        active: "connection",
        connections: [
          { id: "oa-1", label: "Work", method: "oauth", active: true },
          { id: "oa-2", label: "Work", method: "oauth", active: false },
        ],
      },
      {
        id: "deepseek",
        active: "environment",
        connections: [
          { id: "ds-1", label: "Main", method: "key", active: false },
          { id: "ds-2", label: "Backup", method: "key", active: false },
          { id: "ds-9", label: "Main", method: "key", active: false },
        ],
      },
      { id: "anthropic", active: "environment", connections: [] },
      {
        id: "claude-agent",
        active: "connection",
        connections: [{ id: "cl-1", label: "Claude Code login", method: "external", active: true }],
      },
    ]),
  )
  assert.equal(JSON.stringify(snapshot).includes(MARK), false)
})

test("ambiguous or malformed native reads are dropped without throwing or echoing raw values", () => {
  const rows = [
    {
      integrationID: "openai",
      active: { type: "credential", id: "dup", label: "Work" },
      connections: [
        { type: "credential", id: "oa-1", label: "Work", method: "oauth" },
        { type: "credential", id: "dup", label: "Work", method: "oauth" },
        { type: "credential", id: "dup", label: "Old", method: "oauth" },
      ],
    },
    { integrationID: "deepseek", active: null, connections: [{ type: "credential", id: "ds-1", label: "Main", method: "key" }] },
    {
      integrationID: "deepseek",
      active: { type: "credential", id: "ds-1" },
      connections: [{ type: "credential", id: "ds-1", label: "Main", method: "key" }],
    },
    {
      integrationID: "anthropic",
      active: MARK,
      connections: [
        null,
        MARK,
        { type: "credential", id: { value: MARK }, label: "Key", method: "key" },
        { type: "credential", id: "an-1", label: { value: MARK }, method: "key" },
        { type: "credential", id: "an-2", label: "Key", method: MARK },
        { type: MARK, id: "an-3", label: "Key", method: "key" },
        { type: "credential", id: "an-4", label: "Key", method: "key", key: MARK },
        { type: "credential", id: "x".repeat(201), label: "Key", method: "key" },
      ],
    },
    null,
    MARK,
    { integrationID: { value: MARK }, connections: [] },
  ]
  const snapshot = inventorySnapshot(rows)
  assert.deepEqual(
    snapshot,
    available([
      { id: "openai", active: "unknown", connections: [{ id: "oa-1", label: "Work", method: "oauth", active: false }] },
      { id: "anthropic", active: "unknown", connections: [{ id: "an-4", label: "Key", method: "key", active: false }] },
    ]),
  )
  assert.equal(JSON.stringify(snapshot).includes(MARK), false)
})
