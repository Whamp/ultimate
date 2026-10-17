/** A real child runtime's readiness receipt; its origin must be literal loopback HTTP. */
export interface TransportReady {
  url: string
  root: number
}

/** Fixed child runtime identity, decoded before a consumer uses process IDs or paths. */
export interface TransportProject extends TransportReady {
  id: string
  pid: number
  projectRoot: string
  userHome: string
}

/** Launcher stdout receipt; owns the temporary directory and the two listed child runtimes. */
export interface TransportPreview {
  url: string
  pid: number
  directory: string
  projects: TransportProject[]
}
