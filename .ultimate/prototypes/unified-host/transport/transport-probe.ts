import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright-core'
import type { TransportProject } from './transport-gateway.ts'

const URL = process.argv[2]
const OUTPUT = process.argv[3] ?? '/tmp/ultimate-transport-evidence'
if (!URL || !/^http:\/\/127\.0\.0\.1:\d+$/.test(URL)) {
  throw new Error('Usage: node transport-probe.ts http://127.0.0.1:PORT [evidence-directory]')
}
await mkdir(OUTPUT, { recursive: true })
const manifestResponse = await fetch(`${URL}/projects`)
assert.equal(manifestResponse.status, 200)
// Trusted launcher manifest, also consumed by the shell; children supply no user-controlled fields.
const projects: TransportProject[] = await manifestResponse.json()
assert.equal(projects.length, 2)
const alpha = projects.find((project) => project.id === 'alpha')
const beta = projects.find((project) => project.id === 'beta')
assert.ok(alpha && beta)
assert.notEqual(alpha.pid, beta.pid)
assert.notEqual(alpha.projectRoot, beta.projectRoot)
assert.notEqual(alpha.userHome, beta.userHome)
assert.equal(
  alpha.root,
  beta.root,
  'same numeric conversation ID deliberately exercises namespace collisions',
)
for (const project of projects) {
  const env = Object.fromEntries(
    (await readFile(`/proc/${project.pid}/environ`, 'utf8'))
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf('=')
        return [entry.slice(0, index), entry.slice(index + 1)]
      }),
  )
  assert.deepEqual(
    Object.keys(env).toSorted(),
    [
      'HOME',
      'PATH',
      'PI_CODING_AGENT_DIR',
      'ULTIMATE_FAUX',
      'ULTIMATE_NO_OPEN',
      'XDG_CONFIG_HOME',
      'NODE_CHANNEL_FD',
      'NODE_CHANNEL_SERIALIZATION_MODE',
    ].toSorted(),
  )
  assert.equal(env.HOME, project.userHome)
  assert.equal(env.PI_CODING_AGENT_DIR, join(project.userHome, '.pi/agent'))
}

async function projectSnapshot(project: TransportProject) {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`${URL}/p/${project.id}/api/events?conversation=${project.root}`, {
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('event: tasks\n')) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false, 'SSE must remain open through the initial snapshot')
      text += decoder.decode(chunk.value, { stream: true })
    }
    await reader.cancel()
    return text
  } finally {
    clearTimeout(deadline)
    controller.abort()
  }
}
const initialAlpha = await projectSnapshot(alpha)
const initialBeta = await projectSnapshot(beta)
assert.ok(initialAlpha.includes(alpha.projectRoot))
assert.ok(!initialAlpha.includes(beta.projectRoot))
assert.ok(initialBeta.includes(beta.projectRoot))
assert.ok(!initialBeta.includes(alpha.projectRoot))
assert.ok(!initialBeta.includes('phases demo'))

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true })
const observations: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(URL)
  await page.waitForFunction(
    () => document.querySelector('#alpha-status p')?.getAttribute('data-state') === 'Idle',
  )
  const alphaFrame = page.frameLocator('iframe[title="Actual Ultimate · alpha"]')
  await alphaFrame.getByRole('textbox').waitFor()
  const accepted = page.waitForResponse((response) =>
    response.url().endsWith(`/p/alpha/api/conversations/${alpha.root}/submit`),
  )
  await page.getByRole('button', { name: 'Run Alpha while viewing Beta' }).click()
  assert.equal((await accepted).status(), 202)
  assert.equal(await page.getByLabel('Project', { exact: true }).inputValue(), 'beta')
  await page.waitForFunction(
    () => document.querySelector('#alpha-status p')?.getAttribute('data-state') === 'Working',
  )
  const betaFrame = page.frameLocator('iframe[title="Actual Ultimate · beta"]')
  await betaFrame.getByText(beta.projectRoot, { exact: true }).waitFor()
  assert.match(await page.locator('#beta-status').innerText(), /Idle/)
  await page.screenshot({ path: join(OUTPUT, 'background-alpha.png') })
  observations.push(
    'Actual Alpha API returned 202 while Beta was visible; Alpha SSE reported Working; Beta remained Idle.',
  )
  await page.waitForFunction(
    () => document.querySelector('#alpha-status p')?.getAttribute('data-state') === 'Idle',
    null,
    { timeout: 30000 },
  )
  const finishedAlpha = await projectSnapshot(alpha)
  const finishedBeta = await projectSnapshot(beta)
  assert.ok(finishedAlpha.includes('Phases demo complete.'))
  assert.ok(!finishedBeta.includes('phases demo'))
  assert.ok(!finishedBeta.includes('Phases demo complete.'))
  assert.equal(
    await readFile(join(dirname(alpha.projectRoot), 'state/demo.txt'), 'utf8'),
    'after\n',
  )
  assert.equal(
    await readFile(join(dirname(beta.projectRoot), 'state/demo.txt'), 'utf8'),
    'before\n',
  )
  await page.getByLabel('Project', { exact: true }).selectOption('alpha')
  await alphaFrame.getByText('Phases demo complete.', { exact: true }).last().waitFor()
  await page.screenshot({ path: join(OUTPUT, 'completed-alpha.png') })
  observations.push(
    'Alpha completed while Beta remained selected; Alpha scratch is after, Beta scratch is before. Real Alpha transcript renders on return.',
  )
  assert.deepEqual(errors, [], 'working shell must not have uncaught browser exceptions')

  const failures: string[] = []
  page.on('response', (response) => {
    if (response.status() === 404) {
      failures.push(new globalThis.URL(response.url()).pathname)
    }
  })
  page.on('console', (message) => {
    if (message.type() === 'error') {
      observations.push(`Prefix browser console: ${message.text()}`)
    }
  })
  const htmlResponse = await page.goto(`${URL}/p/alpha/`)
  assert.equal(htmlResponse?.status(), 200)
  const html = await htmlResponse.text()
  assert.match(html, /src="\/src\/main.tsx"/)
  await page.waitForLoadState('networkidle')
  assert.ok(failures.includes('/src/main.tsx'))
  assert.ok(failures.includes('/@vite/client'))
  assert.equal((await page.locator('body').innerText()).trim(), '')
  await page.screenshot({ path: join(OUTPUT, 'prefix-failure.png') })
  observations.push(
    `Prefix HTML is 200 but unchanged root assets fail with 404: ${failures.join(', ')}. Empty body, not a working single-origin app.`,
  )
  await writeFile(
    join(OUTPUT, 'observations.json'),
    JSON.stringify({ url: URL, projects, observations }, null, 2),
  )
  process.stdout.write(`${observations.join('\n')}\nEvidence: ${OUTPUT}\n`)
} finally {
  await browser.close()
}
