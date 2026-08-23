/**
 * A deliberately small glob dialect so navigation stays deterministic and
 * dependency-free: `*` and `?` stay inside one path segment, `**` crosses
 * segments, and `**​/` also matches zero segments. Matching is case-sensitive on
 * every platform, independent of the host filesystem's case folding.
 */
export function compileGlob(pattern: string): RegExp {
  let source = '^'
  let index = 0
  while (index < pattern.length) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:[^/]+/)*'
        index += 3
      } else {
        source += '.*'
        index += 2
      }
      continue
    }
    if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/, '\\$&')
    }
    index += 1
  }
  return new RegExp(`${source}$`)
}

export function matchesGlob(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(path)
}
