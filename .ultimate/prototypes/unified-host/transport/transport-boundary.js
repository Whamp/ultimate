/** @typedef {import('./types.ts').TransportReady} TransportReady */
/** @typedef {import('./types.ts').TransportProject} TransportProject */
/** @typedef {import('./types.ts').TransportPreview} TransportPreview */

// TS-48 exception, limited to the JSON type guards in this file: untrusted HTTP and child
// JSON have no runtime schema. Primitive checks are required to reject malformed IDs,
// process IDs and filesystem paths before use. No application/platform typeof checks.
// No schema dependency or production lint configuration is needed for this experiment.

/** @param {string} text @returns {TransportReady} Decodes a child receipt or throws before use. */
export function decodeTransportReady(text) {
  /** @type {unknown} */
  const value = JSON.parse(text)
  if (!isTransportReady(value)) {
    throw new Error('Invalid transport readiness JSON')
  }
  return value
}

/** @param {string} text @returns {TransportProject[]} Decodes both fixed project identities. */
export function decodeTransportProjects(text) {
  /** @type {unknown} */
  const value = JSON.parse(text)
  if (!isTransportProjects(value)) {
    throw new Error('Invalid transport projects JSON')
  }
  return value
}

/** @param {string} text @returns {TransportPreview} Decodes launcher stdout for lifecycle tests. */
export function decodeTransportPreview(text) {
  /** @type {unknown} */
  const value = JSON.parse(text)
  if (!isTransportPreview(value)) {
    throw new Error('Invalid transport preview JSON')
  }
  return value
}

/** @param {string} text */
function isLoopbackOrigin(text) {
  if (!URL.canParse(text)) {
    return false
  }
  const url = new URL(text)
  return (
    url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && url.origin === text
  )
}

/** @param {unknown} value @returns {value is TransportReady} */
function isTransportReady(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    'url' in value &&
    typeof value.url === 'string' &&
    isLoopbackOrigin(value.url) &&
    'root' in value &&
    typeof value.root === 'number' &&
    Number.isSafeInteger(value.root) &&
    value.root > 0
  )
}

/** @param {unknown} value @returns {value is TransportProject} */
function isTransportProject(value) {
  return (
    isTransportReady(value) &&
    'id' in value &&
    (value.id === 'alpha' || value.id === 'beta') &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    'projectRoot' in value &&
    typeof value.projectRoot === 'string' &&
    value.projectRoot.startsWith('/') &&
    !value.projectRoot.includes('\0') &&
    'userHome' in value &&
    typeof value.userHome === 'string' &&
    value.userHome.startsWith('/') &&
    !value.userHome.includes('\0')
  )
}

/** @param {unknown} value @returns {value is TransportProject[]} */
function isTransportProjects(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(isTransportProject) &&
    new Set(value.map((project) => project.id)).size === 2
  )
}

/** @param {unknown} value @returns {value is TransportPreview} */
function isTransportPreview(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    'url' in value &&
    typeof value.url === 'string' &&
    isLoopbackOrigin(value.url) &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    'directory' in value &&
    typeof value.directory === 'string' &&
    value.directory.startsWith('/') &&
    !value.directory.includes('\0') &&
    'projects' in value &&
    isTransportProjects(value.projects)
  )
}
