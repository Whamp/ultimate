import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  CompositionEvent,
  FocusEvent,
  KeyboardEvent,
  SyntheticEvent,
} from 'react'
import type { ComposerAutocomplete, ComposerEditor, ComposerSelection } from './composer.tsx'

/** Local textarea editing only: the owner keeps its draft, slots and send route. */
export function useComposerTextarea({
  text,
  read,
  update,
}: {
  text: string
  read: () => { text: string; readOnly: boolean }
  update: (text: string) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const pendingSelection = useRef<number | null>(null)
  const [selection, setSelection] = useState<ComposerSelection>({ start: 0, end: 0 })
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const [autocomplete, setAutocomplete] = useState<ComposerAutocomplete>()
  const registerAutocomplete = useMemo<ComposerEditor['registerAutocomplete']>(
    () => (next) => {
      setAutocomplete(next)
      return () => setAutocomplete((current) => (current === next ? undefined : current))
    },
    [],
  )
  const [keyHandlers] = useState(
    () => new Set<(event: KeyboardEvent<HTMLTextAreaElement>) => void>(),
  )
  const registerKeyHandler = useMemo<ComposerEditor['registerKeyHandler']>(
    () => (handler) => {
      keyHandlers.add(handler)
      return () => {
        keyHandlers.delete(handler)
      }
    },
    [keyHandlers],
  )
  // The DOM selection must follow React's controlled text commit, before the next paint.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const caret = pendingSelection.current
    if (caret !== null) {
      pendingSelection.current = null
      element.focus()
      element.setSelectionRange(caret, caret)
    }
    if (selection.start !== element.selectionStart || selection.end !== element.selectionEnd)
      setSelection({ start: element.selectionStart, end: element.selectionEnd })
  }, [text, selection])
  const select = (element: HTMLTextAreaElement) =>
    setSelection({ start: element.selectionStart, end: element.selectionEnd })
  const editor: ComposerEditor = {
    text,
    selection,
    focused,
    composing,
    readOnly: read().readOnly,
    registerKeyHandler,
    registerAutocomplete,
    replace: (range, inserted) => {
      const current = read()
      if (
        current.readOnly ||
        composing ||
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end > current.text.length
      )
        return
      const caret = range.start + inserted.length
      pendingSelection.current = caret
      update(current.text.slice(0, range.start) + inserted + current.text.slice(range.end))
      setSelection({ start: caret, end: caret })
    },
  }
  return {
    editor,
    textarea: {
      ref,
      'aria-autocomplete': autocomplete ? ('list' as const) : undefined,
      'aria-haspopup': autocomplete ? ('listbox' as const) : undefined,
      'aria-controls': autocomplete?.listId,
      'aria-activedescendant': autocomplete?.activeOptionId,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
        update(event.currentTarget.value)
        select(event.currentTarget)
      },
      onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => select(event.currentTarget),
      onFocus: (event: FocusEvent<HTMLTextAreaElement>) => {
        setFocused(true)
        select(event.currentTarget)
      },
      onBlur: () => setFocused(false),
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => {
        setComposing(false)
        select(event.currentTarget)
      },
    },
    /** Run before the owner's Send/shortcuts. True means a control or IME owns this key. */
    handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.defaultPrevented || composing || event.nativeEvent.isComposing) return true
      for (const handler of keyHandlers) {
        handler(event)
        if (event.defaultPrevented) return true
      }
      return false
    },
  }
}
