import Database from 'better-sqlite3'
import { migrations, schemaVersion } from './migrations.js'
import { Clock, ClockOptions, resolveClock } from '../../shared/clock.js'
import { ensureParentDirectory } from '../../shared/fs.js'

export type DatabaseOptions = ClockOptions

/**
 * Owns the SQLite connection and the forward-only migration ladder. The raw
 * connection stays private so every query goes through `prepare`/`transaction`
 * and can be cached and audited in one place.
 */
export class SqliteDatabase {
  private readonly connection: Database.Database
  private readonly now: Clock

  constructor(fileName: string, options: DatabaseOptions = {}) {
    if (fileName !== ':memory:') ensureParentDirectory(fileName)
    this.connection = new Database(fileName)
    this.now = resolveClock(options)
    this.connection.pragma('journal_mode = WAL')
    this.connection.pragma('foreign_keys = ON')
    this.applyMigrations()
  }

  close(): void {
    this.connection.close()
  }

  prepare(sql: string): Database.Statement {
    return this.connection.prepare(sql)
  }

  /** Runs `work` inside a transaction and returns its value. */
  transaction<T>(work: () => T): T {
    return this.connection.transaction(work)()
  }

  pragma(name: string): unknown {
    return this.connection.pragma(name, { simple: true })
  }

  backup(destination: string): Promise<void> {
    return this.connection.backup(destination).then(() => undefined)
  }

  private applyMigrations(): void {
    this.connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const applied = this.connection.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
    const knownVersions = new Set(applied.map((row) => row.version))
    const insert = this.connection.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
    this.transaction(() => {
      for (let version = 1; version <= schemaVersion; version += 1) {
        if (knownVersions.has(version)) continue
        this.connection.exec(migrations[version])
        insert.run(version, this.now().toISOString())
      }
    })
  }
}
