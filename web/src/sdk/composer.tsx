import type { ConfigureRequest } from '../../../shared/protocol.ts'
import { createContext, useContext } from 'react'
import type { KeyboardEvent } from 'react'
import { api } from './client.ts'
import { getState, useAction, useConversation, useExtensions, useUiState } from './hooks.ts'

export type ComposerTarget = 'conversation' | 'new'
export type NewConversationChoices = {
  model?: NonNullable<ConfigureRequest['model']>
  thinkingLevel?: ConfigureRequest['thinkingLevel']
}
export const newConversationKey = 'ultimate.newConversation'
/**
 * The configuration used by new-target controls and validation: the user's choices over the defaults of `source`, the
 * conversation a branch starts from. Without a source (a new root) the defaults are the project's, conversation 1's.
 */
export function useNewConversationConfiguration(enabled = true, source?: number) {
  const [choices] = useUiState<NewConversationChoices>(newConversationKey, {})
  const shown = useConversation()
  const available = useExtensions().some((extension) => extension.name === 'models')
  const live = shown.id === (source ?? 1)
  const fetched = useAction<NewConversationChoices>(
    'models',
    'defaultConfiguration',
    source === undefined ? null : { id: source },
    { enabled: enabled && available && !live },
  )
  const defaults = live ? shown.agent : fetched.data
  return {
    configuration: {
      model: choices.model ?? defaults?.model,
      thinkingLevel: choices.thinkingLevel ?? defaults?.thinkingLevel,
    },
    available,
    loading: enabled && available && (shown.loading || (!live && fetched.loading)),
    error: fetched.error,
  }
}

/** Commands read the same defaults freshly, without depending on the shown conversation. */
export async function getNewConversationConfiguration(source?: number) {
  const defaults = await api.action<NewConversationChoices>(
    'models',
    'defaultConfiguration',
    source === undefined ? null : { id: source },
  )
  const choices = (getState().shared?.[newConversationKey] ?? {}) as NewConversationChoices
  return {
    model: choices.model ?? defaults.model,
    thinkingLevel: choices.thinkingLevel ?? defaults.thinkingLevel,
  }
}

export const ComposerContext = createContext<{
  target: ComposerTarget
  isolated?: boolean
  /** The conversation a new branch starts from; absent for a new root. */
  source?: number
  /** The editor owning these slots; absent outside a mounted composer. */
  editor?: ComposerEditor
}>({
  target: 'conversation',
})

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

/** The composer owning this toolbar or status contribution. */
export function useComposer() {
  return useContext(ComposerContext)
}
