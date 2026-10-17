import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { loadSkills } from '@earendil-works/pi-coding-agent'
import { createModels } from '@earendil-works/pi-ai/models'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import skillPicker, { actions } from '../extensions/skill-picker/server.ts'
import type { Workspace } from '../extensions/workspaces/types.ts'
import type { ExtensionInfo } from '../shared/protocol.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close()
})

async function writeSkill(
  directory: string,
  name: string,
  description: string,
  manualOnly = false,
) {
  const root = join(directory, name)
  await mkdir(root, { recursive: true })
  const path = join(root, 'SKILL.md')
  await writeFile(
    path,
    `---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: ${manualOnly}\n---\nInstructions.\n`,
  )
  return path
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-skill-picker-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const registry = createRegistry()
  registry.install(skillPicker())
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry, models: createModels() },
    context,
  )
  cleanups.push(() => harness.close(context))
  const root = await harness.root(context)
  await root.configure({ cwd: projectRoot }, context)
  const shared: ExtensionInfo = {
    name: 'shared-skills',
    enabled: true,
    source: 'user',
    layer: 'folder',
    path: join(home, '.ultimate/extensions/shared-skills'),
    actions: [],
    facets: { server: true, web: false },
    server: { loadedAt: '2026-10-17T00:00:00Z', tools: [], sections: [], hooks: 0, docs: [] },
  }
  const extensions = vi.fn<() => ExtensionInfo[]>(() => [shared])
  const skills = vi.fn<Parameters<typeof actions.list>[1]['host']['skills']>(
    (cwd: string) =>
      loadSkills({
        cwd,
        agentDir: join(home, 'pi'),
        skillPaths: [join(cwd, 'skills')],
        includeDefaults: false,
      }).skills,
  )
  const use = vi.fn<Parameters<typeof actions.list>[1]['host']['use']>()
  const host = { userHome: home, projectRoot, harness: () => harness, extensions, skills, use }
  const workspaces = new Map<number, Workspace>()
  const get = vi.fn<(id: ConversationId) => Promise<Workspace | undefined>>(async (id) =>
    workspaces.get(id),
  )
  return {
    home,
    projectRoot,
    sharedDirectory: join(home, '.agents/skills'),
    root,
    shared,
    host,
    workspaces,
    list: (args: JsonValue = null, conversationId?: number) =>
      actions.list(args, { host, conversationId }),
    enableWorkspaces() {
      use.mockReturnValue({ get })
    },
    async conversation(cwd?: string) {
      const id = await harness.commit(
        async (tx) => (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id,
        context,
      )
      const conversation = await harness.conversation(id, context)
      if (!conversation) throw new Error('Skill picker fixture conversation missing')
      if (cwd) await conversation.configure({ cwd }, context)
      return conversation
    },
  }
}

it('lists host and shared skills once, preserving host winners and explicit-only permissions', async () => {
  const f = await fixture()
  const shared = await writeSkill(f.sharedDirectory, 'shared-only', 'Shared instructions')
  await writeSkill(f.sharedDirectory, 'duplicate', 'Losing shared instructions')
  const sharedManual = await writeSkill(
    f.sharedDirectory,
    'shared-manual',
    'Manual shared instructions',
    true,
  )
  const host = await writeSkill(join(f.projectRoot, 'skills'), 'host-only', 'Host instructions')
  const winner = await writeSkill(
    join(f.projectRoot, 'skills'),
    'duplicate',
    'Winning host instructions',
    true,
  )
  const original = await readFile(winner, 'utf8')
  expect(await f.list()).toEqual(
    expect.arrayContaining([
      {
        name: 'shared-only',
        description: 'Shared instructions',
        path: shared,
        disableModelInvocation: false,
      },
      {
        name: 'shared-manual',
        description: 'Manual shared instructions',
        path: sharedManual,
        disableModelInvocation: true,
      },
      {
        name: 'host-only',
        description: 'Host instructions',
        path: host,
        disableModelInvocation: false,
      },
      {
        name: 'duplicate',
        description: 'Winning host instructions',
        path: winner,
        disableModelInvocation: true,
      },
    ]),
  )
  expect(await f.list()).toHaveLength(4)
  expect(await readFile(winner, 'utf8')).toBe(original)
  expect(existsSync(join(f.home, '.ultimate/settings.json'))).toBe(false)
  expect(existsSync(join(f.projectRoot, '.ultimate/settings.json'))).toBe(false)
})

it('requires shared-skills to be enabled with a loaded server facet on each request', async () => {
  const f = await fixture()
  await writeSkill(f.sharedDirectory, 'shared-only', 'Shared instructions')
  await writeSkill(join(f.projectRoot, 'skills'), 'host-only', 'Host instructions')
  const names = async () => (await f.list()).map((skill) => skill.name)
  expect(await names()).toEqual(['shared-only', 'host-only'])
  f.shared.enabled = false
  expect(await names()).toEqual(['host-only'])
  f.shared.enabled = true
  f.shared.server = { tools: [], sections: [], hooks: 0, docs: [], error: 'Not loaded' }
  expect(await names()).toEqual(['host-only'])
  f.shared.server = undefined
  expect(await names()).toEqual(['host-only'])
  f.host.extensions.mockReturnValue([])
  expect(await names()).toEqual(['host-only'])
  f.host.extensions.mockReturnValue([f.shared])
  f.shared.server = {
    loadedAt: '2026-10-17T00:00:00Z',
    tools: [],
    sections: [],
    hooks: 0,
    docs: [],
  }
  expect(await names()).toEqual(['shared-only', 'host-only'])
})

it('observes created, edited and deleted shared and host files without caching', async () => {
  const f = await fixture()
  expect(await f.list()).toEqual([])
  const path = await writeSkill(f.sharedDirectory, 'live-skill', 'Initial description')
  expect(await f.list()).toEqual([
    { name: 'live-skill', description: 'Initial description', path, disableModelInvocation: false },
  ])
  await writeSkill(f.sharedDirectory, 'live-skill', 'Edited description', true)
  expect(await f.list()).toEqual([
    { name: 'live-skill', description: 'Edited description', path, disableModelInvocation: true },
  ])
  await rm(path)
  expect(await f.list()).toEqual([])
  const hostPath = await writeSkill(
    join(f.projectRoot, 'skills'),
    'host-live',
    'New host instructions',
  )
  expect((await f.list()).map((skill) => skill.path)).toEqual([hostPath])
  await rm(hostPath)
  expect(await f.list()).toEqual([])
})

it('uses the current conversation cwd, then new branch source cwd, then project root', async () => {
  const f = await fixture()
  const sourceCwd = join(f.home, 'source')
  const currentCwd = join(f.home, 'current')
  const projectPath = await writeSkill(
    join(f.projectRoot, 'skills'),
    'project-skill',
    'Project inventory',
  )
  const sourcePath = await writeSkill(join(sourceCwd, 'skills'), 'source-skill', 'Source inventory')
  const currentPath = await writeSkill(
    join(currentCwd, 'skills'),
    'current-skill',
    'Current inventory',
  )
  const source = await f.conversation(sourceCwd)
  const current = await f.conversation(currentCwd)
  expect((await f.list()).map((skill) => skill.path)).toEqual([projectPath])
  expect((await f.list({})).map((skill) => skill.path)).toEqual([projectPath])
  expect((await f.list({ source: source.id })).map((skill) => skill.path)).toEqual([sourcePath])
  expect((await f.list({ source: source.id }, current.id)).map((skill) => skill.path)).toEqual([
    currentPath,
  ])
  const unconfigured = await f.conversation()
  expect((await f.list(null, unconfigured.id)).map((skill) => skill.path)).toEqual([projectPath])
})

it('uses the live workspace service and rejects non-ready or missing conversation checkouts', async () => {
  const f = await fixture()
  f.enableWorkspaces()
  const workspacePath = join(f.home, 'workspace')
  const path = await writeSkill(
    join(workspacePath, 'skills'),
    'workspace-skill',
    'Workspace inventory',
  )
  const workspace: Workspace = {
    path: workspacePath,
    state: 'ready',
    branch: 'topic',
    base: 'base',
    source: f.projectRoot,
    target: 'main',
  }
  f.workspaces.set(f.root.id, workspace)
  expect((await f.list(null, f.root.id)).map((skill) => skill.path)).toEqual([path])
  f.host.skills.mockClear()
  for (const state of ['preparing', 'failed', 'removed'] as const) {
    workspace.state = state
    await expect(f.list(null, f.root.id)).rejects.toThrow('active, ready workspace')
  }
  f.workspaces.clear()
  const absent = await f.conversation(join(f.home, 'removed-workspace'))
  await expect(f.list(null, absent.id)).rejects.toThrow('ENOENT')
  await expect(f.list({ source: 99999 })).rejects.toThrow('conversation is unavailable')
  await expect(f.list(null, 99999)).rejects.toThrow('conversation is unavailable')
  expect(f.host.skills).not.toHaveBeenCalled()
})

it('delegates project trust and host precedence to host.skills without separate project discovery', async () => {
  const f = await fixture()
  await writeSkill(
    join(f.projectRoot, '.ultimate/skills'),
    'untrusted-project',
    'Must not discover directly',
  )
  const shared = await writeSkill(f.sharedDirectory, 'safe-shared', 'Shared instructions')
  expect((await f.list()).map((skill) => skill.path)).toEqual([shared])
  expect(f.host.skills).toHaveBeenCalledWith(f.projectRoot)
})

it.each<JsonValue>([
  false,
  true,
  1,
  'source',
  [],
  [1],
  { cwd: '/arbitrary' },
  { source: 1, extra: true },
  { source: null },
  { source: '1' },
  { source: 0 },
  { source: -1 },
  { source: 1.5 },
  { source: Number.MAX_SAFE_INTEGER + 1 },
  { source: [] },
  { source: {} },
])('rejects invalid list arguments %j before inventory access', async (args) => {
  const f = await fixture()
  await expect(f.list(args)).rejects.toThrow('Skill picker expects')
  expect(f.host.skills).not.toHaveBeenCalled()
  expect(f.host.extensions).not.toHaveBeenCalled()
})

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid current conversation id %s',
  async (id) => {
    const f = await fixture()
    await expect(f.list(null, id)).rejects.toThrow('positive conversation id')
  },
)
