import type { ComposerSubmissionItem } from '../sdk/registry.ts'
import type { ComposerSubmissionInput } from '../sdk/types.ts'

/** Visible rather than silently choosing one extension's pending content over another's. */
export const composerSubmissionConflict =
  'Multiple extensions have pending composer content. Remove one batch before sending.'

/** An external-store snapshot is a count, so unchanged pending state cannot cause a render loop. */
export function createComposerSubmissionStore(
  items: readonly ComposerSubmissionItem[],
  conversationId: number | undefined,
) {
  const pending = () =>
    conversationId === undefined
      ? []
      : items.filter(({ contribution }) => contribution.pending(conversationId))
  return {
    subscribe: (listener: () => void) => {
      if (conversationId === undefined) return () => {}
      const disposers = items.map(({ contribution }) => contribution.subscribe(listener))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    getSnapshot: () => pending().length,
    async submit(
      input: ComposerSubmissionInput,
      normalSubmit: (input: ComposerSubmissionInput) => Promise<void>,
    ) {
      // Recheck at the click, not only at render: another tab or editor may have changed pending content.
      const selected = pending()
      if (selected.length > 1) throw new Error(composerSubmissionConflict)
      if (selected[0]) await selected[0].contribution.submit(input)
      else await normalSubmit(input)
    },
  }
}
