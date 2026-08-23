import { describe, expect, it } from 'vitest'
import { assertCapability } from '../../src/identity/capabilities.js'

describe('capability policy', () => {
  it('rejects an actor that lacks the required capability', () => {
    expect(() => assertCapability([], 'work:dispatch')).toThrowError('Missing capability')
  })

  it('allows an actor that holds it', () => {
    expect(() => assertCapability(['work:dispatch'], 'work:dispatch')).not.toThrow()
  })
})
