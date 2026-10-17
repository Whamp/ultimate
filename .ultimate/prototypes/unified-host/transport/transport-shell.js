/** @param {string} id */
function element(id) {
  const node = document.getElementById(id)
  if (!node) {
    throw new Error(`Transport shell element missing: ${id}`)
  }
  return node
}

const selector = element('project')
const direct = element('direct')
const prefix = element('prefix')
if (
  !(selector instanceof HTMLSelectElement) ||
  !(direct instanceof HTMLAnchorElement) ||
  !(prefix instanceof HTMLAnchorElement)
) {
  throw new Error('Transport shell controls have invalid types')
}

/** @type {EventSource[]} */
const streams = []
try {
  const response = await fetch('/projects')
  if (!response.ok) {
    throw new Error(`Project list failed: ${response.status}`)
  }
  /** @type {import('./transport-gateway.ts').TransportProject[]} */
  const projects = await response.json()
  const controls = { selector, direct, prefix }
  /** @type {Map<string, HTMLIFrameElement>} */
  const frames = new Map()
  for (const project of projects) {
    const option = new Option(
      project.id === 'alpha' ? 'Alpha · project A' : 'Beta · project B',
      project.id,
    )
    selector.add(option)
    const frame = document.createElement('iframe')
    frame.title = `Actual Ultimate · ${project.id}`
    frame.src = project.url
    frame.hidden = true
    element('frames').append(frame)
    frames.set(project.id, frame)
    const stream = new EventSource(`/p/${project.id}/api/events?conversation=${project.root}`)
    streams.push(stream)
    let count = 0
    let state = 'Connected'
    const card = element(`${project.id}-status`).querySelector('p')
    if (!card) {
      throw new Error('Transport shell status card missing')
    }
    for (const event of ['system', 'view', 'ops', 'tasks', 'conversations']) {
      stream.addEventListener(event, (message) => {
        count += 1
        if (event === 'conversations') {
          // The real project-scoped conversation index reports busy; no inferred tool progress.
          state = message.data.includes('"busy":true') ? 'Working' : 'Idle'
        }
        card.textContent = `${state} · ${count} real SSE events · ${project.id}`
        card.dataset.state = state
      })
    }
    stream.addEventListener('error', () => {
      card.textContent = 'SSE disconnected; browser will retry'
    })
  }
  /** @param {string} id */
  function viewProject(id) {
    const project = projects.find((item) => item.id === id)
    if (!project) {
      throw new Error('Unknown transport project')
    }
    controls.selector.value = id
    for (const [key, frame] of frames) {
      frame.hidden = key !== id
    }
    controls.direct.href = project.url
    controls.prefix.href = `/p/${id}/`
    element('viewing').textContent = `Viewing ${id} · ${new URL(project.url).origin}`
  }
  selector.addEventListener('change', () => viewProject(selector.value))
  viewProject('alpha')
  element('submit').addEventListener('click', async () => {
    const alpha = projects.find((project) => project.id === 'alpha')
    if (!alpha) {
      return
    }
    viewProject('beta')
    try {
      const result = await fetch(`/p/alpha/api/conversations/${alpha.root}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'phases demo' }),
      })
      if (!result.ok) {
        throw new Error(`Alpha input rejected: ${result.status}`)
      }
      element('error').textContent = ''
      const receipt = element('receipt')
      receipt.hidden = false
      receipt.textContent = `Alpha accepted input (HTTP ${result.status}). Beta is in view. Watch Alpha’s live busy/idle card; switch back to inspect the real result.`
    } catch (error) {
      element('error').textContent = String(error)
    }
  })
} catch (error) {
  element('error').textContent = String(error)
}
window.addEventListener('pagehide', () => {
  for (const stream of streams) {
    stream.close()
  }
})
