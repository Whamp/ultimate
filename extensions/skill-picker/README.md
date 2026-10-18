Type `$` at the start of the draft or after whitespace to find skills by name or description. The compact menu stays above the textarea in Board, Agent and dock views. Name matches rank before description matches; both support fuzzy subsequences (`$cr` finds `code-review`). Uppercase shell variables, currency, shell substitutions, escaped dollars, emails and Markdown code spans do not trigger the menu.

Use ↑/↓ to move, Enter or Tab to insert, and Escape to close without stopping a run. The focused textarea advertises the mounted listbox and its active option through ARIA; focus stays in the editor as selection changes. Dismissal, blur, composition, loading and error states remove stale option associations; an empty list has no active option. Mouse selection keeps focus in the editor. Composition and modified keys stay with the editor. Loading, empty and error states stay in the menu; Retry or Enter retries a failed list request. A `manual only` label means the skill can be selected explicitly but cannot be invoked automatically by the model.

Selection replaces only the active dollar query with visible Markdown, for example:

```md
Please [$code-review](/home/user/.agents/skills/code-review/SKILL.md) then check the tests.
```

The reference contains the exact skill path (Markdown destination delimiters are percent-escaped when necessary). It is ordinary draft text: selection never sends, does not alter images, and does not intercept composer submission or annotation transport. The existing draft persistence and steer/follow-up controls remain in charge.

The server `list` action supplies the selectable inventory. The editor provider owns inventory scope: Agent and dock supply their conversation ID; Board explicitly requests project inventory with `conversationId: null`, never the last shown Agent conversation. Read-only callers can also pass `{ source }` without a conversation ID to inspect a source workspace, or omit both to inspect the project context. Inventory and trust rules belong to the server, not the browser.

The UI uses the supported `useComposerEditor()` SDK seam, not DOM selectors or textarea listeners. Pure query, ranking, reference and context behavior is tested in `test/web/skill-picker.test.ts`. Browser checks must also exercise keyboard ordering, caret restoration, blur, composition, draft persistence, Board addressing and image preservation.

Upstream Board owns new conversations and roots. Its `board.suggestions` slot mounts only inline suggestions under a local editor provider. It does not mount conversation attachments, toolbar, status or pending submission transports. Board continues to send through `board.post`; completing a skill cannot submit or clear Agent drafts or pending annotations. This does not restore the retired manual new-conversation editor.
