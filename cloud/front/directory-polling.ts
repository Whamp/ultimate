/** The fields rendered from `/api/directory`; routing-only metadata stays in the Worker. */
export interface DirectoryInstance {
  machine: string
  project: string
  slug: string
  connected: boolean
  lastSeen: number
  count: number
}

type Directory =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; rows: DirectoryInstance[] }

interface DirectorySnapshot {
  directory: Directory
  failing: boolean
}

function isDirectoryInstance(value: unknown): value is DirectoryInstance {
  return (
    typeof value === 'object' &&
    value !== null &&
    'machine' in value &&
    typeof value.machine === 'string' &&
    'project' in value &&
    typeof value.project === 'string' &&
    'slug' in value &&
    typeof value.slug === 'string' &&
    'connected' in value &&
    typeof value.connected === 'boolean' &&
    'lastSeen' in value &&
    typeof value.lastSeen === 'number' &&
    Number.isFinite(value.lastSeen) &&
    'count' in value &&
    typeof value.count === 'number' &&
    Number.isInteger(value.count) &&
    value.count >= 0
  )
}

/** Owns the front page's 10-second polling while subscribed; failed refreshes retain the last list. */
export class DirectoryPolling {
  private snapshot: DirectorySnapshot = { directory: { state: 'loading' }, failing: false }
  private readonly listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setInterval>
  private request?: AbortController
  private readonly fetchDirectory: typeof fetch

  constructor(fetchDirectory: typeof fetch = (input, init) => fetch(input, init)) {
    this.fetchDirectory = fetchDirectory
  }

  getSnapshot = () => this.snapshot

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      void this.refresh()
      this.timer = setInterval(() => void this.refresh(), 10000)
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        clearInterval(this.timer)
        this.request?.abort()
        this.request = undefined
      }
    }
  }

  private async refresh() {
    if (this.request) return
    const request = new AbortController()
    this.request = request
    let snapshot: DirectorySnapshot
    try {
      const response = await this.fetchDirectory('/api/directory', { signal: request.signal })
      if (!response.ok) throw new Error(`Directory HTTP status: ${response.status}`)
      const rows: unknown = await response.json()
      if (!Array.isArray(rows) || !rows.every(isDirectoryInstance))
        throw new Error('Invalid directory response')
      snapshot = { directory: { state: 'loaded', rows }, failing: false }
    } catch {
      // Signed out, malformed or unreachable: show failure without discarding the last loaded list.
      snapshot = {
        directory:
          this.snapshot.directory.state === 'loaded'
            ? this.snapshot.directory
            : { state: 'failed' },
        failing: true,
      }
    }
    // Abort is advisory: a disposed subscription's transport/body may still finish after a new one starts.
    if (this.request !== request) return
    this.request = undefined
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
