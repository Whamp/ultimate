import { expect, it } from 'vitest'
import { strictReplicaBinding } from './strictReplicaBinding.ts'

it('forwards provided string and symbol members without changing their values', () => {
  const symbol = Symbol('replica socket')
  const socket = { connected: true }
  const binding = strictReplicaBinding({ count: 0, optional: undefined, [symbol]: socket })

  expect(binding.count).toBe(0)
  expect(binding.optional).toBeUndefined()
  expect(binding[symbol]).toBe(socket)
})

it('rejects a missing string member instead of returning undefined', () => {
  const binding = strictReplicaBinding({ count: 0 })

  // @ts-expect-error Deliberately read outside the fixture contract to verify strict missing-member failure.
  expect(() => binding.missing).toThrow('Unexpected replica binding member: missing')
})

it('rejects a missing symbol member instead of returning undefined', () => {
  const binding = strictReplicaBinding({ count: 0 })
  const missing = Symbol('missing')

  // @ts-expect-error Deliberately read outside the fixture contract to verify strict missing-member failure.
  expect(() => binding[missing]).toThrow('Unexpected replica binding member: Symbol(missing)')
})
