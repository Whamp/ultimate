import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { test } from 'node:test'
import { decodeTransportProjects } from './transport-boundary.js'
import { launchTransportFixture } from './transport.test-utils.ts'

await test('launcher entrypoint creates two real isolated runtimes and removes them on SIGTERM', async (t) => {
  const { preview, stop } = await launchTransportFixture(t)
  const projects = decodeTransportProjects(await (await fetch(`${preview.url}/projects`)).text())
  assert.deepEqual(projects, preview.projects)
  assert.notEqual(projects[0]?.pid, projects[1]?.pid)
  assert.notEqual(projects[0]?.projectRoot, projects[1]?.projectRoot)
  for (const project of projects) {
    assert.ok((await stat(`/proc/${project.pid}`)).isDirectory())
    assert.ok((await stat(project.projectRoot)).isDirectory())
    assert.equal((await fetch(project.url)).status, 200)
  }
  await stop()
  await assert.rejects(stat(preview.directory), { code: 'ENOENT' })
  await assert.rejects(fetch(preview.url))
  for (const project of projects) {
    await assert.rejects(stat(`/proc/${project.pid}`), { code: 'ENOENT' })
    await assert.rejects(fetch(project.url))
  }
})
