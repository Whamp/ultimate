import { afterEach, expect, it, vi } from 'vitest'
import { DirectoryPolling } from '../cloud/front/directory-polling.ts'

const ROW = {
  machine: 'test',
  project: '/work/test',
  slug: 'test/test',
  connected: true,
  lastSeen: 1,
  count: 2,
}
afterEach(() => vi.useRealTimers())

it('starts loading, fetches immediately and refreshes at 10 seconds without overlapping a slow request', async () => {
  vi.useFakeTimers()
  const first = Promise.withResolvers<Response>()
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(Response.json([]))
  const polling = new DirectoryPolling(fetch)
  const changed = vi.fn<() => void>()
  expect(polling.getSnapshot()).toEqual({ directory: { state: 'loading' }, failing: false })
  const unsubscribe = polling.subscribe(changed)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/directory')
  await vi.advanceTimersByTimeAsync(30000)
  expect(fetch).toHaveBeenCalledTimes(1)
  first.resolve(Response.json([ROW]))
  await vi.advanceTimersByTimeAsync(0)
  expect(polling.getSnapshot()).toEqual({
    directory: { state: 'loaded', rows: [ROW] },
    failing: false,
  })
  expect(changed).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(9999)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(polling.getSnapshot()).toEqual({
    directory: { state: 'loaded', rows: [] },
    failing: false,
  })
  unsubscribe()
})

it.each(['resolve', 'reject'] as const)(
  'ignores an obsolete request that finishes with %s after unsubscribe and resubscribe',
  async (completion) => {
    vi.useFakeTimers()
    const obsolete = Promise.withResolvers<Response>()
    const current = Promise.withResolvers<Response>()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(obsolete.promise)
      .mockReturnValueOnce(current.promise)
    const polling = new DirectoryPolling(fetch)
    const firstListener = vi.fn<() => void>()
    const unsubscribe = polling.subscribe(firstListener)
    const signal = fetch.mock.calls[0]?.[1]?.signal
    unsubscribe()
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    const listener = vi.fn<() => void>()
    const stop = polling.subscribe(listener)
    current.resolve(Response.json([ROW]))
    await vi.advanceTimersByTimeAsync(0)
    if (completion === 'resolve') obsolete.resolve(Response.json([]))
    else obsolete.reject(new Error('Disposed request failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(polling.getSnapshot()).toEqual({
      directory: { state: 'loaded', rows: [ROW] },
      failing: false,
    })
    expect(firstListener).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(30000)
    expect(fetch).toHaveBeenCalledTimes(2)
  },
)

it('aborts only after the last subscriber leaves and never publishes a disposed result', async () => {
  vi.useFakeTimers()
  const pending = Promise.withResolvers<Response>()
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(pending.promise)
  const polling = new DirectoryPolling(fetch)
  const first = vi.fn<() => void>(),
    second = vi.fn<() => void>()
  const stopFirst = polling.subscribe(first)
  const stopSecond = polling.subscribe(second)
  stopFirst()
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(1)
  stopSecond()
  pending.resolve(Response.json([ROW]))
  await vi.advanceTimersByTimeAsync(30000)
  expect(polling.getSnapshot()).toEqual({ directory: { state: 'loading' }, failing: false })
  expect(first).not.toHaveBeenCalled()
  expect(second).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('shows initial failure, recovers, and keeps the last list during a failed refresh', async () => {
  vi.useFakeTimers()
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(Response.json([ROW]))
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(Response.json([]))
  const polling = new DirectoryPolling(fetch)
  const stop = polling.subscribe(vi.fn<() => void>())
  await vi.advanceTimersByTimeAsync(0)
  expect(polling.getSnapshot()).toEqual({ directory: { state: 'failed' }, failing: true })
  await vi.advanceTimersByTimeAsync(10000)
  expect(polling.getSnapshot()).toEqual({
    directory: { state: 'loaded', rows: [ROW] },
    failing: false,
  })
  await vi.advanceTimersByTimeAsync(10000)
  expect(polling.getSnapshot()).toEqual({
    directory: { state: 'loaded', rows: [ROW] },
    failing: true,
  })
  await vi.advanceTimersByTimeAsync(10000)
  expect(polling.getSnapshot()).toEqual({
    directory: { state: 'loaded', rows: [] },
    failing: false,
  })
  stop()
})

it.each([
  null,
  {},
  [null],
  [{ ...ROW, machine: 1 }],
  [{ ...ROW, project: null }],
  [{ ...ROW, slug: false }],
  [{ ...ROW, connected: 'yes' }],
  [{ ...ROW, lastSeen: 'now' }],
  [{ ...ROW, count: -1 }],
  [{ ...ROW, count: 1.5 }],
])(
  'rejects malformed directory JSON through fetch without replacing loaded rows: %j',
  async (malformed) => {
    vi.useFakeTimers()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json([ROW]))
      .mockResolvedValueOnce(Response.json(malformed))
    const polling = new DirectoryPolling(fetch)
    const stop = polling.subscribe(vi.fn<() => void>())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10000)
    expect(polling.getSnapshot()).toEqual({
      directory: { state: 'loaded', rows: [ROW] },
      failing: true,
    })
    stop()
  },
)
