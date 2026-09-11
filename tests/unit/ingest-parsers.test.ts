import { describe, expect, it } from 'vitest'
import { codeParser, jsonParser, markdownParser, parserFor, textParser } from '../../src/ingest/parsers.js'

describe('parser registry', () => {
  it('routes extensions to their parser', () => {
    expect(parserFor('README.md')?.id).toBe('markdown')
    expect(parserFor('notes.txt')?.id).toBe('text')
    expect(parserFor('config.yaml')?.id).toBe('text')
    expect(parserFor('src/app.ts')?.id).toBe('code')
    expect(parserFor('data.json')?.id).toBe('json')
    expect(parserFor('logo.png')).toBeUndefined()
  })

  it('markdown: title is L0, first paragraph is L1, sections are L2 in order', () => {
    const text = [
      '# Parser Design',
      '',
      'The parser turns files into tiered chunks for search.',
      '',
      '## Chunking',
      '',
      'Sections split at headings and stay bounded.',
      '',
      '## Tiers',
      '',
      'L0 is the title, L1 the overview, L2 the body.',
    ].join('\n')
    const chunks = markdownParser.parse('design.md', text)
    expect(chunks.filter((chunk) => chunk.tier === 'L0')).toHaveLength(1)
    expect(chunks[0].title).toBe('Parser Design')
    const l1 = chunks.find((chunk) => chunk.tier === 'L1')
    expect(l1?.body).toContain('tiered chunks for search')
    const sectionTitles = chunks.filter((chunk) => chunk.tier === 'L2').map((chunk) => chunk.title)
    expect(sectionTitles).toEqual(['Parser Design', 'Chunking', 'Tiers'])
  })

  it('markdown falls back to the filename when no heading exists', () => {
    const chunks = markdownParser.parse('todo.md', 'just a flat note\n\nwith two paragraphs')
    expect(chunks[0].title).toBe('todo.md')
  })

  it('text: bounded L2 slices that break at paragraph boundaries', () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => `paragraph ${index} with searchable words`).join('\n\n')
    const chunks = textParser.parse('notes.txt', paragraphs)
    expect(chunks[0].tier).toBe('L0')
    for (const chunk of chunks.filter((candidate) => candidate.tier === 'L2')) {
      expect(chunk.body.length).toBeLessThanOrEqual(2_100)
    }
    // Nothing was lost: every paragraph number appears in some chunk.
    const all = chunks.map((chunk) => chunk.body).join(' ')
    expect(all).toContain('paragraph 39')
  })

  it('code: the filename is L0 and the body is fixed line windows', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`)
    const chunks = codeParser.parse('app.ts', lines.join('\n'))
    expect(chunks[0]).toMatchObject({ tier: 'L0', title: 'app.ts' })
    const body = chunks.filter((chunk) => chunk.tier === 'L2')
    expect(body).toHaveLength(3) // 200 lines / 80-line windows
    expect(body[0].body.split('\n')).toHaveLength(80)
    // Code has no L1: no honest overview exists without reading it.
    expect(chunks.find((chunk) => chunk.tier === 'L1')).toBeUndefined()
  })

  it('json: top-level keys become the L1 overview, malformed JSON still chunks as text', () => {
    const parsed = jsonParser.parse('package.json', JSON.stringify({ name: 'hive', version: '1.0.0' }))
    expect(parsed.find((chunk) => chunk.tier === 'L1')?.body).toBe('Keys: name, version')
    const malformed = jsonParser.parse('broken.json', '{ "oops": tru')
    expect(malformed.some((chunk) => chunk.tier === 'L2')).toBe(true)
  })
})
