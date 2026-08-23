import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActorContext, ActorType, Capability, ScopeRef } from '../src/contracts.js'
import { ContextFilesystem, ContextFilesystemOptions } from '../src/context-filesystem.js'
import { ContextBrowser } from '../src/context/browsing/context-browser.js'
import { Ledger } from '../src/ledger.js'
import { createResourceUri } from '../src/scope/resource-uri.js'

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

export interface ContextHarness {
  ledger: Ledger
  scope: ScopeRef
  fs: ContextFilesystem
  /** Adds a sibling project in the same workspace, for cross-project link tests. */
  addProject(name: string): ScopeRef
  close(): void
}

/** A ledger, a workspace/project scope, and a context filesystem rooted in a temp directory. */
export function contextHarness(actors: ActorContext[], options: ContextFilesystemOptions = {}): ContextHarness {
  const ledger = ledgerWithActors(...actors)
  const workspaceId = ledger.createWorkspace('main')
  const addProject = (name: string): ScopeRef => ({
    workspaceId,
    projectId: ledger.createProject(workspaceId, name),
    workspaceName: 'main',
    projectName: name,
  })
  const scope = addProject('hive')
  const fs = new ContextFilesystem(tempDirectory('context'), ledger, options)
  return { ledger, scope, fs, addProject, close: () => ledger.close() }
}

export function contextFileName(fs: ContextFilesystem, scope: ScopeRef, path: string): string {
  return join(fs.getRoot(), 'workspace', scope.workspaceName, 'project', scope.projectName, ...path.split('/'))
}

export interface BrowserHarness extends ContextHarness {
  browser: ContextBrowser
  /** URI for a resource path. The project root has no URI: a `viking://` URI always names a resource. */
  uri(path: string): string
  /** Scope-name spelling of the project root, which is the only way to address it. */
  root: { workspace: string; project: string }
}

/**
 * A populated context filesystem behind a `ContextBrowser`. Every browsing
 * surface is read-only, so one fixture can be shared across a whole file
 * instead of paying for a Git repository per test.
 */
export function browserHarness(actors: ActorContext[], writer: ActorContext, options: ContextFilesystemOptions = {}): BrowserHarness {
  const harness = contextHarness(actors, options)
  harness.fs.write(writer, harness.scope, { path: 'page/readme.md', body: '# Hive\nalpha line', tags: ['docs'] })
  harness.fs.write(writer, harness.scope, { path: 'page/guides/setup.md', body: 'beta line' })
  harness.fs.write(writer, harness.scope, { path: 'memory/note.md', body: 'gamma line' })
  return {
    ...harness,
    browser: new ContextBrowser(harness.fs, harness.ledger),
    uri: (path: string) => createResourceUri(harness.scope, path),
    root: { workspace: harness.scope.workspaceName, project: harness.scope.projectName },
  }
}

/**
 * Replaces a node's body on disk while leaving its frontmatter — including the
 * now-stale recorded hash — untouched. That is exactly what an editor outside
 * Hive does, and it is the signal reconciliation keys off.
 */
export function editBodyOutsideHive(fs: ContextFilesystem, scope: ScopeRef, path: string, body: string): void {
  const fileName = contextFileName(fs, scope, path)
  const match = /^(---\n[\s\S]*?\n---\n)[\s\S]*$/.exec(readFileSync(fileName, 'utf8'))
  if (!match) throw new Error(`${path} has no frontmatter to preserve`)
  writeFileSync(fileName, `${match[1]}${body}`, 'utf8')
}
