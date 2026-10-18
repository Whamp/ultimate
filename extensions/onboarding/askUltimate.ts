import { api } from '@/sdk/index.ts'

/** Posting creates the standing conversation before addresses returns its id. */
export async function askUltimate(card: 'project' | 'git') {
  await api.action('board', 'post', {
    to: '@ultimate',
    text:
      card === 'project'
        ? "Help me decide whether to use this project's setup."
        : 'Help me set up git for this folder.',
  })
  const addresses = await api.action<{ agents: { name: string; id?: number }[] }>(
    'board',
    'addresses',
  )
  const id = addresses.agents.find((agent) => agent.name === 'ultimate')?.id
  if (id === undefined) throw new Error('@ultimate has no conversation')
  return id
}
