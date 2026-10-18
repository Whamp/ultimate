import type { WebSocket as MachineSocket } from '@cloudflare/workers-types'

/** A complete Worker socket surface; tests override only the events they observe, without type erasure. */
export function replicaSocket<T extends Partial<MachineSocket>>(overrides: T) {
  let attachment: unknown
  const socket: MachineSocket = {
    readyState: WebSocket.OPEN,
    url: null,
    protocol: null,
    extensions: null,
    binaryType: 'arraybuffer',
    accept() {},
    send() {},
    close() {},
    serializeAttachment(value: unknown) {
      attachment = value
    },
    deserializeAttachment() {
      return attachment
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true
    },
  }
  return Object.assign(socket, overrides)
}
