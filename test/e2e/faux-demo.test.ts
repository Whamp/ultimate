import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { Board } from '../../extensions/board/server.ts'
import { BoardQuestions } from '../../extensions/questions/server.ts'
import { Workspaces } from '../../extensions/workspaces/workspaces.ts'
import { context } from '../../server/harness.ts'
import { post, seedTally, sourceCopy, temp, until } from '../helpers.ts'
import { fauxDemoServer, fauxWorkspaceDemo } from '../test-utils/faux-demo-fixture.ts'

it('sends the questions demo to the Board and extracts the two decisions', async () => {
  const home = await temp('ultimate-faux-questions-demo-')
  const ultimateRoot = await sourceCopy(home)
  const server = await fauxDemoServer({ ultimateRoot, home, userHome: home })
  await (
    await server.root.submit({ type: 'input', content: 'questions demo' }, context)
  ).wait(context)
  await until(
    async () =>
      Object.keys(
        (await server.harness.snapshot(BoardQuestions, ROOT_CONVERSATION_ID, context))?.asked ?? {},
      ).length === 1,
  )
  const message = (await server.harness.snapshot(Board, ROOT_CONVERSATION_ID, context))!.messages[0]
  expect(message).toMatchObject({ from: 1, to: 'user', reply: true, state: 'delivered' })
  const questions = (await server.harness.snapshot(BoardQuestions, ROOT_CONVERSATION_ID, context))!
    .asked[String(message.id)]
  expect(questions.map((question) => question.text)).toEqual([
    'Should we keep the preview running?',
    'Which layout should we use?',
  ])
  const view = await server.root.viewState(context)
  expect(
    view.value.entries.findLast((entry) => entry.model?.[0]?.role === 'assistant')?.model?.[0],
  ).toMatchObject({
    role: 'assistant',
    content: [{ type: 'text', text: 'Sent.' }],
  })
  view.dispose()
  const reply = await post(server, '/api/extensions/questions/actions/answer', {
    args: { messageId: message.id, answers: [{ question: questions[0].text, answer: 'Yes' }] },
  })
  expect(reply.status).toBe(200)
  const log = (await server.harness.snapshot(Board, ROOT_CONVERSATION_ID, context))!
  expect(log.messages.find((item) => item.id === reply.data.result.id)).toMatchObject({
    from: 'user',
    to: 1,
    re: message.id,
    text: 'Q: Should we keep the preview running?\nA: Yes',
  })
  expect(log.messages.find((item) => item.id === message.id)?.state).toBe('answered')
  await server.root.waitForIdle(context)
})

it("asks the two decisions in @ultimate's final answer and takes the card's answers as typed input", async () => {
  const home = await temp('ultimate-faux-ask-demo-')
  const ultimateRoot = await sourceCopy(home)
  const server = await fauxDemoServer({ ultimateRoot, home, userHome: home })
  const id = (
    await post(server, '/api/extensions/subagents/actions/standing', { args: { name: 'ultimate' } })
  ).data.result as ConversationId
  const ultimate = (await server.harness.conversation(id, context))!
  const asked = await (
    await ultimate.submit({ type: 'input', content: 'ask demo' }, context)
  ).wait(context)
  await until(
    async () =>
      (await server.harness.snapshot(BoardQuestions, ROOT_CONVERSATION_ID, context))?.reply
        ?.entry === asked.answer,
  )
  const { questions } = (await server.harness.snapshot(
    BoardQuestions,
    ROOT_CONVERSATION_ID,
    context,
  ))!.reply!
  expect(questions.map((question) => question.text)).toEqual([
    'Should we keep the preview running?',
    'Which layout should we use?',
  ])
  const reply = await post(server, '/api/extensions/questions/actions/reply', {
    args: { entryId: asked.answer, answers: [{ question: questions[1].text, answer: 'Compact' }] },
  })
  expect(reply.status).toBe(200)
  await server.root.waitForIdle(context)
  const view = await ultimate.viewState(context)
  expect(
    view.value.entries.filter((entry) => entry.kind === 'pi.user').map((e) => e.model?.[0]),
  ).toMatchObject([
    { content: 'ask demo' },
    { content: 'Q: Which layout should we use?\nA: Compact' },
  ])
  view.dispose()
})
it('submits the workspace from the faux demo with a divergence, so the lander queues it', async () => {
  const server = await fauxWorkspaceDemo()
  await seedTally(server.harness)
  const { data } = await post(server, '/api/extensions/lineage/actions/branch', {
    args: { from: 1, prompt: 'submit workspace', isolated: true },
  })
  const id = data.result.id as ConversationId
  const submitted = async () => {
    const index = await server.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
    return [...(index?.queue ?? []), ...Object.values(index?.results ?? {})].find(
      (item) => item.conversationId === id,
    )
  }
  await until(async () => (await submitted()) !== undefined)
  expect((await submitted())?.divergence).toBe('None')
})
