/**
 * Authentication: accounts with scrypt-hashed passwords and opaque, revocable session
 * tokens. Only SHA-256 digests of tokens are stored, so a leaked data directory does not
 * yield usable sessions. Login attempts are rate-limited per account and per address.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TICKET_TTL_MS = 30_000;
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

export type PlatformRole = "admin" | "member";

export interface Account {
  id: string;
  username: string;
  displayName: string;
  role: PlatformRole;
  createdAt: string;
}

interface StoredAccount extends Account {
  salt: string;
  passwordHash: string;
}

interface StoredSession {
  tokenHash: string;
  accountId: string;
  expiresAt: number;
  createdAt: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 429,
  ) {
    super(message);
  }
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/;

export class AuthService {
  private accounts = new Map<string, StoredAccount>();
  private sessions = new Map<string, StoredSession>();
  private tickets = new Map<string, { accountId: string; expiresAt: number }>();
  private attempts = new Map<string, number[]>();
  private readonly file: string | null;

  /** @param dir directory for the account store, or null for in-memory (tests). */
  constructor(dir: string | null) {
    this.file = dir ? path.join(dir, "auth.json") : null;
    if (dir) mkdirSync(dir, { recursive: true });
    if (this.file && existsSync(this.file)) {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { accounts: StoredAccount[]; sessions: StoredSession[] };
      for (const a of data.accounts) this.accounts.set(a.id, a);
      for (const s of data.sessions) if (s.expiresAt > Date.now()) this.sessions.set(s.tokenHash, s);
    }
  }

  private save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ accounts: [...this.accounts.values()], sessions: [...this.sessions.values()] }), { mode: 0o600 });
    renameSync(tmp, this.file); // atomic replace: a crash never leaves a half-written store
  }

  private publicView(a: StoredAccount): Account {
    return { id: a.id, username: a.username, displayName: a.displayName, role: a.role, createdAt: a.createdAt };
  }

  private throttle(key: string): void {
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < ATTEMPT_WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) throw new AuthError("Too many attempts. Try again in a few minutes.", 429);
    recent.push(now);
    this.attempts.set(key, recent);
  }

  get accountCount(): number {
    return this.accounts.size;
  }

  getAccount(id: string): Account | undefined {
    const a = this.accounts.get(id);
    return a ? this.publicView(a) : undefined;
  }

  listAccounts(): Account[] {
    return [...this.accounts.values()].map((a) => this.publicView(a));
  }

  /** Create an account. The first account on a fresh installation becomes the administrator. */
  async register(input: { username: string; password: string; displayName?: string }, address = "local"): Promise<Account> {
    this.throttle(`register:${address}`);
    const username = String(input.username ?? "").trim();
    const password = String(input.password ?? "");
    if (!USERNAME.test(username)) throw new AuthError("Username must be 3–32 characters: letters, digits, dot, dash or underscore.", 400);
    if (password.length < 10 || password.length > 256) throw new AuthError("Password must be at least 10 characters.", 400);
    if (password.toLowerCase().includes(username.toLowerCase())) throw new AuthError("Password must not contain the username.", 400);
    const lower = username.toLowerCase();
    if ([...this.accounts.values()].some((a) => a.username.toLowerCase() === lower)) throw new AuthError("That username is taken.", 409);
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 64, SCRYPT);
    const account: StoredAccount = {
      id: `u_${randomBytes(8).toString("hex")}`,
      username,
      displayName: (input.displayName ?? username).trim().slice(0, 40) || username,
      role: this.accounts.size === 0 ? "admin" : "member",
      createdAt: new Date().toISOString(),
      salt: salt.toString("hex"),
      passwordHash: hash.toString("hex"),
    };
    this.accounts.set(account.id, account);
    this.save();
    return this.publicView(account);
  }

  /** Verify credentials and open a session. The returned token is shown once and never stored. */
  async login(username: string, password: string, address = "local"): Promise<{ account: Account; token: string; expiresAt: number }> {
    const lower = String(username ?? "").trim().toLowerCase();
    this.throttle(`login:${lower}`);
    this.throttle(`login-addr:${address}`);
    const account = [...this.accounts.values()].find((a) => a.username.toLowerCase() === lower);
    // Always run the KDF so response time does not reveal whether the account exists.
    const salt = Buffer.from(account?.salt ?? "00".repeat(16), "hex");
    const candidate = await scrypt(String(password ?? ""), salt, 64, SCRYPT);
    const expected = Buffer.from(account?.passwordHash ?? "00".repeat(64), "hex");
    if (!account || !timingSafeEqual(candidate, expected)) throw new AuthError("Incorrect username or password.", 401);
    this.attempts.delete(`login:${lower}`);
    const token = randomBytes(32).toString("base64url");
    const session: StoredSession = { tokenHash: sha256(token), accountId: account.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
    this.sessions.set(session.tokenHash, session);
    this.save();
    return { account: this.publicView(account), token, expiresAt: session.expiresAt };
  }

  /** Resolve a session token to its account, or undefined if it is unknown or expired. */
  authenticate(token: string | undefined): Account | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(sha256(token));
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(session.tokenHash);
      return undefined;
    }
    return this.getAccount(session.accountId);
  }

  logout(token: string | undefined): void {
    if (token && this.sessions.delete(sha256(token))) this.save();
  }

  /** Revoke every session of an account (password change, compromise). */
  revokeAll(accountId: string): number {
    let n = 0;
    for (const [hash, s] of this.sessions) {
      if (s.accountId === accountId) {
        this.sessions.delete(hash);
        n++;
      }
    }
    if (n) this.save();
    return n;
  }

  setRole(accountId: string, role: PlatformRole): Account {
    const a = this.accounts.get(accountId);
    if (!a) throw new AuthError("Account not found.", 400);
    a.role = role;
    this.save();
    return this.publicView(a);
  }

  /** Single-use, 30-second ticket for opening a WebSocket (browsers cannot set headers on upgrade). */
  issueTicket(accountId: string): string {
    const now = Date.now();
    for (const [t, v] of this.tickets) if (v.expiresAt <= now) this.tickets.delete(t);
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(sha256(ticket), { accountId, expiresAt: now + TICKET_TTL_MS });
    return ticket;
  }

  redeemTicket(ticket: string | undefined): Account | undefined {
    if (!ticket) return undefined;
    const key = sha256(ticket);
    const entry = this.tickets.get(key);
    this.tickets.delete(key);
    if (!entry || entry.expiresAt <= Date.now()) return undefined;
    return this.getAccount(entry.accountId);
  }
}
