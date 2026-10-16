import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { formatSkillsForPrompt, getAgentDir, loadSkills } from '@earendil-works/pi-coding-agent'
import { defineExtension, wrapSection } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../../server/extensions.ts'

/** Add shared skills to the agent prompt without changing the host's skills inventory. */
export default function sharedSkills(
  host: Pick<ExtensionHost, 'userHome' | 'projectRoot' | 'skills' | 'notice'>,
) {
  const directory = join(host.userHome, '.agents/skills')
  let previousDiagnostics = new Set<string>()
  return defineExtension({
    name: 'shared-skills',
    wraps: [
      wrapSection('skills', (section) => ({
        ...section,
        render(input) {
          const cwd = input.env?.cwd ?? input.agent.cwd ?? host.projectRoot
          const shared = existsSync(directory)
            ? loadSkills({
                cwd,
                agentDir: getAgentDir(),
                skillPaths: [directory],
                includeDefaults: false,
              })
            : { skills: [], diagnostics: [] }
          const diagnostics = new Set(
            shared.diagnostics.map(
              (diagnostic) =>
                `shared-skills: ${diagnostic.path}: ${diagnostic.type}: ${diagnostic.message}`,
            ),
          )
          for (const message of diagnostics) {
            if (!previousDiagnostics.has(message)) host.notice(message)
          }
          previousDiagnostics = diagnostics
          // Merge before filtering: an existing user-only skill must also hide a shared namesake.
          const skills = new Map(
            [...shared.skills, ...host.skills(cwd)].map((skill) => [skill.name, skill]),
          )
          return formatSkillsForPrompt([...skills.values()])
        },
      })),
    ],
  })
}
