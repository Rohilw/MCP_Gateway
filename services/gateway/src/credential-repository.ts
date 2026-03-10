import crypto from "node:crypto";
import type { Pool } from "pg";

interface CredentialRow {
  username: string;
  user_id: string;
  bot_role: string;
  password_hash: string;
  is_active: boolean;
}

export interface AuthenticatedIdentity {
  username: string;
  user_id: string;
  bot_role: string;
}

function parseScryptHash(hash: string): { salt: Buffer; expected: Buffer } | null {
  const parts = hash.split("$");
  if (parts.length !== 3) {
    return null;
  }
  const [algorithm, saltHex, hashHex] = parts;
  if (algorithm !== "scrypt" || !saltHex || !hashHex) {
    return null;
  }

  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    if (salt.length === 0 || expected.length === 0) {
      return null;
    }
    return { salt, expected };
  } catch {
    return null;
  }
}

function verifyPassword(password: string, storedHash: string): boolean {
  const parsed = parseScryptHash(storedHash);
  if (!parsed) {
    return false;
  }

  const derived = crypto.scryptSync(password, parsed.salt, parsed.expected.length);
  if (derived.length !== parsed.expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, parsed.expected);
}

export class CredentialRepository {
  public constructor(private readonly pool: Pool) {}

  public async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS user_credentials (
        username TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        bot_role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  public async authenticate(username: string, password: string): Promise<AuthenticatedIdentity | null> {
    const normalizedUsername = username.trim().toLowerCase();
    if (normalizedUsername.length === 0 || password.length === 0) {
      return null;
    }

    const result = await this.pool.query<CredentialRow>(
      `
        SELECT username, user_id, bot_role, password_hash, is_active
        FROM user_credentials
        WHERE username = $1
      `,
      [normalizedUsername]
    );

    const row = result.rows[0];
    if (!row || !row.is_active) {
      return null;
    }
    if (!verifyPassword(password, row.password_hash)) {
      return null;
    }

    return {
      username: row.username,
      user_id: row.user_id,
      bot_role: row.bot_role
    };
  }
}
