import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultReporter } from 'vitest/node'
import type { Vitest } from 'vitest/node'

export interface TurnUsage {
  model: string
  tokens: number
  cost: number
  wallMs: number
  unfinished?: boolean
}

declare module 'vitest' {
  interface ProvidedContext {
    evalUsageFile: string
    evalTraceFile: string
  }
}

export default class EvalReporter extends DefaultReporter {
  private directory = ''
  private usageFile = ''
  private started = 0

  onInit(ctx: Vitest) {
    super.onInit(ctx)
    this.directory = mkdtempSync(join(tmpdir(), 'ultimate-eval-usage-'))
    this.usageFile = join(this.directory, 'turns.jsonl')
    writeFileSync(this.usageFile, '')
    ctx.provide('evalUsageFile', this.usageFile)
    const traceFile = join(this.directory, 'traces.jsonl')
    writeFileSync(traceFile, '')
    ctx.provide('evalTraceFile', traceFile)
    process.stdout.write(`Eval evidence: ${this.directory}\n`)
    this.started = performance.now()
  }

  async onTestRunEnd(...args: Parameters<DefaultReporter['onTestRunEnd']>) {
    super.onTestRunEnd(...args)
    const turns = (await readFile(this.usageFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TurnUsage)
    const tokens = turns.reduce((sum, turn) => sum + turn.tokens, 0)
    const cost = turns.reduce((sum, turn) => sum + turn.cost, 0)
    const turnMs = turns.reduce((sum, turn) => sum + turn.wallMs, 0)
    const models = [...new Set(turns.map((turn) => turn.model))].join(', ')
    process.stdout.write(
      `Eval timing: ${((performance.now() - this.started) / 1000).toFixed(1)}s elapsed · ${(turnMs / 1000).toFixed(1)}s summed turn time\n`,
    )
    process.stdout.write(
      `Evals: ${turns.length} turns · ${tokens.toLocaleString('en-US')} tokens · $${cost.toFixed(2)} · ${models || 'no model turns'}\n`,
    )
    process.stdout.write(
      `Usage includes ${turns.filter((turn) => turn.unfinished).length} unfinished fixture turns' recorded responses. Excludes in-flight provider usage, tool-internal model calls, and calls lost before recording. Full turn traces and usage retained in ${this.directory}\n`,
    )
  }
}
