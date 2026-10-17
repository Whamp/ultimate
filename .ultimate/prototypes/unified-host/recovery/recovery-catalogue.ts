import { createHash } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { JsonRepresentation } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai'
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  Harness,
} from '@earendil-works/pi-durable'
import type { TaskId } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

type ProvisionStatus =
  | { status: 'provisioning' }
  | { status: 'ready' }
  | { status: 'failed'; error: string }
interface ProjectRecord {
  path: string
  effectPath: string
  taskId: TaskId<null>
  provision: ProvisionStatus
}
interface ProvisionInput {
  path: string
  effectPath: string
}
interface RecoveryOptions {
  home: string
  // Returning from this hook permits the checkpoint; tests can hold it until SIGKILL.
  afterEffect?: (input: ProvisionInput) => Promise<void>
  // A real dependency seam for the non-idempotent replay counterfeit.
  effect?: (input: ProvisionInput) => Promise<void>
}

// Pi documents require structurally JSON-compatible records; retain the branded task IDs.
const CATALOGUE = defineDoc<{ projects: JsonRepresentation<ProjectRecord>[] }>({
  kind: 'prototype.recovery.catalogue',
  version: 1,
  scope: 'session',
  initial: () => ({ projects: [] }),
})

function provisionError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error(`Recovery effect failed: ${String(cause)}`, { cause })
}

async function ensureProjectEffect(input: ProvisionInput) {
  try {
    await mkdir(input.effectPath)
  } catch (cause) {
    const error = provisionError(cause)
    if (!('code' in error) || error.code !== 'EEXIST') {
      throw error
    }
    // Only an existing directory satisfies this deliberately narrow effect contract.
    if (!(await stat(input.effectPath)).isDirectory()) {
      throw new Error('Recovery effect path is not a directory', { cause })
    }
  }
}

function defineProvisionTask(options: RecoveryOptions) {
  return defineTask<ProvisionInput, { phase: 'provision' }, null>({
    name: 'prototype.recovery.provision',
    version: 1,
    initial: () => ({ phase: 'provision' }),
    phases: {
      provision: async (task, runtime, context) => {
        let failure: string | undefined
        try {
          await (options.effect ?? ensureProjectEffect)(task.input)
        } catch (cause) {
          failure = provisionError(cause).message
        }
        if (failure === undefined) {
          await options.afterEffect?.(task.input)
        }
        await runtime.commit(async (tx) => {
          const catalogue = await tx.doc(CATALOGUE)
          const project = catalogue.projects.find((item) => item.taskId === task.id)
          if (!project) {
            throw new Error('Recovery catalogue lost its provisioning record')
          }
          if (failure !== undefined) {
            project.provision = { status: 'failed', error: failure }
            return {
              status: 'terminal',
              outcome: { status: 'failed', error: { message: failure } },
            }
          }
          project.provision = { status: 'ready' }
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, context)
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const catalogue = await tx.doc(CATALOGUE)
        const project = catalogue.projects.find((item) => item.taskId === task.id)
        if (project) {
          project.provision = { status: 'failed', error: 'Provisioning aborted' }
        }
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context)
    },
  })
}

/** Opens a single-owner temporary catalogue; never submits input or installs model providers. */
export async function openRecoveryCatalogue(options: RecoveryOptions) {
  const provisionProject = defineProvisionTask(options)
  const registry = createRegistry()
  registry.install(defineExtension({ name: 'prototype.recovery', tasks: [provisionProject] }))
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(options.home, 'catalogue.sqlite')),
    { models: createModels(), registry },
    BACKGROUND_CONTEXT,
  )
  const root = await harness.root(BACKGROUND_CONTEXT)

  return {
    harness,
    async registerProject(requestPath: string) {
      // Resolve aliases before entering the commit; the document read/decision/task creation is atomic.
      const path = await realpath(requestPath)
      const effectPath = join(
        options.home,
        'effects',
        createHash('sha256').update(path).digest('hex'),
      )
      return root.commit(async (tx) => {
        const catalogue = await tx.doc(CATALOGUE)
        const existing = catalogue.projects.find((item) => item.path === path)
        if (existing) {
          return existing.taskId
        }
        const taskId = await tx.createTask(
          provisionProject,
          { path, effectPath },
          {
            ownership: { kind: 'conversation' },
          },
        )
        catalogue.projects.push({ path, effectPath, taskId, provision: { status: 'provisioning' } })
        return taskId
      }, BACKGROUND_CONTEXT)
    },
    async snapshotProjects() {
      return (await harness.snapshot(CATALOGUE, BACKGROUND_CONTEXT))?.projects ?? []
    },
    async close() {
      await harness.close(BACKGROUND_CONTEXT)
    },
  }
}
