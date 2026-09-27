import { describe, expect, it } from 'vitest'
import { reciprocalRankFusion, rrfK } from '../../src/search/searcher.js'

describe('reciprocal rank fusion', () => {
  it('adds the votes: an item ranked in both lists outranks both single-list winners', () => {
    const titleList = ['a', 'b', 'c']
    const bodyList = ['c', 'a', 'd']
    const fused = reciprocalRankFusion([titleList, bodyList], (item) => item)
    // 'a': 1/(k+1) + 1/(k+2); 'c': 1/(k+3) + 1/(k+1); 'a' and 'c' both beat the singles.
    expect(fused.map(({ item }) => item).slice(0, 2).sort()).toEqual(['a', 'c'])
    const score = (id: string) => fused.find(({ item }) => item === id)!.score
    expect(score('a')).toBeCloseTo(1 / (rrfK + 1) + 1 / (rrfK + 2))
    expect(score('b')).toBeCloseTo(1 / (rrfK + 2))
    expect(score('d')).toBeCloseTo(1 / (rrfK + 3))
  })

  it('breaks score ties by key so the order is a function of the lists alone', () => {
    const fused = reciprocalRankFusion([['x', 'y'], ['y', 'x']], (item) => item)
    expect(fused.map(({ item }) => item)).toEqual(['x', 'y'])
    expect(fused[0].score).toBe(fused[1].score)
  })

  it('an empty list contributes nothing, and no lists produce nothing', () => {
    expect(reciprocalRankFusion<string>([], (item) => item)).toEqual([])
    const empty: string[] = []
    expect(reciprocalRankFusion([empty, ['a']], (item) => item).map(({ item }) => item)).toEqual(['a'])
  })
})
