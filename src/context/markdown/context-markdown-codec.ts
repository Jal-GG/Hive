import { createHash } from 'node:crypto'
import { ContextNode, ScopeRef } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { createResourceUri } from '../../scope/resource-uri.js'

/** Fields derived from the node's location or body, never read back from disk. */
type StoredFrontMatter = Omit<ContextNode, 'body' | 'sha256' | 'uri' | 'scope'>

export class ContextMarkdownCodec {
  encode(node: ContextNode): string {
    const { body, sha256, uri, scope, ...frontMatter } = node
    return `---\n${JSON.stringify(frontMatter satisfies StoredFrontMatter, null, 2)}\n---\n${body ?? ''}`
  }

  decode(scope: ScopeRef, path: string, text: string): ContextNode {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) throw new HiveError('INVALID_FRONTMATTER', 'Context file must contain frontmatter')
    let frontMatter: StoredFrontMatter
    try {
      frontMatter = JSON.parse(match[1]) as StoredFrontMatter
    } catch {
      throw new HiveError('INVALID_FRONTMATTER', 'Context frontmatter must be valid JSON')
    }
    const body = match[2]
    return { ...frontMatter, uri: createResourceUri(scope, path), scope, body, sha256: this.hash(body) }
  }

  hash(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex')
  }
}
