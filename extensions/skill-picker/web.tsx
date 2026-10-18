import { useCallback, useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { Button } from '@/components/ui/button'
import {
  cn,
  defineWebExtension,
  errorMessage,
  useAction,
  useComposer,
  useComposerEditor,
} from '@/sdk'
import type { ComposerEditor } from '@/sdk'
import {
  findSkillQuery,
  rankSkillMatches,
  skillPickerRequest,
  skillReference,
} from './skill-picker-client.tsx'
import type { SkillPickerQuery } from './skill-picker-client.tsx'
import type { SkillPickerSkill } from './skill-picker-types.ts'

function SkillPicker() {
  const editor = useComposerEditor()
  const [dismissed, setDismissed] = useState<string>()
  const signature = editor ? JSON.stringify([editor.text, editor.selection]) : undefined
  // Escape dismisses this edit position, not a query the user may type again later.
  if (dismissed !== undefined && dismissed !== signature) setDismissed(undefined)
  if (!editor || !editor.focused || editor.composing || editor.readOnly) return null
  const query = findSkillQuery(editor.text, editor.selection)
  if (!query || dismissed === signature) return null
  return <SkillMenu editor={editor} query={query} dismiss={() => setDismissed(signature)} />
}

function SkillMenu({
  editor,
  query,
  dismiss,
}: {
  editor: ComposerEditor
  query: SkillPickerQuery
  dismiss: () => void
}) {
  const { conversationId } = useComposer()
  const request = skillPickerRequest(conversationId)
  const skills = useAction<SkillPickerSkill[]>('skill-picker', 'list', request.args, {
    conversationId: request.conversationId,
    // Errors belong in this menu, not in a second global notice.
    onError: () => {},
  })
  const id = useId()
  const [highlight, setHighlight] = useState({ query: query.query, index: 0 })
  const results = rankSkillMatches(skills.data ?? [], query.query)
  const index = Math.min(
    highlight.query === query.query ? highlight.index : 0,
    Math.max(0, results.length - 1),
  )
  const selected = results[index]
  const activeOptionId = selected ? `${id}-option-${index}` : undefined
  const registerAutocomplete = editor.registerAutocomplete
  const bindAutocomplete = useCallback(
    () => registerAutocomplete({ listId: id, activeOptionId }),
    [registerAutocomplete, id, activeOptionId],
  )

  function choose(skill: SkillPickerSkill) {
    editor.replace(query, skillReference(skill))
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return
    if (event.key === 'Escape') {
      event.preventDefault()
      dismiss()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (results.length)
        setHighlight({
          query: query.query,
          index: (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length,
        })
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      if (skills.error) void skills.refetch()
      else if (!skills.loading && selected) choose(selected)
    }
  }

  return (
    <div className="relative w-full">
      <div
        className="absolute inset-x-0 bottom-2 z-30 overflow-hidden rounded-lg border border-border/70 bg-popover text-popover-foreground shadow-lg"
        ref={() => editor.registerKeyHandler(onKeyDown)}
        onMouseDown={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          <span className="text-foreground/80">Skills</span>
          <span className="ml-auto">{results.length} matches</span>
        </div>
        {skills.loading ? (
          <div role="status" className="px-3 py-4 text-[12px] text-muted-foreground">
            Loading skills…
          </div>
        ) : skills.error ? (
          <div role="alert" className="space-y-2 px-3 py-3 text-[12px]">
            <p className="text-error">Could not load skills: {errorMessage(skills.error)}</p>
            <Button size="sm" variant="outline" onClick={() => void skills.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <div
            role="listbox"
            aria-label="Skills"
            id={id}
            ref={bindAutocomplete}
            className="max-h-[min(40vh,20rem)] overflow-y-auto p-1"
          >
            {results.length === 0 && (
              <div role="status" className="px-2 py-3 text-[12px] text-muted-foreground">
                No skills match “{query.query}”.
              </div>
            )}
            {results.map((skill, itemIndex) => (
              <div
                key={skill.path}
                role="option"
                id={`${id}-option-${itemIndex}`}
                aria-selected={itemIndex === index}
                ref={(element) => {
                  if (itemIndex === index) element?.scrollIntoView({ block: 'nearest' })
                }}
                className={cn(
                  'cursor-pointer rounded-md px-2 py-1.5',
                  itemIndex === index && 'bg-brand/10',
                )}
                onMouseMove={() => setHighlight({ query: query.query, index: itemIndex })}
                onClick={() => choose(skill)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'truncate font-mono text-[12px]',
                      itemIndex === index && 'text-brand',
                    )}
                  >
                    ${skill.name}
                  </span>
                  {skill.disableModelInvocation && (
                    <span
                      title="Available only when you select it explicitly"
                      className="ml-auto shrink-0 rounded border border-border/70 px-1 font-mono text-[10px] text-muted-foreground"
                    >
                      manual only
                    </span>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                  {skill.description || 'No description.'}
                </p>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> / <Kbd>tab</Kbd> {skills.error ? 'retry' : 'insert'}
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
          <span className="ml-auto">name + description</span>
        </div>
      </div>
    </div>
  )
}

export default defineWebExtension({
  slots: {
    'composer.attachments': { component: SkillPicker, order: -100 },
    'board.suggestions': { component: SkillPicker, order: -100 },
  },
})
