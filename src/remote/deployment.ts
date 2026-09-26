import { createServer, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Deployment profiles (§7 Phase 9): each target is data — one JSON artifact
 * plus any platform unit it references — generated from the assembled release,
 * never hand-maintained per host. Health and readiness are separate because
 * they answer different questions: `/healthz` is "is the process sane", and
 * `/readyz` is "can it do work right now" (ledger open, migration current).
 */

export type DeploymentProfileKind = 'docker' | 'compose' | 'systemd' | 'companion' | 'reverse-proxy'

export interface DeploymentProfile {
  kind: DeploymentProfileKind
  /** The release directory the profile points at. */
  releaseDirectory: string
  /** The profile's own artifacts, relative file names and contents, for the target's layout. */
  files: Array<{ name: string; content: string }>
  /** Health endpoints this profile exposes, as absolute paths. */
  healthPaths: { liveness: string; readiness: string }
  /** The command the profile runs to start Hive. */
  command: readonly string[]
}

export interface ProfileOptions {
  releaseDirectory: string
  /** Port the health server binds. */
  healthPort?: number
  /** Version string stamped into every profile. */
  version: string
}

export function dockerProfile(options: ProfileOptions): DeploymentProfile {
  return {
    kind: 'docker',
    releaseDirectory: options.releaseDirectory,
    files: [
      {
        name: 'Dockerfile',
        content: [
          'FROM node:22-slim',
          '',
          '# The release directory is copied in whole — the assembled artifacts only,',
          '# never a ledger database or installed dependencies.',
          `COPY ${options.releaseDirectory} /opt/hive`,
          'WORKDIR /opt/hive',
          '',
          '# Remote mode is a separate deployment profile (§7.0): the container runs the CLI headless.',
          'ENTRYPOINT ["node", "cli.cjs"]',
        ].join('\n'),
      },
    ],
    healthPaths: { liveness: '/healthz', readiness: '/readyz' },
    command: ['node', 'cli.cjs'],
  }
}

export function composeProfile(options: ProfileOptions): DeploymentProfile {
  return {
    kind: 'compose',
    releaseDirectory: options.releaseDirectory,
    files: [
      {
        name: 'compose.yaml',
        content: [
          'services:',
          '  hive:',
          '    build: .',
          `    image: hive:${options.version}`,
          '    restart: unless-stopped',
          '    environment:',
          '      - HIVE_LEDGER=/data/hive.db',
          '    volumes:',
          '      - hive-data:/data',
          '    ports:',
          `      - "${options.healthPort ?? 8789}:8789"`,
          '    healthcheck:',
          '      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:8789/healthz\').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]',
          '      interval: 30s',
          '      timeout: 5s',
          '      retries: 3',
          '',
          'volumes:',
          '  hive-data:',
        ].join('\n'),
      },
    ],
    healthPaths: { liveness: '/healthz', readiness: '/readyz' },
    command: ['docker', 'compose', 'up'],
  }
}

export function systemdProfile(options: ProfileOptions): DeploymentProfile {
  return {
    kind: 'systemd',
    releaseDirectory: options.releaseDirectory,
    files: [
      {
        name: 'hive.service',
        content: [
          '[Unit]',
          'Description=Hive agent harness',
          'After=network-online.target',
          '',
          '[Service]',
          'Type=simple',
          `ExecStart=node ${options.releaseDirectory}/cli.cjs dashboard`,
          'Restart=on-failure',
          'RestartSec=5',
          'DynamicUser=yes',
          'StateDirectory=hive',
          'Environment=HIVE_LEDGER=/var/lib/hive/hive.db',
          '',
          '[Install]',
          'WantedBy=multi-user.target',
        ].join('\n'),
      },
    ],
    healthPaths: { liveness: '/healthz', readiness: '/readyz' },
    command: ['systemctl', 'start', 'hive'],
  }
}

/** The desktop companion: a user-level unit that runs alongside the Electron app. */
export function companionProfile(options: ProfileOptions): DeploymentProfile {
  return {
    kind: 'companion',
    releaseDirectory: options.releaseDirectory,
    files: [
      {
        name: 'hive-companion.service',
        content: [
          '[Unit]',
          'Description=Hive desktop companion (headless control plane)',
          '',
          '[Service]',
          'Type=simple',
          `ExecStart=node ${options.releaseDirectory}/cli.cjs mcp`,
          'Restart=on-failure',
          'RestartSec=3',
          '',
          '[Install]',
          'WantedBy=default.target',
        ].join('\n'),
      },
    ],
    healthPaths: { liveness: '/healthz', readiness: '/readyz' },
    command: ['systemctl', '--user', 'start', 'hive-companion'],
  }
}

/** A reverse-proxy front for the remote agent and dashboard, with TLS policy only. */
export function reverseProxyProfile(options: ProfileOptions): DeploymentProfile {
  return {
    kind: 'reverse-proxy',
    releaseDirectory: options.releaseDirectory,
    files: [
      {
        name: 'hive-proxy.conf',
        content: [
          '# Fronts the read-only dashboard and the mTLS agent port. The proxy',
          '# terminates nothing: agent traffic is TCP-passthrough so client',
          '# certificates reach the agent itself.',
          'stream {',
          '  server {',
          `    listen ${options.healthPort ?? 8790};`,
          '    proxy_pass 127.0.0.1:8791;',
          '  }',
          '}',
          '',
          'http {',
          '  server {',
          '    listen 8789;',
          '    location /healthz { proxy_pass http://127.0.0.1:8788/healthz; }',
          '    location /readyz   { proxy_pass http://127.0.0.1:8788/readyz; }',
          '    location /         { proxy_pass http://127.0.0.1:8788; }',
          '  }',
          '}',
        ].join('\n'),
      },
    ],
    healthPaths: { liveness: '/healthz', readiness: '/readyz' },
    command: ['nginx', '-c', 'hive-proxy.conf'],
  }
}

/** Writes a profile's artifacts next to the release it fronts. */
export function materializeProfile(profile: DeploymentProfile, outDirectory: string): string[] {
  mkdirSync(outDirectory, { recursive: true })
  const written: string[] = []
  for (const file of profile.files) {
    const path = join(outDirectory, file.name)
    writeFileSync(path, file.content, 'utf8')
    written.push(path)
  }
  return written
}

export interface HealthState {
  /** Liveness: the process is sane. */
  alive: boolean
  /** Readiness: the ledger is open and migrations are current. */
  ready: boolean
  version: string
  /** Human-readable detail for the failing side. */
  detail?: string
}

/**
 * The health/readiness endpoint (§7 Phase 9 "health/readiness checks").
 * Read-only by construction: two GET paths, no mutation surface, loopback.
 */
export class HealthServer {
  private readonly server: Server

  constructor(private readonly state: () => HealthState) {
    this.server = createServer((request, response) => this.route(request.url ?? '/', response))
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => resolve((this.server.address() as AddressInfo).port))
    })
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())))
  }

  private route(url: string, response: ServerResponse): void {
    if (url === '/healthz') {
      const state = this.state()
      return this.reply(response, state.alive ? 200 : 503, { alive: state.alive, version: state.version })
    }
    if (url === '/readyz') {
      const state = this.state()
      return this.reply(response, state.ready ? 200 : 503, { ready: state.ready, version: state.version, detail: state.detail })
    }
    this.reply(response, 404, { error: 'no such route' })
  }

  private reply(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
  }
}
