import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ActorContext, ScopeRef } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { Ledger } from '../../ledger.js'
import { assertCapability } from '../../capabilities.js'
import { currentVersion } from '../../release.js'
import { CertificateAuthority, generateCA } from '../../remote/certs.js'
import { ExecutionAgent, RemoteAgentClient } from '../../remote/agent.js'
import { DirectoryObjectStore } from '../../remote/object-store.js'
import { createBundleFor, ensureBareRepository, GitSmartRelay } from '../../remote/git-relay.js'
import { Federator, readExport, writeExport, type FederationManifest } from '../../remote/federation.js'
import { backupRestoreDrill, drillWorkDirectory, remoteRestoreDrill, releaseVerificationDrill, upgradeMigrationDrill, verifyRelease } from '../../remote/drills.js'
import { composeProfile, companionProfile, dockerProfile, materializeProfile, reverseProxyProfile, systemdProfile, type DeploymentProfileKind } from '../../remote/deployment.js'

/**
 * `hive remote|federate|deploy` — Phase 9's operator surface. Everything here
 * is explicit setup and teardown: the remote plane never starts itself, and no
 * local operation depends on it (§7.0).
 */

function defaultManifest(peerId: string, workspace: string, project: string): FederationManifest {
  return {
    version: 1,
    peerId,
    sovereignty: [{ workspace, project }],
    conflictPolicy: 'quarantine',
    eventTypes: ['Work', 'Trigger', 'System'],
    createdAt: new Date().toISOString(),
  }
}

export interface RemoteCliOptions {
  ledger: Ledger
  scope: ScopeRef
  /** Where generated keys, certs, and profiles land. */
  stateRoot: string
  packageRoot: string
  /** The Git-backed context root, when one exists; the restore drill travels it too. */
  contextRoot?: string
}

export async function runRemoteCli(options: RemoteCliOptions, actor: ActorContext, argv: readonly string[]): Promise<string> {
  const [operation, ...rest] = argv
  if (!operation || operation === 'help' || operation === '--help') return remoteUsage()
  switch (operation) {
    case 'serve': return remoteServe(options, rest)
    case 'ca': return remoteCa(options, rest)
    case 'leaf': return remoteLeaf(options, rest)
    case 'push': return remotePush(options, actor, rest)
    case 'pull': return remotePull(options, actor, rest)
    case 'events': return remoteEvents(options, rest)
    case 'drills': return remoteDrills(options, actor)
    default: throw new HiveError('UNKNOWN_OPERATION', `Unknown remote operation: ${operation}\n\n${remoteUsage()}`)
  }
}

function remoteUsage(): string {
  return [
    'Usage: hive remote <operation> [options]',
    '',
    '  serve          Run an ExecutionAgent (HIVE_REMOTE_PORT, HIVE_REMOTE_POLICY)',
    '  ca             Generate a CA into <stateRoot>/remote/ca (offline thereafter)',
    '  leaf           Issue an agent leaf certificate (--id, --ca <path>)',
    '  push           Push a branch bundle through a relay (--repo, --branch, [--port] to dial an agent)',
    '  pull           Fetch a branch bundle from a relay (--branch, [--port] to dial an agent)',
    '  events         Export one scrubbed federation page (--peer, --after, --limit)',
    '  drills         Run the hardening drills and report verdicts',
    '',
    'Env:',
    '  HIVE_REMOTE_PORT       Agent listen port (default 8791)',
    '  HIVE_REMOTE_POLICY     Policy JSON: identity, capabilities, commands, allowedBranches',
    '  HIVE_REMOTE_REPO       Bare repository the agent lands refs into',
    '  HIVE_REMOTE_STORE      Object store root (default <stateRoot>/remote/store)',
  ].join('\n')
}

async function remoteServe(options: RemoteCliOptions, rest: readonly string[]): Promise<string> {
  const policyPath = flag(rest, '--policy') ?? envString('HIVE_REMOTE_POLICY')
  const repoPath = envString('HIVE_REMOTE_REPO')
  const caDirectory = join(options.stateRoot, 'remote', 'ca')
  const agentIdentity = envString('HIVE_REMOTE_IDENTITY') ?? 'agent-1'
  const leafDirectory = join(options.stateRoot, 'remote', 'leaves', agentIdentity)
  const policy = policyPath ? JSON.parse(readFileSync(policyPath, 'utf8')) : undefined
  if (!repoPath) throw new HiveError('MISSING_ARGUMENT', 'HIVE_REMOTE_REPO is required: the agent must land refs into a fixed target')
  const relay = new GitSmartRelay({ repositoryRoot: repoPath, allowedBranches: policy?.allowedBranches ?? [] })
  const store = new DirectoryObjectStore(envString('HIVE_REMOTE_STORE') ?? join(options.stateRoot, 'remote', 'store'))
  const agentPolicy = {
    identity: policy?.identity ?? agentIdentity,
    capabilities: policy?.capabilities ?? ['git.fetch', 'git.head', 'store.put', 'store.get', 'events', 'ping'],
    commands: policy?.commands ?? {
      'git.fetch': ['git.fetch'], 'git.push': ['git.push'], 'git.head': ['git.head'],
      'store.put': ['store.put'], 'store.get': ['store.get'], events: ['events'], ping: ['ping'],
    },
    allowedBranches: policy?.allowedBranches ?? [],
  }
  const agent = new ExecutionAgent({
    policy: agentPolicy,
    authority: CertificateAuthority.fromPem(
      readFileSync(join(caDirectory, 'ca.crt'), 'utf8'),
      readFileSync(join(caDirectory, 'ca.key'), 'utf8'),
    ),
    serverCertificate: {
      certificate: readFileSync(join(leafDirectory, 'agent.crt'), 'utf8'),
      privateKey: readFileSync(join(leafDirectory, 'agent.key'), 'utf8'),
    },
    relay,
    store,
    events: (after, limit) => ({ events: options.ledger.readEvents(after, limit), latest: options.ledger.latestEventSequence() }),
  })
  const port = await agent.listen(Number(envString('HIVE_REMOTE_PORT') ?? 8791))
  return `ExecutionAgent ${agentPolicy.identity} listening on 127.0.0.1:${port} (mTLS, policy: ${policyPath ?? 'built-in default'})`
}

function remoteCa(options: RemoteCliOptions, _rest: readonly string[]): string {
  const directory = join(options.stateRoot, 'remote', 'ca')
  mkdirSync(directory, { recursive: true })
  const bundle = generateCA()
  writeFileSync(join(directory, 'ca.crt'), bundle.certificate, 'utf8')
  writeFileSync(join(directory, 'ca.key'), bundle.privateKey, 'utf8')
  return `CA generated at ${directory}. Keep the key offline; it never enters the ledger.`
}

function remoteLeaf(options: RemoteCliOptions, rest: readonly string[]): string {
  const id = flag(rest, '--id') ?? 'agent-1'
  const caDirectory = join(options.stateRoot, 'remote', 'ca')
  const authority = CertificateAuthority.fromPem(
    readFileSync(join(caDirectory, 'ca.crt'), 'utf8'),
    readFileSync(join(caDirectory, 'ca.key'), 'utf8'),
  )
  // The loopback IP SAN makes the leaf usable for a local listener; a remote
  // host adds its own DNS/IP SANs when it issues.
  const leaf = authority.issue({ id, ips: ['127.0.0.1'] })
  const leafDirectory = join(options.stateRoot, 'remote', 'leaves', id)
  mkdirSync(leafDirectory, { recursive: true })
  // Both namings are written: `agent.*` for a serving agent, `client.*` for an
  // operator client dialing one (the `remote push/pull --port` path).
  writeFileSync(join(leafDirectory, 'agent.crt'), leaf.certificate, 'utf8')
  writeFileSync(join(leafDirectory, 'agent.key'), leaf.privateKey, 'utf8')
  writeFileSync(join(leafDirectory, 'client.crt'), leaf.certificate, 'utf8')
  writeFileSync(join(leafDirectory, 'client.key'), leaf.privateKey, 'utf8')
  return `Leaf certificate for ${id} issued at ${leafDirectory}`
}

async function remotePush(options: RemoteCliOptions, actor: ActorContext, rest: readonly string[]): Promise<string> {
  const repoRoot = flag(rest, '--repo')
  const branch = flag(rest, '--branch')
  if (!repoRoot || !branch) throw new HiveError('MISSING_ARGUMENT', '--repo and --branch are required')
  void actor

  // The remote path: dial the ExecutionAgent over mTLS and push through its relay.
  const port = flag(rest, '--port')
  if (port) {
    // CAS head comes from the agent itself — the target lives behind it, and
    // the only truthful expected-head is the one the relay will check against.
    const headReply = await requestRemote(options, Number(port), 'git.head', 'git.head', { branch })
    if (!headReply.ok) throw new HiveError('REMOTE_REFUSED', headReply.error?.message ?? 'the agent refused the head query')
    const expectedHead = ((headReply.data as { head: string | null }).head) ?? undefined
    const bundle = createBundleFor(repoRoot, branch, expectedHead, '')
    const reply = await requestRemote(options, Number(port), 'git.push', 'git.push', {
      branch,
      expectedHead,
      bundle: bundle.toString('base64'),
    })
    if (!reply.ok) throw new HiveError('REMOTE_REFUSED', reply.error?.message ?? 'the agent refused the push')
    return JSON.stringify(reply.data)
  }

  // The local relay path: an operator standing up a relay on this machine.
  const relay = { repositoryRoot: flag(rest, '--target') ?? join(options.stateRoot, 'remote', 'repo.git') }
  const bare = ensureBareRepository(relay.repositoryRoot)
  const expectedHead = bare.tryRun(['rev-parse', '--verify', `refs/heads/${branch}`]) ?? undefined
  const bundle = createBundleFor(repoRoot, branch, expectedHead, '')
  const smart = new GitSmartRelay({ repositoryRoot: relay.repositoryRoot, allowedBranches: [branch, `${branch}/*`] })
  const result = await smart.push({ branch, expectedHead, bundle })
  return JSON.stringify(result)
}

async function remotePull(options: RemoteCliOptions, actor: ActorContext, rest: readonly string[]): Promise<string> {
  const branch = flag(rest, '--branch')
  if (!branch) throw new HiveError('MISSING_ARGUMENT', '--branch is required')
  void actor

  // The remote path: fetch a bundle from the agent's relay over mTLS.
  const port = flag(rest, '--port')
  if (port) {
    const reply = await requestRemote(options, Number(port), 'git.fetch', 'git.fetch', { branch })
    if (!reply.ok) throw new HiveError('REMOTE_REFUSED', reply.error?.message ?? 'the agent refused the fetch')
    const data = reply.data as { head: string; bundle: string }
    return JSON.stringify({ branch, head: data.head, bundleBytes: Buffer.from(data.bundle, 'base64').length })
  }

  const repoRoot = flag(rest, '--target') ?? join(options.stateRoot, 'remote', 'repo.git')
  const smart = new GitSmartRelay({ repositoryRoot: repoRoot, allowedBranches: ['*'] })
  const fetched = await smart.fetch(branch)
  return JSON.stringify({ branch, head: fetched.head, bundleBytes: fetched.bundle.length })
}

/**
 * One mTLS request to a running ExecutionAgent: client leaf from the state
 * root, the CA that issued everything, host pinned to loopback. The expected
 * agent identity pins the welcome, so a mis-routed port fails loudly rather
 * than pushing somewhere wrong.
 */
async function requestRemote(options: RemoteCliOptions, port: number, capability: string, command: string, arguments_: Record<string, unknown>) {
  const caDirectory = join(options.stateRoot, 'remote', 'ca')
  const clientIdentity = envString('HIVE_REMOTE_CLIENT_IDENTITY') ?? 'operator-1'
  const leafDirectory = join(options.stateRoot, 'remote', 'leaves', clientIdentity)
  const expectedIdentity = envString('HIVE_REMOTE_IDENTITY') ?? 'agent-1'
  const client = new RemoteAgentClient({
    host: '127.0.0.1',
    port,
    certificate: readFileSync(join(leafDirectory, 'client.crt'), 'utf8'),
    privateKey: readFileSync(join(leafDirectory, 'client.key'), 'utf8'),
    serverAuthority: readFileSync(join(caDirectory, 'ca.crt'), 'utf8'),
    expectedIdentity,
  })
  try {
    await client.connect()
    return await client.request(capability, command, arguments_)
  } finally {
    client.close()
  }
}

async function remoteEvents(options: RemoteCliOptions, rest: readonly string[]): Promise<string> {
  const peer = flag(rest, '--peer') ?? 'self'
  const after = Number(flag(rest, '--after') ?? 0)
  const limit = Number(flag(rest, '--limit') ?? 500)
  const manifest = defaultManifest(peer, options.scope.workspaceName, options.scope.projectName)
  const federator = new Federator({ ledger: options.ledger, manifest })
  const page = federator.exportPage(after, limit)
  const out = flag(rest, '--out') ?? join(options.stateRoot, 'remote', 'exports', `${peer}-${page.toSequence}.json`)
  writeExport(page, out)
  return JSON.stringify({ out, from: page.fromSequence, to: page.toSequence, events: page.events.length, latest: page.latest })
}

async function remoteDrills(options: RemoteCliOptions, actor: ActorContext): Promise<string> {
  const work = drillWorkDirectory(join(options.stateRoot, 'remote'), 'drills')
  const verdicts = [
    await backupRestoreDrill(options.ledger, work),
    upgradeMigrationDrill(work),
  ]
  const contextRoot = options.contextRoot !== undefined && existsSync(options.contextRoot) ? options.contextRoot : undefined
  const remote = remoteRestoreDrill(options.ledger, work, contextRoot)
  verdicts.push(remote.verdict)
  remote.close()
  const releaseDirectory = join(options.packageRoot, 'release', 'verify-target')
  mkdirSync(releaseDirectory, { recursive: true })
  writeFileSync(join(releaseDirectory, 'cli.cjs'), '// drill stand-in\n', 'utf8')
  const release = releaseVerificationDrill(releaseDirectory)
  verdicts.push(release.verdict)
  const verified = verifyRelease(releaseDirectory)
  verdicts.push(verified.ok
    ? { name: 'release-verify-consumer', ok: true, detail: `${verified.files} files verified from SHA256SUMS.json` }
    : { name: 'release-verify-consumer', ok: false, detail: `${verified.path}: ${verified.reason}` })
  const ok = verdicts.every((verdict) => verdict.ok)
  // A drill run is a recovery decision with evidence: the verdicts belong in
  // the audit log, not only on stdout (§7 exit gate: "an audit trail for
  // recovery decisions").
  options.ledger.recordAudit(actor.actorId, 'remote.drills', {
    ok,
    contextIncluded: contextRoot !== undefined,
    verdicts: verdicts.map((verdict) => ({ name: verdict.name, ok: verdict.ok })),
  })
  return JSON.stringify({ ok, verdicts }, null, 2)
}

function flag(values: readonly string[], name: string): string | undefined {
  const index = values.indexOf(name)
  return index >= 0 && index + 1 < values.length ? values[index + 1] : undefined
}

function envString(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

export async function runFederateCli(options: RemoteCliOptions, actor: ActorContext, argv: readonly string[]): Promise<string> {
  const [operation, ...rest] = argv
  if (!operation || operation === 'help' || operation === '--help') {
    return [
      'Usage: hive federate <operation> [options]',
      '',
      '  export    Write one scrubbed export page (--peer, --after, --limit, --out)',
      '  import    Verify and quarantine an import page (--file)',
      '  review    List pending quarantine rows (--peer optional)',
      '  promote   Promote one quarantined record (--id)',
      '  reject    Reject one quarantined record (--id)',
    ].join('\n')
  }
  const manifest = defaultManifest('local', options.scope.workspaceName, options.scope.projectName)
  const federator = new Federator({ ledger: options.ledger, manifest })
  switch (operation) {
    case 'export': {
      const after = Number(flag(rest, '--after') ?? 0)
      const limit = Number(flag(rest, '--limit') ?? 500)
      const peer = flag(rest, '--peer') ?? 'local'
      const page = new Federator({ ledger: options.ledger, manifest: defaultManifest(peer, options.scope.workspaceName, options.scope.projectName) }).exportPage(after, limit)
      const out = flag(rest, '--out') ?? join(options.stateRoot, 'remote', 'exports', `${peer}-${page.toSequence}.json`)
      writeExport(page, out)
      return JSON.stringify({ out, from: page.fromSequence, to: page.toSequence, events: page.events.length })
    }
    case 'import': {
      const file = flag(rest, '--file')
      if (!file) throw new HiveError('MISSING_ARGUMENT', '--file is required')
      // Importing peer evidence is a review decision (C16): it lands records
      // an operator will decide on, so the deciding actor must be authorized.
      assertCapability(actor.capabilities, 'federation:review')
      const result = federator.importPage(readExport(file), actor)
      if (!result.ok) throw new HiveError('FEDERATION_REFUSED', result.reason)
      return JSON.stringify(result)
    }
    case 'review': {
      void actor
      const peer = flag(rest, '--peer')
      return JSON.stringify(options.ledger.listFederationQuarantine(peer))
    }
    case 'promote': {
      const id = flag(rest, '--id')
      if (!id) throw new HiveError('MISSING_ARGUMENT', '--id is required')
      assertCapability(actor.capabilities, 'federation:review')
      return JSON.stringify({ promoted: options.ledger.setFederationQuarantineState(id, 'promoted', actor) })
    }
    case 'reject': {
      const id = flag(rest, '--id')
      if (!id) throw new HiveError('MISSING_ARGUMENT', '--id is required')
      assertCapability(actor.capabilities, 'federation:review')
      return JSON.stringify({ rejected: options.ledger.setFederationQuarantineState(id, 'rejected', actor) })
    }
    default: throw new HiveError('UNKNOWN_OPERATION', `Unknown federate operation: ${operation}`)
  }
}

export async function runDeployCli(options: RemoteCliOptions, argv: readonly string[]): Promise<string> {
  const [kind, ...rest] = argv
  if (!kind || kind === 'help' || kind === '--help') {
    return [
      'Usage: hive deploy <kind> [--out <directory>]',
      '',
      '  docker | compose | systemd | companion | reverse-proxy',
    ].join('\n')
  }
  const version = currentVersion(options.packageRoot)
  const profileOptions = { releaseDirectory: join(options.packageRoot, 'release', `hive-${version}-nightly`), version, healthPort: Number(flag(rest, '--health-port') ?? 8789) }
  const profile = kind === 'docker' ? dockerProfile(profileOptions)
    : kind === 'compose' ? composeProfile(profileOptions)
    : kind === 'systemd' ? systemdProfile(profileOptions)
    : kind === 'companion' ? companionProfile(profileOptions)
    : kind === 'reverse-proxy' ? reverseProxyProfile(profileOptions)
    : undefined
  if (!profile) throw new HiveError('UNKNOWN_OPERATION', `Unknown deployment kind: ${kind}`)
  const out = flag(rest, '--out') ?? join(options.stateRoot, 'deploy', kind)
  const files = materializeProfile(profile, out)
  return JSON.stringify({ kind, out, files, command: profile.command, health: profile.healthPaths })
}
