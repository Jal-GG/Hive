import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActorContext, ActorType, Capability } from '../src/contracts.js'
import { Ledger } from '../src/ledger.js'

/** Builds a CLI actor; tests vary only the id, capabilities, and occasionally the type. */
export function testActor(actorId: string, capabilities: Capability[], actorType: ActorType = 'operator'): ActorContext {
  return { actorId, actorType, displayName: actorId, source: 'cli', capabilities }
}

/** A fresh temporary directory, removed with the OS temp dir rather than per test. */
export function tempDirectory(suffix: string): string {
  return mkdtempSync(join(tmpdir(), `hive-${suffix}-`))
}

export function ledgerWithActors(...actors: ActorContext[]): Ledger {
  const ledger = new Ledger(':memory:')
  for (const actor of actors) ledger.createActor(actor)
  return ledger
}
