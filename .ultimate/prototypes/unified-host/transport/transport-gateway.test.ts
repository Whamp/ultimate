import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { createTransportGateway } from './transport-gateway.ts'

// A tiny upstream is sufficient here: these assertions target gateway admission and routing,
// not Ultimate semantics. transport-probe.ts separately exercises real children and browser SSE.
await test('gateway admits only its literal local routes, Host and Origin; strips client metadata', async () => {
  let hits = 0
  const child = createServer((incoming, response) => {
    hits += 1
    assert.equal(incoming.headers.origin, undefined)
    assert.equal(incoming.headers.cookie, undefined)
    assert.equal(incoming.url, '/api/conversations/1/submit')
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end('{"submissionId":42}')
  })
  await new Promise<void>((resolve) => child.listen(0, '127.0.0.1', resolve))
  const address = child.address()
  assert.ok(address && typeof address !== 'string')
  const gateway = await createTransportGateway([
    {
      id: 'alpha',
      url: `http://127.0.0.1:${address.port}`,
      root: 1,
      pid: process.pid,
      projectRoot: '/temporary/alpha',
      userHome: '/temporary/user',
    },
  ])
  try {
    const path = '/p/alpha/api/conversations/1/submit'
    const cases = [
      { path, method: 'POST', headers: {}, status: 403 },
      { path, method: 'POST', headers: { Origin: 'http://foreign.invalid' }, status: 403 },
      { path, method: 'POST', headers: { Origin: 'null' }, status: 403 },
      { path: '/', method: 'GET', headers: { Origin: 'http://foreign.invalid' }, status: 403 },
      { path: '/', method: 'GET', headers: { Host: 'foreign.invalid' }, status: 403 },
      { path: '/', method: 'GET', headers: { Forwarded: 'host=foreign.invalid' }, status: 403 },
      { path: '/', method: 'GET', headers: { 'X-Forwarded-Host': 'foreign.invalid' }, status: 403 },
      { path: '/', method: 'GET', headers: { 'X-Forwarded-For': '127.0.0.1' }, status: 403 },
      { path: '/', method: 'GET', headers: { 'X-Real-IP': '127.0.0.1' }, status: 403 },
      { path: '/', method: 'GET', headers: { 'Sec-Fetch-Site': 'cross-site' }, status: 403 },
      { path: '/p/gamma/api/events?conversation=1', method: 'GET', headers: {}, status: 404 },
      {
        path: '/p/alpha/api/restart',
        method: 'POST',
        headers: { Origin: gateway.url },
        status: 404,
      },
      {
        path: '/p/alpha/api/extensions/self/actions/debug',
        method: 'POST',
        headers: { Origin: gateway.url },
        status: 404,
      },
      {
        path: '/p/alpha/api/events?conversation=1&url=http://foreign.invalid',
        method: 'GET',
        headers: {},
        status: 404,
      },
      { path: '/p/alpha/%2e%2e/api/events', method: 'GET', headers: {}, status: 400 },
      { path: '/p/alpha/api/../', method: 'GET', headers: {}, status: 400 },
      { path: '//foreign.invalid/', method: 'GET', headers: {}, status: 400 },
      { path: 'http://foreign.invalid/', method: 'GET', headers: {}, status: 400 },
      { path: '/src/main.tsx', method: 'GET', headers: {}, status: 404 },
      { path: '/@vite/client', method: 'GET', headers: {}, status: 404 },
    ]
    for (const example of cases) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          gateway.url,
          { path: example.path, method: example.method, headers: example.headers },
          (response) => {
            response.resume()
            response.on('end', () => resolve(response.statusCode ?? 0))
          },
        )
        req.on('error', reject)
        req.end()
      })
      assert.equal(status, example.status, JSON.stringify(example))
    }
    assert.equal(hits, 0, 'rejected requests must not reach upstream')
    const accepted = await fetch(gateway.url + path, {
      method: 'POST',
      headers: { Origin: gateway.url, Cookie: 'not-forwarded=1' },
      body: '{"text":"hello"}',
    })
    assert.equal(accepted.status, 202)
    assert.deepEqual(await accepted.json(), { submissionId: 42 })
    assert.equal(hits, 1)
  } finally {
    await gateway.close()
    await new Promise<void>((resolve, reject) =>
      child.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
