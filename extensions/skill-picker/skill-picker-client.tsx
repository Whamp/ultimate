import type { ComposerSelection } from '@/sdk'

import type { SkillPickerSkill } from './skill-picker-types.ts'

/** An eligible dollar query ends at the caret, not at the end of the draft. */
export interface SkillPickerQuery extends ComposerSelection {
  query: string
}

// Scan only the draft through the caret: unfinished code must stay literal while typing.
function inMarkdownCode(prefix: string): boolean {
  let fence = ''
  let inlineDelimiter = 0
  let paragraph = false
  let indentedCode = false
  for (const line of prefix.split(/\r\n?|\n/)) {
    if (fence) {
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1]
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) {
        fence = ''
      }
      continue
    }
    if (/^[ \t]*$/.test(line)) {
      paragraph = false
      inlineDelimiter = 0
      continue
    }
    // Indentation cannot interrupt an existing prose paragraph.
    indentedCode = !paragraph && /^(?: {4}| {0,3}\t)/.test(line)
    if (indentedCode) {
      continue
    }
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (opener && (opener[1][0] === '~' || !opener[2].includes('`'))) {
      fence = opener[1]
      paragraph = false
      inlineDelimiter = 0
      continue
    }
    if (!paragraph) {
      inlineDelimiter = 0
    }
    // ATX headings end at the newline; they do not start a continuing paragraph.
    paragraph = !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)
    for (const ticks of line.matchAll(/(?<!\\)`+/g)) {
      if (inlineDelimiter === 0) {
        inlineDelimiter = ticks[0].length
      } else if (inlineDelimiter === ticks[0].length) {
        inlineDelimiter = 0
      }
    }
  }
  return fence !== '' || indentedCode || inlineDelimiter !== 0
}

/** Ignore shell/currency syntax, escaped dollars, emails and Markdown code. */
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
  if (inMarkdownCode(prefix)) return null
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
  target: 'conversation' | 'new',
  conversationId?: number,
  source?: number,
) {
  if (target === 'conversation') return { args: null, conversationId: conversationId ?? null }
  return { args: source === undefined ? null : { source }, conversationId: null }
}
