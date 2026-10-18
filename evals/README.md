# Agent evals

Run `pnpm eval` explicitly; `pnpm test` does not discover these files.
Pi's normal shared auth supplies OpenAI; no credentials are copied into fixtures.
The default is `openai/gpt-6-luna` with `high` thinking.
Override with `ULTIMATE_EVAL_MODEL` and `ULTIMATE_EVAL_THINKING`.
Write a `*.eval.ts` file under `evals/`, using Vitest and `./fixture.ts`.
Call `start({ project: { files, git }, extensions: { enable, disable } })`.
Create a conversation with `conversation({ history: [user(...), assistant(...)] })`.
Attach to an action-created conversation with `conversation({ id })`; it uses the selected eval model.
List conversations with `await ultimate.conversations()` (a snapshot from the existing HTTP event stream).
The fixture runs a fixed base set (the coding agent without workspaces, conversations, status line, browser or faux); `enable` adds extensions to it, so each eval loads only what it measures.
Use `assistant('', [toolCall])` and `toolResult(id, name, text, isError)` for tool history.
Seeds append actual Durable entries without running a model.
Call `c.run(input)` to submit through HTTP and wait for idle; call it again to continue.
Assert on `turn.text`, `turn.toolCalls`, files, git, or extension HTTP actions.
Use `ultimate.file`, `ultimate.exec`, and `ultimate.action` to inspect outcomes.
Always `await ultimate.stop()` in `finally`; every test gets temporary project, config, and state.
Eval files run in parallel (up to four workers), with up to four concurrent tests per file.
Fixtures use separate temporary directories and ephemeral ports; turns within a conversation remain sequential.
Each measured turn prints wall time and model usage, excluding seeded history usage.
The reporter collects usage across workers, including turns whose assertions fail.
After Vitest's results, it prints elapsed and summed turn time (a sequential-time comparison,
not a separate sequential run), then ends with one total cost line:
`Evals: 14 turns · 345,000 tokens · $0.42 · openai/gpt-6-luna`.
Totals cover fixture conversation turns, not background summaries or delegated subagent usage.
The reporter prints an evidence directory retaining `turns.jsonl` usage and `traces.jsonl`
full turns (including actual tool arguments/results), even on assertion failures.
Failed scenarios print recorded tool arguments/results. Unfinished turns include only responses
already recorded; in-flight provider usage, tool-internal model calls, and calls lost before recording
are excluded.
Turns share a 270-second active test budget, with a 240-second per-turn cap inside the
unchanged 300-second outer test ceiling; the remaining 30 seconds are for diagnostics/cleanup.

E1 separates ledger contracts: `test/plan.test.ts` exercises real create/add/update tools
with fixed calls and asserts roles, dependencies, statuses and persistence across reopen.
The real-model eval starts with a neutral turn, then seeds the durable `Plan` through a
harness transaction, without putting task values in conversation history. Its later no-tool
answer must give the exact task key/title/status/dependency records from the refreshed
compact ledger. Roles are checked in persisted state, not in that answer: the compact
prompt does not expose roles. The JSON oracle tolerates record order and code fences,
not wrong task/status associations or a missing/reversed prerequisite relation.
This isolates later model visibility from model choice of planning arguments; it does not
prove model variance eliminated or turn an omitted argument into a persistence defect.

Prefer evals for tool choice and completing user requests, not exact wording.
Keep faux tests for crashes, races, storage, durability, and process semantics.
