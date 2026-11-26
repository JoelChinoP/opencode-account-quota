// In-memory stand-in for the parts of the OpenCode 2.3.2/2.4.1 server context used by server.js. Shapes follow
// S07/S15/S26: integration.list() -> { data: Info[] }, connection.active/resolve, provider.get() -> { data: Info },
// rpc.register, event.subscribe({ types }) (each subscription gets every pushed event of its types).
export const contract = { id: "account-quota", methods: {}, events: {} }

export function channel() {
  const queue = []
  const waiters = []
  return {
    push(value) {
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else queue.push(value)
    },
    iterable(signal) {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            queue.length > 0
              ? Promise.resolve({ value: queue.shift(), done: false })
              : new Promise((resolve) => {
                  waiters.push(resolve)
                  signal?.addEventListener("abort", () => resolve({ value: undefined, done: true }))
                }),
        }),
      }
    },
  }
}

// Fan-out of pushed events to the subscriptions that asked for their type.
function hub() {
  const subscribers = new Set()
  return {
    push(value) {
      for (const subscriber of subscribers) if (!subscriber.types || subscriber.types.includes(value?.type)) subscriber.channel.push(value)
    },
    iterable(types, signal) {
      const entry = { types, channel: channel() }
      subscribers.add(entry)
      signal?.addEventListener("abort", () => subscribers.delete(entry))
      return entry.channel.iterable(signal)
    },
  }
}

export function fakeHost({ integrations = [], active = {}, credentials = {}, storage = new Map(), providers = {}, sessions = {} } = {}) {
  const events = hub()
  const record = { resolved: [], emitted: [], lists: 0, subscribed: [], providers: [], sessions: [] }
  let handlers
  const host = {
    integrations,
    active,
    providers,
    sessions,
    record,
    events,
    storage,
    get handlers() {
      return handlers
    },
    ctx: {
      integration: {
        list: async () => {
          record.lists += 1
          if (host.failList) throw new Error("offline")
          return { data: structuredClone(host.integrations) }
        },
        connection: {
          active: async (id) => structuredClone(host.active[id]),
          resolve: async (row) => {
            record.resolved.push(row.id)
            return structuredClone(credentials[row.id])
          },
        },
      },
      provider: {
        get: async (input) => {
          record.providers.push(structuredClone(input))
          if (host.failProvider) throw new Error("not found")
          return { location: input.location ?? { directory: "/default" }, data: { id: input.providerID, name: input.providerID, ...structuredClone(host.providers[input.providerID] ?? {}) } }
        },
      },
      // Session metadata only (2.4.1 `session.get` → Session.Info with its location); unknown IDs fail like a 404.
      session: {
        get: async ({ sessionID }) => {
          record.sessions.push(sessionID)
          if (!Object.hasOwn(host.sessions, sessionID)) throw new Error("not found")
          return { id: sessionID, title: "synthetic", location: { directory: host.sessions[sessionID] } }
        },
      },
      storage: {
        get: async (key) => structuredClone(storage.get(key)),
        set: async (key, value) => {
          storage.set(key, structuredClone(value))
        },
        remove: async (key) => {
          storage.delete(key)
        },
      },
      rpc: {
        register: async (_contract, value) => {
          handlers = value
          return {
            events: { emit: async (name, data) => record.emitted.push([name, data]) },
            dispose: async () => {
              handlers = undefined
            },
          }
        },
      },
      event: {
        subscribe: ({ types, signal }) => {
          record.subscribed.push(types)
          return events.iterable(types, signal)
        },
      },
    },
  }
  return host
}

export const call = (signal = new AbortController().signal) => ({
  signal,
  error: (type, message, data) => ({ rpcError: type, message, data }),
})

export const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))
