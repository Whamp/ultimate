import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeTransportPreview,
  decodeTransportProjects,
  decodeTransportReady,
} from './transport-boundary.js'

const ALPHA = {
  id: 'alpha',
  url: 'http://127.0.0.1:12345',
  root: 1,
  pid: 42,
  projectRoot: '/tmp/alpha/project',
  userHome: '/tmp/alpha/user',
}
const BETA = {
  ...ALPHA,
  id: 'beta',
  url: 'http://127.0.0.1:12346',
  pid: 43,
  projectRoot: '/tmp/beta/project',
  userHome: '/tmp/beta/user',
}

await test('boundary decodes named readiness, projects and launcher receipts', () => {
  const ready = { url: ALPHA.url, root: 1 }
  assert.deepEqual(decodeTransportReady(JSON.stringify(ready)), ready)
  assert.deepEqual(decodeTransportProjects(JSON.stringify([ALPHA, BETA])), [ALPHA, BETA])
  const preview = {
    url: 'http://127.0.0.1:12347',
    pid: 41,
    directory: '/tmp/preview',
    projects: [ALPHA, BETA],
  }
  assert.deepEqual(decodeTransportPreview(JSON.stringify(preview)), preview)
})

await test('boundary rejects malformed identities before consumers use paths or process IDs', () => {
  for (const value of [
    null,
    [],
    'not a receipt',
    {},
    { url: ALPHA.url, root: '1' },
    { url: ALPHA.url, root: 0 },
    { url: ALPHA.url, root: 1.5 },
    { url: 'http://foreign.invalid', root: 1 },
    { url: `${ALPHA.url}/?upstream=foreign`, root: 1 },
    { url: 'http://user:pass@127.0.0.1:12345', root: 1 },
  ]) {
    assert.throws(
      () => decodeTransportReady(JSON.stringify(value)),
      /Invalid transport readiness JSON/,
    )
  }
  for (const project of [
    { ...ALPHA, id: 'gamma' },
    { ...ALPHA, pid: '42' },
    { ...ALPHA, pid: -1 },
    { ...ALPHA, projectRoot: {} },
    { ...ALPHA, projectRoot: 'relative' },
    { ...ALPHA, userHome: null },
    { ...ALPHA, userHome: '/tmp/bad\0path' },
  ]) {
    assert.throws(
      () => decodeTransportProjects(JSON.stringify([project, BETA])),
      /Invalid transport projects JSON/,
    )
  }
  for (const projects of [null, [ALPHA], [ALPHA, ALPHA], [ALPHA, BETA, BETA]]) {
    assert.throws(
      () => decodeTransportProjects(JSON.stringify(projects)),
      /Invalid transport projects JSON/,
    )
  }
  assert.throws(
    () =>
      decodeTransportPreview(
        JSON.stringify({
          url: ALPHA.url,
          pid: '41',
          directory: '/tmp/preview',
          projects: [ALPHA, BETA],
        }),
      ),
    /Invalid transport preview JSON/,
  )
  assert.throws(() => decodeTransportReady('{'), SyntaxError)
})
