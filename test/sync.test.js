// B02.4 client ordering (FIXTURE support for T04): an older read never replaces a newer state.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createDedupe, createLoader } from "../sync.js"

function harness() {
  const pending = []
  const applied = []
  const failed = []
  const loader = createLoader({
    read: (target) => new Promise((resolve, reject) => pending.push({ target, resolve, reject })),
    apply: (value) => applied.push(value),
    fail: (error) => failed.push(error.message),
  })
  return { loader, pending, applied, failed }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test("an invalidation during a read discards that read and applies only the later one", async () => {
  const { loader, pending, applied } = harness()
  const done = loader.invalidate({ directory: "/a" })
  assert.equal(pending.length, 1)
  loader.invalidate()
  pending[0].resolve("old")
  await tick()
  assert.deepEqual(applied, [])
  assert.equal(pending.length, 2, "one more read, not one per event")
  pending[1].resolve("new")
  await done
  assert.deepEqual(applied, ["new"])
})

test("a location change during a read sends the next read to the new location only", async () => {
  const { loader, pending, applied } = harness()
  loader.invalidate({ directory: "/a" })
  const done = loader.invalidate({ directory: "/b" })
  pending[0].resolve("from a")
  await tick()
  assert.deepEqual(pending[1].target, { directory: "/b" })
  pending[1].resolve("from b")
  await done
  assert.deepEqual(applied, ["from b"])
})

test("events before any open are ignored; failures surface only when not superseded", async () => {
  const { loader, pending, failed, applied } = harness()
  await loader.invalidate()
  assert.equal(pending.length, 0)
  const done = loader.invalidate({ directory: "/a" })
  loader.invalidate()
  pending[0].reject(new Error("lost"))
  await tick()
  pending[1].reject(new Error("down"))
  await done
  assert.deepEqual([failed, applied], [["down"], []])
  const again = loader.invalidate()
  pending[2].resolve("back")
  await again
  assert.deepEqual(applied, ["back"])
})

test("one `changed` per revision: copies from every location reload once; no revision, or a lower one, always reloads", () => {
  const first = createDedupe()
  assert.deepEqual([7, 7, 7].map(first), [true, false, false], "three locations, one change")
  assert.equal(first(8), true)
  assert.deepEqual([undefined, undefined].map(first), [true, true], "never lose a notice without a revision")
  assert.deepEqual([8, 2].map(first), [true, true], "a restarted server counts again from a lower revision")
  const other = createDedupe()
  assert.deepEqual([first(9), other(9)], [true, true], "each subscription has its own memory")
})
