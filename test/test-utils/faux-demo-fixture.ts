import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { fauxServer, sourceCopy, temp } from '../helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

/** Open a faux demo server and close it after each test, including its Vite watcher. */
export async function fauxDemoServer(options: Parameters<typeof fauxServer>[0]) {
  const server = await fauxServer(options)
  servers.push(server)
  return server
}

/** Open the faux workspace demo on a real Git repository; close its server after each test. */
export async function fauxWorkspaceDemo() {
  const home = await temp('ultimate-faux-demo-')
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: projectRoot, env: { ...process.env, GIT_CONFIG_COUNT: '0' } })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  await writeFile(join(projectRoot, 'base.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'base')
  const ultimateRoot = await sourceCopy(home)
  const server = await fauxDemoServer({ ultimateRoot, home, userHome: home, projectRoot })
  return server
}
