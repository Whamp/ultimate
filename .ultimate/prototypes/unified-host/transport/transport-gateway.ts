import { createServer, request as upstreamRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'

/** Fixed child runtime addresses, created by the launcher, never by a request. */
export interface TransportProject {
  id: string
  url: string
  root: number
  pid: number
  projectRoot: string
  userHome: string
}

/** Loopback-only routing experiment. No response rewriting, cookies, auth, or WebSocket proxy. */
export async function createTransportGateway(projects: readonly TransportProject[]) {
  for (const project of projects) {
    const url = new URL(project.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') {
      throw new Error('Transport requires fixed loopback child origins')
    }
  }
  let authority = ''
  const server = createServer((request, response) => {
    const reject = (status: number, message: string) => {
      response.writeHead(status, { 'Content-Type': 'text/plain' })
      response.end(message)
    }
    if (!admitGatewayRequest(request, authority)) {
      reject(403, 'Forbidden Host, Origin, or forwarding headers')
      return
    }
    const raw = request.url ?? '/'
    // Reject encoded/normalized paths before URL parsing can erase their meaning.
    if (!raw.startsWith('/') || raw.startsWith('//') || /[%\\]/.test(raw.split('?')[0] ?? '')) {
      reject(400, 'Only literal local paths are supported')
      return
    }
    const url = new URL(raw, `http://${authority}`)
    if (url.pathname !== raw.split('?')[0]) {
      reject(400, 'Normalized paths are not supported')
      return
    }
    if (request.method === 'GET' && url.pathname === '/projects' && !url.search) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(projects))
      return
    }
    const files = new Map<string, readonly [string, string]>([
      ['/', ['transport-shell.html', 'text/html']],
      ['/transport-shell.js', ['transport-shell.js', 'text/javascript']],
    ])
    const file = files.get(url.pathname)
    if (request.method === 'GET' && file && !url.search) {
      void readFile(new URL(file[0], import.meta.url))
        .then((body) => {
          response.writeHead(200, {
            'Content-Type': file[1],
            'Cache-Control': 'no-store',
            'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; frame-src ${projects.map((p) => p.url).join(' ')}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
          })
          response.end(body)
        })
        .catch((error: unknown) => reject(500, String(error)))
      return
    }
    const match = /^\/p\/([a-z]+)(\/.*)$/.exec(url.pathname)
    const project = projects.find((item) => item.id === match?.[1])
    const path = match?.[2]
    const events =
      request.method === 'GET' &&
      path === '/api/events' &&
      /^[1-9]\d*$/.test(url.searchParams.get('conversation') ?? '') &&
      [...url.searchParams.keys()].every((key) => key === 'conversation')
    const submit =
      request.method === 'POST' &&
      /^\/api\/conversations\/[1-9]\d*\/submit$/.test(path ?? '') &&
      !url.search
    const prefixHtml = request.method === 'GET' && path === '/' && !url.search
    if (!project || !path || !(events || submit || prefixHtml)) {
      reject(404, 'Route not allowlisted (root assets are deliberately not proxied)')
      return
    }
    const target = new URL(path + url.search, project.url)
    const headers = { accept: request.headers.accept ?? '*/*', 'content-type': 'application/json' }
    // New headers deliberately omit client Host, Origin, cookies and forwarding metadata.
    const upstream = upstreamRequest(target, { method: request.method, headers }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, {
        'Content-Type': incoming.headers['content-type'] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      incoming.pipe(response)
      incoming.on('error', () => response.destroy())
    })
    upstream.on('error', () => {
      if (!response.headersSent) {
        reject(502, 'Child runtime unavailable')
      } else {
        response.destroy()
      }
    })
    response.on('close', () => upstream.destroy())
    if (!events) {
      upstream.setTimeout(30000, () => upstream.destroy(new Error('Child request timed out')))
    }
    // Bound inputs without buffering the long-lived response stream.
    void (async () => {
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk)
        size += buffer.length
        if (size > 16384) {
          reject(413, 'Prototype input limit is 16 KiB')
          upstream.destroy()
          return
        }
        chunks.push(buffer)
      }
      upstream.end(Buffer.concat(chunks))
    })().catch(() => {
      // A failed/aborted input stream cannot produce an API response; close both halves.
      upstream.destroy()
      response.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Transport has no TCP address')
  }
  authority = `127.0.0.1:${address.port}`
  return {
    url: `http://${authority}`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

function admitGatewayRequest(request: IncomingMessage, authority: string) {
  const headers = request.headers
  if (headers.host !== authority || headers['sec-fetch-site'] === 'cross-site') {
    return false
  }
  if (
    Object.keys(headers).some(
      (key) => key === 'forwarded' || key === 'x-real-ip' || key.startsWith('x-forwarded-'),
    )
  ) {
    return false
  }
  const hostCount = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === 'host',
  ).length
  const originCount = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === 'origin',
  ).length
  if (hostCount !== 1 || originCount > 1) {
    return false
  }
  if (headers.origin !== undefined && headers.origin !== `http://${authority}`) {
    return false
  }
  return request.method === 'GET' || headers.origin === `http://${authority}`
}
