import type { ComposerSelection, ComposerTarget } from '@/sdk'

import type { SkillPickerSkill } from './skill-picker-types.ts'

/** An eligible dollar query ends at the caret, not at the end of the draft. */
export interface SkillPickerQuery extends ComposerSelection {
  query: string
}

/** Ignore shell/currency syntax, escaped dollars, emails and Markdown code spans. */
export function findSkillQuery(
  text: string,
  selection: ComposerSelection,
): SkillPickerQuery | null {
  if (
    selection.start !== selection.end ||
    !Number.isInteger(selection.start) ||
    selection.start < 0 ||
    selection.end > text.length
  )
    return null
  const prefix = text.slice(0, selection.start)
  const match = /(?:^|\s)\$([a-z][a-z0-9-]*|)$/.exec(prefix)
  if (!match || /[\w{(]/.test(text[selection.start] ?? '')) return null
  const start = selection.start - match[1].length - 1
  let delimiter = 0
  for (const ticks of text.slice(0, start).matchAll(/(?<!\\)`+/g)) {
    if (delimiter === 0) delimiter = ticks[0].length
    else if (delimiter === ticks[0].length) delimiter = 0
  }
  if (delimiter !== 0) return null
  return { start, end: selection.end, query: match[1] }
}

function subsequenceScore(query: string, text: string): number | null {
  const haystack = text.toLowerCase()
  let previous = -1
  let gaps = 0
  for (const character of query) {
    const next = haystack.indexOf(character, previous + 1)
    if (next < 0) return null
    gaps += next - previous - 1
    previous = next
  }
  return gaps
}

function compareSkillText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Fuzzy subsequences in names outrank descriptions; ties use stable code-point name/path order. */
export function rankSkillMatches(
  skills: readonly SkillPickerSkill[],
  query: string,
): SkillPickerSkill[] {
  const needle = query.toLowerCase()
  const ranked = skills.flatMap((skill) => {
    const name = subsequenceScore(needle, skill.name)
    const description = name === null ? subsequenceScore(needle, skill.description) : null
    if (name === null && description === null) return []
    return [{ skill, group: name === null ? 1 : 0, score: name ?? description ?? 0 }]
  })
  return ranked
    .toSorted(
      (a, b) =>
        a.group - b.group ||
        a.score - b.score ||
        compareSkillText(a.skill.name, b.skill.name) ||
        compareSkillText(a.skill.path, b.skill.path),
    )
    .map(({ skill }) => skill)
}

/** Visible Markdown carries the exact path; encode only characters Markdown cannot carry literally in a destination. */
export function skillReference(skill: SkillPickerSkill): string {
  const name = skill.name.replace(/[\\[\]]/g, '\\$&')
  const path = skill.path.replace(/[%<>\r\n]/g, (character) => encodeURIComponent(character))
  return `[$${name}](<${path}>) `
}

/** New composers must not inherit the shown conversation's cwd; null explicitly requests project context. */
export function skillPickerRequest(
  target: ComposerTarget,
  conversationId?: number,
  source?: number,
) {
  if (target === 'conversation') return { args: null, conversationId: conversationId ?? null }
  return { args: source === undefined ? null : { source }, conversationId: null }
}
