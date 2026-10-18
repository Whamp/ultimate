import type {
  DurableObjectId,
  DurableObjectState,
  SqlStorageValue,
} from '@cloudflare/workers-types'

/** Only the state operations used by the replica's constructor and hibernating socket callbacks. */
export interface ReplicaStateFixture extends Pick<
  DurableObjectState,
  'getWebSockets' | 'waitUntil'
> {
  id: Pick<DurableObjectId, 'toString'>
  storage: {
    sql: {
      exec<T extends Record<string, SqlStorageValue>>(
        query: string,
        ...bindings: (string | number | null)[]
      ): Iterable<T>
    }
    transactionSync<T>(run: () => T): T
  }
}

/** Presence publishes to this directory binding; this test does not route HTTP or upload builds. */
export interface ReplicaEnvFixture {
  MACHINE_ORIGIN: string
  DIRECTORY: {
    idFromName(name: string): DurableObjectId
    get(id: DurableObjectId): {
      fetch(
        input: string,
        init?: { method?: string; body?: string },
      ): Promise<Pick<Response, 'ok' | 'status'>>
    }
  }
}

function hasReplicaBindingKey<T extends object>(target: T, key: PropertyKey): key is keyof T {
  return key in target
}

/** Missing platform members must fail at use, rather than silently succeeding with undefined. */
export function strictReplicaBinding<T extends object>(binding: T): T {
  return new Proxy(binding, {
    get(target, key) {
      if (!hasReplicaBindingKey(target, key)) {
        throw new Error(`Unexpected replica binding member: ${String(key)}`)
      }
      return target[key]
    },
  })
}
