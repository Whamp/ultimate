import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, openSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTransportGateway } from './transport-gateway.ts'
import type { TransportProject } from './transport-gateway.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SCRIPT = fileURLToPath(import.meta.url)

if (process.argv[2] === '--child') {
  const directory = process.argv[3]
  if (!directory) {
    throw new Error('Transport child requires its temporary directory')
  }
  // Imports happen only after spawn has replaced HOME, Pi config and the entire environment.
  const { createServer } = await import('../../../../server/main.ts')
  const userHome = join(directory, 'user')
  const server = await createServer({
    ultimateRoot: ROOT,
    projectRoot: join(directory, 'project'),
    userHome,
    home: join(directory, 'state'),
    faux: true,
    port: 0,
  })
  await writeFile(
    join(directory, 'ready.json'),
    JSON.stringify({ url: server.url, root: server.root.id }),
  )
  process.send?.('ready')
  const close = async () => {
    await server.close()
    process.exit(0)
  }
  process.once('SIGTERM', () => {
    void close()
  })
  process.once('SIGINT', () => {
    void close()
  })
  process.once('disconnect', () => {
    void close()
  })
} else {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-transport-'))
  const children: ChildProcess[] = []
  let gateway: Awaited<ReturnType<typeof createTransportGateway>> | undefined
  let stopping = false
  const close = async () => {
    if (stopping) {
      return
    }
    stopping = true
    await gateway?.close()
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return
        }
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        const deadline = setTimeout(() => child.kill('SIGKILL'), 10000)
        await exited
        clearTimeout(deadline)
      }),
    )
    await rm(directory, { recursive: true, force: true })
  }
  process.once('SIGTERM', () => {
    void close()
  })
  process.once('SIGINT', () => {
    void close()
  })
  try {
    const projects: TransportProject[] = []
    for (const id of ['alpha', 'beta']) {
      const base = join(directory, id)
      const userHome = join(base, 'user')
      const projectRoot = join(base, 'project')
      await mkdir(projectRoot, { recursive: true })
      await mkdir(join(userHome, '.pi/agent'), { recursive: true })
      const log = openSync(join(base, 'runtime.log'), 'w', 0o600)
      const child = spawn(process.execPath, [SCRIPT, '--child', base], {
        cwd: projectRoot,
        // Allowlist, not a filtered copy: no API keys, proxy settings, auth paths or host config.
        env: {
          PATH: process.env.PATH,
          HOME: userHome,
          XDG_CONFIG_HOME: join(userHome, '.config'),
          PI_CODING_AGENT_DIR: join(userHome, '.pi/agent'),
          ULTIMATE_FAUX: '1',
          ULTIMATE_NO_OPEN: '1',
        },
        stdio: ['ignore', log, log, 'ipc'],
      })
      closeSync(log)
      children.push(child)
      const deadline = setTimeout(() => child.kill('SIGKILL'), 90000)
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            const ready = (message: unknown) => {
              if (message === 'ready') {
                child.off('message', ready)
                resolve()
              }
            }
            child.on('message', ready)
          }),
          once(child, 'exit').then(async () => {
            const output = await readFile(join(base, 'runtime.log'), 'utf8')
            throw new Error(`Transport child boot failed: ${output}`)
          }),
        ])
      } finally {
        clearTimeout(deadline)
      }
      // This file is written by our child only; validate its two small boundary fields.
      const ready: unknown = JSON.parse(await readFile(join(base, 'ready.json'), 'utf8'))
      assert.ok(ready && typeof ready === 'object' && 'url' in ready && 'root' in ready)
      assert.ok(typeof ready.url === 'string' && typeof ready.root === 'number')
      assert.ok(
        Number.isSafeInteger(ready.root) && ready.root > 0 && child.pid,
        'Transport child readiness file is invalid',
      )
      projects.push({ id, url: ready.url, root: ready.root, pid: child.pid, projectRoot, userHome })
      child.once('exit', () => {
        if (!stopping) {
          process.stderr.write(`Transport child ${id} exited; stopping experiment\n`)
          void close()
        }
      })
    }
    gateway = await createTransportGateway(projects)
    const manifest = { url: gateway.url, pid: process.pid, directory, projects }
    await writeFile(join(directory, 'preview.json'), JSON.stringify(manifest, null, 2))
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  } catch (error) {
    await close()
    throw error
  }
}
