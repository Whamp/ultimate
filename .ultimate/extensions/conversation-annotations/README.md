Annotate selected agent/tool text and plan/task fields, collect comments above the composer, then send one explicit batch. Submitted user threads remain beside their sources; agent replies stay ordinary conversation entries.

## Use

1. Select text in a stored agent response, stored tool result, or plan/task field. Tap or click **Annotate** beside the selection. On a phone, moving the selection handles updates the quote before you tap.
2. Write beside the source and choose **Add to batch**. This does not send or interrupt the agent.
3. Repeat, edit the pending cards, or remove them. Add optional general text/images in the normal composer.
4. Use the normal Send, Steer, or Follow-up control once. The extension replaces plain submission only while this conversation has pending annotations.
5. Click a quiet purple source marker to see submitted user comments and add new feedback. A revisit sends the original quote, source location/fingerprint, ordered submitted comments, and new feedback. Full field snapshots stay in storage for drift detection; unselected source text is not sent. It never attributes an agent answer automatically.

Hovering a source marker previews its quote and last comment. Different views of a plan field share its owner/document/record/field identity. Selecting the same excerpt reopens its thread or updates its existing pending card; it does not create another thread merely because the view changed. Changed live fields show a notice; historical quotes are never silently rewritten. A source that is not currently loaded is reported as unavailable; this prototype does not automatically page older transcript history or navigate to a different source conversation.

## Supported visual context

- Hover a rendered table for **Annotate whole table**. Its text, including row and column order, is quoted as one block; the stored source snapshot is retained separately.
- A stored tool-result image has **Annotate image N**. Delivery resolves its actual stored bytes by owning conversation, stored result entry, stable tool call id, and image index. This is whole-image selection, not region selection. Revisited image threads include the image again.
- Arbitrary chart/canvas/iframe context is **not captured**. The extension does not pretend DOM text is equivalent to an image of such content.
- Editors, pending cards, composer fields and action controls are excluded from selection. Cross-source selections are rejected.

## Persistence and delivery

Accepted history and batches live in the conversation-scoped `conversation-annotations.history` durable document in Ultimate's central SQLite home. They are latest-only, not copied to forks. Acceptance validates the source owner, stored entry/tool identity, plan record, payload limits and expected thread revisions. Combined composer and stored-source images are limited to 10 images and 10 MiB; excess is rejected visibly, never omitted. A single transaction appends comments, saves an immutable receipt and creates a durable outbox task. There is no separate plain-submit/history-save window.

Immutable agent/tool snapshots must exactly match their stored text blocks joined with a newline, including an empty snapshot for image-only results. The quote remains client-selected rendered text, not an independently verified raw Markdown substring: rendered headings and tables can differ from the stored Markdown. Plan sources validate the record kind and supported field syntax, but historical snapshots are not compared with live field values or current note existence.

The outbox uses `conversation-annotations:<batch id>` as Pi's stable input request id. Repeated HTTP acceptance calls with the same id and payload return the existing receipt. A changed payload with that id is rejected. Delivery is shown as **accepted**, **delivered** (durably admitted to Pi's input queue, not necessarily answered), or **error**. Delivery errors expose **Retry delivery**, retaining the same input request id.

Pending cards are saved **synchronously to localStorage**, scoped by the exact project path and target conversation. They survive reload in the same browser, not site-data deletion, private-session deletion, another browser, or unavailable/full browser storage. Storage failure is surfaced; edits are not reported as saved. Use one editing tab per conversation: browser-local drafts are not a collaborative editor. Submitted-history revisions reject stale concurrent sends rather than overwrite earlier comments. If saved drafts cannot be read or validated, a visible error blocks edits and all composer sends, even with no cards. The original bytes are left unchanged: restore browser data or storage access, then reload. The extension never deletes invalid saved data automatically. Every pending-state write passes the same draft/batch decoders used on reload; rejected oversized edits or composer inputs leave the previous saved drafts unchanged.

The composer freezes the entire batch synchronously before its first await, including text, images and busy mode, and persists its stable id. An uncertain network response retains that exact frozen payload across reload. **Retry send** uses the normal composer path to confirm the same batch, never a newly generated id. Keep the general text/images unchanged until confirmation; changed input is rejected rather than silently substituted. Ordinary composer text/images are cleared only by the SDK's accepted submission path and revision guard. Comments edited while a request is in flight remain pending at the next thread revision. New general text is not silently substituted into an uncertain batch.

## Internal boundary

- `annotation-domain.ts`: explicit source/thread/comment/batch contracts, boundary validation, canonical source keys, whole-field matching, snapshot fingerprint and ordered prompt formatting. JSON document contracts use object aliases to remain compatible with Pi's `JsonObject` boundary.
- `server.ts`: validated actions, atomic acceptance and durable outbox.
- `annotation-drafts.ts`: local browser draft persistence, synchronous freezing and uncertain-send retry.
- `annotation-client.tsx`: SDK composer transport and shared browser draft stores.
- `annotation-sources.tsx`: stored-entry provenance and text/image selection without replacing core renderers.
- `connect-annotation-dom.ts`: native selection/table listeners, observed source mounts and connection-local cleanup, including queued scans. Pointer capture preserves the selected quote until click, including touch.
- `annotation-overlay.tsx`: React state, beside-source editor, source-marker portals and open-thread events.
- `annotation-cards.tsx`: editable composer cards and this extension's submitted-input cards.
- `web.tsx`: project-local contributions.

Source-owning conversation and delivery target are separate. Plan attributes are canonical `data-annotation-conversation/document/record/field/title/content` supplied by the built-in plan renderer; `content` is the raw field. Individual note fields use `notes:<timestamp>:<index>`. The extension depends on the generic SDK `composer.attachments` slot and `ComposerSubmissionContribution`, not on BB APIs or a duplicate SDK.

## Verification

`pnpm exec vitest run test/annotation-batches.test.ts test/annotation-drafts.test.ts` exercises real durable server actions, persistence/reopen, idempotent acceptance/delivery retry, ordered histories, conflict rollback, stored-image provenance, synchronous freezing, reload, edit retention and storage failure. Browser verification is required for selection, beside-source layout, plan/task views, batch send and markers.
