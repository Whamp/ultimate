/** `link`'s path, query and fragment under `base`; a path starting with `//` stays a path, never a new host. */
export function at(base: string, link: URL) {
  const url = new URL(base)
  url.pathname = url.pathname.replace(/\/$/, '') + link.pathname
  url.search = link.search
  url.hash = link.hash
  return url.href
}
