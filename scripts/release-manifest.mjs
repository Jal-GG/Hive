import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) throw new Error('package.json has no valid version')
const manifest = { version: packageJson.version, channel: process.env.HIVE_RELEASE_CHANNEL ?? 'nightly', publishedAt: new Date().toISOString() }
writeFileSync(join(root, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(manifest)}\n`)
