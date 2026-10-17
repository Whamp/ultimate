import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { launchTransportFixture } from './transport.test-utils.ts'

await test('browser probe entrypoint submits to a background project and records the honest prefix failure', async (t) => {
  const { preview, home } = await launchTransportFixture(t)
  // Preserve browser evidence outside the fixture's cleaned runtime/home directories.
  const evidence = await mkdtemp(join(tmpdir(), 'ultimate-transport-browser-evidence-'))
  t.diagnostic(`Browser evidence: ${evidence}`)
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./transport-probe.ts', import.meta.url)), preview.url, evidence],
    { env: { PATH: process.env.PATH, HOME: home }, timeout: 60000, maxBuffer: 1024 * 1024 },
  )
  assert.match(stdout, /Actual Alpha API returned 202 while Beta was visible/)
  assert.match(stdout, /Alpha completed while Beta remained selected/)
  assert.match(stdout, /Prefix HTML is 200 but unchanged root assets fail with 404/)
  for (const project of preview.projects) {
    assert.equal(
      await readFile(join(dirname(project.projectRoot), 'state/demo.txt'), 'utf8'),
      project.id === 'alpha' ? 'after\n' : 'before\n',
    )
  }
  for (const name of ['background-alpha.png', 'completed-alpha.png', 'prefix-failure.png']) {
    const png = await readFile(join(evidence, name))
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
})
