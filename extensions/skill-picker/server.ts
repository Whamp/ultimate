import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { getAgentDir, loadSkills } from '@earendil-works/pi-coding-agent'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ActionContext, ExtensionAction } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { WorkspaceService } from '../workspaces/server.ts'
import type { SkillPickerSkill } from './skill-picker-types.ts'

type SkillPickerHost = Pick<
  ExtensionHost,
  'userHome' | 'projectRoot' | 'skills' | 'extensions' | 'harness'
> & {
  use(name: 'workspaces'): Pick<WorkspaceService, 'get'> | undefined
}
type SkillPickerContext = Pick<ActionContext, 'conversationId'> & { host: SkillPickerHost }

function sourceId(args: JsonValue) {
  if (args === null) return undefined
  if (
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => key !== 'source') ||
    (args.source !== undefined &&
      (typeof args.source !== 'number' || !Number.isSafeInteger(args.source) || args.source < 1))
  ) {
    throw new Error('Skill picker expects null or an object with a positive source conversation id')
  }
  return args.source
}

async function skillCwd(host: SkillPickerHost, id: number | undefined) {
  if (id === undefined) return host.projectRoot
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('Skill picker requires a positive conversation id')
  }
  // SAFETY: conversation ids are positive safe integers, checked above at the action boundary.
  const conversationId = id as ConversationId
  const conversation = await host.harness().conversation(conversationId, context)
  if (!conversation) throw new Error('Skill picker conversation is unavailable')
  const workspace = await host.use('workspaces')?.get(conversationId, context)
  if (workspace && workspace.state !== 'ready') {
    throw new Error('Skill picker requires an active, ready workspace')
  }
  const cwd = workspace?.path ?? (await conversation.agent(context)).cwd ?? host.projectRoot
  // A removed checkout must not silently select skills from the host project, even without workspaces loaded.
  if (!(await stat(cwd)).isDirectory())
    throw new Error('Skill picker working directory is unavailable')
  return cwd
}

/** Read the current skill inventory without changing trust, settings, or skill invocation permissions. */
export const actions = {
  async list(
    args: JsonValue,
    { host, conversationId }: SkillPickerContext,
  ): Promise<SkillPickerSkill[]> {
    const source = sourceId(args)
    const cwd = await skillCwd(host, conversationId ?? source)
    const directory = join(host.userHome, '.agents/skills')
    const sharedEnabled = host
      .extensions()
      .some(
        (extension) =>
          extension.name === 'shared-skills' && extension.enabled && extension.server?.loadedAt,
      )
    const shared =
      sharedEnabled && existsSync(directory)
        ? loadSkills({
            cwd,
            agentDir: getAgentDir(),
            skillPaths: [directory],
            includeDefaults: false,
          }).skills
        : []
    // Merge before any presentation: a host manual-only override also wins over a shared namesake.
    const skills = new Map([...shared, ...host.skills(cwd)].map((skill) => [skill.name, skill]))
    return [...skills.values()].map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
    }))
  },
} satisfies Record<string, ExtensionAction>

/** Built-in read-only inventory used by the skill picker composer extension. */
export default function skillPicker() {
  return defineExtension({ name: 'skill-picker' })
}
