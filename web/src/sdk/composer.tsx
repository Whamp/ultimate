import { createContext, useContext } from 'react'
import type { KeyboardEvent } from 'react'

/** Local draft editor scope; providing it does not enable any submission transport. */
export const ComposerContext = createContext<{
  /** Inventory scope owned by this editor; null means project context, never the shown conversation. */
  conversationId?: number | null
  /** The editor owning these slots; absent outside a mounted composer. */
  editor?: ComposerEditor
  /** Text-only draft access; clear preserves edits made after the snapshot. */
  draft?: {
    read(): { text: string; revision: number }
    clear(snapshot: { text: string; revision: number }): void
  }
}>({})

/** The composer owning this toolbar or status contribution. */
export function useComposer() {
  return useContext(ComposerContext)
}

/** A UTF-16 range in the visible composer draft, with an exclusive end. */
export interface ComposerSelection {
  start: number
  end: number
}

/** IDs of the mounted suggestion list and its active option; focus remains in the textarea. */
export interface ComposerAutocomplete {
  listId: string
  activeOptionId?: string
}

/** Editing is local to this composer; replacing text never submits or changes attachments. */
export interface ComposerEditor {
  text: string
  selection: ComposerSelection
  focused: boolean
  composing: boolean
  readOnly: boolean
  /** Replace a draft range, focus the editor and put the caret after the inserted text. */
  replace: (range: ComposerSelection, text: string) => void
  /** Register while a control is mounted. Prevent default to claim a key before Send and shortcuts. */
  registerKeyHandler: (handler: (event: KeyboardEvent<HTMLTextAreaElement>) => void) => () => void
  /** Associate a mounted listbox with the textarea; cleanup removes only this registration. */
  registerAutocomplete: (autocomplete: ComposerAutocomplete) => () => void
}

/** The supported draft editor for this composer's slots, or null outside a composer. */
export function useComposerEditor() {
  return useContext(ComposerContext).editor ?? null
}
