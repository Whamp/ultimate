import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { formatSkillsForPrompt, loadSkills } from '@earendil-works/pi-coding-agent'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  section,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { afterEach, expect, it, vi } from 'vitest'
import sharedSkills from '../.ultimate/optional-extensions/shared-skills/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { fauxServer, temp, until } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
})

async function writeSkill(directory: string, name: string, description: string, userOnly = false) {
  const root = join(directory, name)
  await mkdir(root, { recursive: true })
  const path = join(root, 'SKILL.md')
  await writeFile(
    path,
    `---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: ${userOnly}\n---\nSkill instructions.\n`,
  )
  return path
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-shared-skills-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const sharedDirectory = join(home, '.agents/skills')
  const notice = vi.fn<(message: string) => void>()
  const skills = vi.fn<ExtensionHost['skills']>(
    (cwd = projectRoot) =>
      loadSkills({
        cwd,
        agentDir: join(home, 'pi'),
        skillPaths: [join(cwd, 'skills')],
        includeDefaults: false,
      }).skills,
  )
  const host = { userHome: home, projectRoot, skills, notice }
  const registry = createRegistry()
  registry.install(
    defineExtension({
      name: 'test-skills',
      sections: [
        section('skills', (input) =>
          formatSkillsForPrompt(skills(input.env?.cwd ?? input.agent.cwd ?? projectRoot)),
        ),
      ],
    }),
  )
  const extension = sharedSkills(host)
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry, models: createModels() },
    context,
  )
  cleanups.push(() => harness.close(context))
  const root = await harness.root(context)
  async function render(envCwd?: string) {
    const agent = await root.agent(context)
    const skillsSection = agent.sections.find((candidate) => candidate.key === 'skills')
    if (!skillsSection) {
      throw new Error('Shared skills test: skills section missing')
    }
    return skillsSection.render(
      {
        conversationId: root.id,
        agent,
        env: envCwd ? new NodeExecutionEnv({ cwd: envCwd }) : undefined,
        shown: {},
        read: harness,
      },
      context,
    )
  }
  return { home, projectRoot, sharedDirectory, notice, skills, registry, extension, root, render }
}

it('adds shared skills only while installed and selected, and restores them on re-enable', async () => {
  const f = await fixture()
  const shared = await writeSkill(f.sharedDirectory, 'shared-only', 'Shared instructions')
  const existing = await writeSkill(join(f.projectRoot, 'skills'), 'host-only', 'Host instructions')
  const original = await readFile(shared, 'utf8')
  const baseline = await f.render()
  expect(baseline).toContain(`<location>${existing}</location>`)
  expect(baseline).not.toContain('shared-only')
  f.registry.install(f.extension)
  const enabled = await f.render()
  expect(enabled).toContain(`<location>${shared}</location>`)
  expect(enabled).toContain('<description>Shared instructions</description>')
  expect(enabled).toContain(`<location>${existing}</location>`)
  expect(enabled?.match(/<available_skills>/g)).toHaveLength(1)
  await f.root.configure({ extensions: { remove: [f.extension] } }, context)
  expect(await f.render()).toBe(baseline)
  await f.root.configure({ extensions: { add: [f.extension] } }, context)
  expect(await f.render()).toBe(enabled)
  f.registry.uninstall(f.extension)
  expect(await f.render()).toBe(baseline)
  f.registry.install(f.extension)
  expect(await f.render()).toBe(enabled)
  expect(await readFile(shared, 'utf8')).toBe(original)
  expect(existsSync(join(f.home, '.ultimate/settings.json'))).toBe(false)
  expect(existsSync(join(f.projectRoot, '.ultimate/settings.json'))).toBe(false)
})

it('keeps existing skills on conflicts, including user-only overrides, and hides shared user-only skills', async () => {
  const f = await fixture()
  await writeSkill(f.sharedDirectory, 'same-name', 'Shared losing description')
  await writeSkill(f.sharedDirectory, 'hidden-override', 'Shared must not leak')
  await writeSkill(f.sharedDirectory, 'shared-user-only', 'User-only shared instructions', true)
  const winner = await writeSkill(join(f.projectRoot, 'skills'), 'same-name', 'Existing winner')
  await writeSkill(join(f.projectRoot, 'skills'), 'hidden-override', 'Existing user-only', true)
  f.registry.install(f.extension)
  const rendered = await f.render()
  expect(rendered).toContain(`<location>${winner}</location>`)
  expect(rendered).toContain('<description>Existing winner</description>')
  expect(rendered?.match(/<name>same-name<\/name>/g)).toHaveLength(1)
  expect(rendered).not.toContain('Shared losing description')
  expect(rendered).not.toContain('hidden-override')
  expect(rendered).not.toContain('Shared must not leak')
  expect(rendered).not.toContain('shared-user-only')
})

it('treats a missing shared directory as empty without creating it or reporting a notice', async () => {
  const f = await fixture()
  await writeSkill(join(f.projectRoot, 'skills'), 'host-only', 'Host instructions')
  const baseline = await f.render()
  f.registry.install(f.extension)
  expect(await f.render()).toBe(baseline)
  expect(f.notice).not.toHaveBeenCalled()
  expect(existsSync(f.sharedDirectory)).toBe(false)
})

it('reports Pi validation diagnostics once while unchanged, and follows its omit/load rules', async () => {
  const f = await fixture()
  const missing = join(f.sharedDirectory, 'missing-description', 'SKILL.md')
  await mkdir(join(f.sharedDirectory, 'missing-description'), { recursive: true })
  await writeFile(missing, '---\nname: missing-description\n---\nNo description.\n')
  const warned = await writeSkill(f.sharedDirectory, 'Bad_Name', 'Loaded despite a name warning')
  f.registry.install(f.extension)
  const rendered = await f.render()
  expect(rendered).not.toContain('missing-description')
  expect(rendered).toContain(`<location>${warned}</location>`)
  expect(f.notice.mock.calls.map(([message]) => message)).toEqual(
    expect.arrayContaining([
      `shared-skills: ${missing}: warning: description is required`,
      `shared-skills: ${warned}: warning: name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`,
    ]),
  )
  expect(f.notice).toHaveBeenCalledTimes(2)
  await f.render()
  expect(f.notice).toHaveBeenCalledTimes(2)
  await rm(f.sharedDirectory, { recursive: true })
  await f.render()
  await mkdir(join(f.sharedDirectory, 'missing-description'), { recursive: true })
  await writeFile(missing, '---\nname: missing-description\n---\nNo description.\n')
  await f.render()
  expect(f.notice).toHaveBeenCalledTimes(3)
})

it('re-reads added, edited, and removed shared skills for each render', async () => {
  const f = await fixture()
  f.registry.install(f.extension)
  expect(await f.render()).toBe('')
  const path = await writeSkill(f.sharedDirectory, 'changing', 'First version')
  expect(await f.render()).toContain('<description>First version</description>')
  await writeSkill(f.sharedDirectory, 'changing', 'Second version')
  const edited = await f.render()
  expect(edited).toContain('<description>Second version</description>')
  expect(edited).not.toContain('First version')
  await writeSkill(f.sharedDirectory, 'changing', 'Now user-only', true)
  expect(await f.render()).toBe('')
  await rm(path)
  expect(await f.render()).toBe('')
})

it.each(['environment', 'agent', 'project'])(
  'forwards the %s working directory to existing skill discovery',
  async (source) => {
    const f = await fixture()
    const agentCwd = join(f.home, 'agent-worktree')
    const envCwd = join(f.home, 'env-worktree')
    const cwd = source === 'environment' ? envCwd : source === 'agent' ? agentCwd : f.projectRoot
    const path = await writeSkill(join(cwd, 'skills'), 'cwd-only', 'Working directory skill')
    if (source !== 'project') {
      await f.root.configure({ cwd: agentCwd }, context)
    }
    f.registry.install(f.extension)
    expect(await f.render(source === 'environment' ? envCwd : undefined)).toContain(
      `<location>${path}</location>`,
    )
    expect(f.skills).toHaveBeenLastCalledWith(cwd)
  },
)

it('loads the copied user facet with the real prompt and applies disable/re-enable settings', async () => {
  const home = await temp()
  vi.stubEnv('PI_CODING_AGENT_DIR', join(home, 'pi'))
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const target = join(home, '.ultimate/extensions/shared-skills')
  await mkdir(target, { recursive: true })
  await copyFile(
    resolve('.ultimate/optional-extensions/shared-skills/server.ts'),
    join(target, 'server.ts'),
  )
  const path = await writeSkill(
    join(home, '.agents/skills'),
    'integration-shared',
    'User installation skill',
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  cleanups.push(() => server.close())
  const info = server.extensions.info().find((entry) => entry.name === 'shared-skills')
  expect(info).toMatchObject({ source: 'user', enabled: true, path: target })
  expect(info?.server?.loadedAt).toBeDefined()
  expect(info?.server?.error).toBeUndefined()
  async function render() {
    const agent = await server.root.agent(context)
    const skillsSection = agent.sections.find((candidate) => candidate.key === 'skills')
    if (!skillsSection) {
      throw new Error('Shared skills test: real prompt skills section missing')
    }
    return skillsSection.render(
      { conversationId: server.root.id, agent, env: undefined, shown: {}, read: server.harness },
      context,
    )
  }
  expect(await render()).toContain(`<location>${path}</location>`)
  const settings = join(home, '.ultimate/settings.json')
  await writeFile(settings, JSON.stringify({ extensions: { disable: ['shared-skills'] } }))
  server.vite.watcher.emit('change', settings)
  await until(() => !server.host.registry.snapshot().extension('shared-skills'))
  expect(await render()).not.toContain('integration-shared')
  await writeFile(settings, JSON.stringify({ extensions: { enable: ['shared-skills'] } }))
  server.vite.watcher.emit('change', settings)
  await until(() => !!server.host.registry.snapshot().extension('shared-skills'))
  expect(await render()).toContain(`<location>${path}</location>`)
})
