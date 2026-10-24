/**
 * 管理员认证：单一站点 owner，独立于玩家设备登录。
 * 密码 PBKDF2-SHA256 100000 轮+随机盐+服务端 HMAC 密钥，TOTP RFC6238(SHA1/6位/30秒)，
 * TOTP 种子 AES-GCM 加密，密钥由部署 BOOTSTRAP_SECRET 派生。
 * 明文密码、OTP 种子与 Bearer 不记日志、不入普通前端存储。
 */
import { ApiError } from '@ff14-hub/shared';
import { constantTimeEqualStrings } from '../../lib/util';
import { hashCredential, credentialsEqual } from '../identity/credentials';

/** Cloudflare 生产 workerd 对单次 PBKDF2 限制 100000；本地 Vitest 可能无法复现超限。 */
export const ADMIN_PBKDF2_ITERATIONS = 100_000;
const ADMIN_PASSWORD_HASH_VERSION = 'pbkdf2-sha256-100k-hmac-v2:';
const SESSION_MS = 8 * 60 * 60_000;
const STEP_MS = 30_000;
const DIGITS = 1_000_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const encoder = new TextEncoder();

export interface AdminAccountRow {
  id: string; username: string; password_salt: string; password_hash: string;
  totp_ciphertext: string; totp_last_step: number; activated_at: number | null; created_at: number;
}
function bytesHex(input: Uint8Array): string {
  return Array.from(input, byte => byte.toString(16).padStart(2,'0')).join('');
}
function hexBytes(input: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/i.test(input)) throw new Error('invalid hex');
  return Uint8Array.from(input.match(/.{2}/g)!, v => parseInt(v,16));
}
function encode64(input: Uint8Array): string {
  return btoa(Array.from(input, v => String.fromCodePoint(v)).join(''));
}
function decode64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => (c.codePointAt(0) ?? Number.NaN));
}
function base32(input: Uint8Array): string {
  let bits = 0, buffer = 0, out = '';
  for (const v of input) {
    buffer = (buffer << 8) | v; bits += 8;
    while (bits >= 5) { out += ALPHABET[(buffer >>> (bits -= 5)) & 31]; }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}
async function encryptionKey(setupSecret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode('ff14-hub/calendar-admin/totp/v1/' + setupSecret));
  return crypto.subtle.importKey('raw', hash, { name:'AES-GCM' }, false, ['encrypt','decrypt']);
}
async function encryptSeed(secret: Uint8Array, setupSecret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name:'AES-GCM',iv}, await encryptionKey(setupSecret), secret);
  return encode64(iv) + ':' + encode64(new Uint8Array(cipher));
}
async function decryptSeed(stored: string, setupSecret: string): Promise<Uint8Array> {
  const [a,b] = stored.split(':');
  if (!a || !b) throw new Error('seed unavailable');
  return new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM',iv:decode64(a) },
    await encryptionKey(setupSecret),decode64(b)));
}
/**
 * 在 Workers 单次 PBKDF2 上限内加盐派生，再以部署初始化密钥派生的独立 HMAC key 加密摘要。
 * 即使单独泄露 D1，攻击者也不能仅用数据库中的盐与摘要离线猜测口令。
 * HMAC 域与 TOTP AES key 的用途隔离；变更 BOOTSTRAP_SECRET 将使已注册管理员失效，
 * 因此初始化成功后应固定该 secret（不要以重置 secret 代替账号恢复）。
 */
async function passwordHash(password: string, salt: Uint8Array, setupSecret: string): Promise<string> {
  const passwordKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ADMIN_PBKDF2_ITERATIONS,
  }, passwordKey, 256);
  const pepperKeyBytes = await crypto.subtle.digest('SHA-256',
    encoder.encode('ff14-hub/calendar-admin/password/v2/' + setupSecret));
  const pepperKey = await crypto.subtle.importKey('raw', pepperKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', pepperKey, derived);
  return ADMIN_PASSWORD_HASH_VERSION + bytesHex(new Uint8Array(signed));
}
async function matchesPassword(password: string, row: AdminAccountRow, setupSecret: string): Promise<boolean> {
  if (!row.password_hash.startsWith(ADMIN_PASSWORD_HASH_VERSION)) return false;
  const candidate = await passwordHash(password,hexBytes(row.password_salt),setupSecret);
  return constantTimeEqualStrings(candidate,row.password_hash);
}
async function otpAt(secret: Uint8Array, counter: number): Promise<string> {
  const data = new Uint8Array(8);
  const view = new DataView(data.buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-1'},false,['sign']);
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC',key,data));
  const offset = hmac[hmac.length - 1]! & 15;
  const code = ((hmac[offset]! & 127)<<24 | hmac[offset+1]!<<16 | hmac[offset+2]!<<8 | hmac[offset+3]!) % DIGITS;
  return String(code).padStart(6,'0');
}
export async function totpForTests(seed: Uint8Array, timeMs: number): Promise<string> {
  return otpAt(seed,Math.floor(timeMs/STEP_MS));
}
export function totpSetupUri(username: string, secret: string): string {
  const label = encodeURIComponent('FF14 Hub:' + username);
  return 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=' +
    encodeURIComponent('FF14 Hub') + '&algorithm=SHA1&digits=6&period=30';
}
export async function accountRow(db: D1Database): Promise<AdminAccountRow | null> {
  return db.prepare("SELECT * FROM calendar_admin_accounts WHERE id='owner'").first<AdminAccountRow>();
}
export async function verifySetupSecret(provided: string | null, configured: string | undefined): Promise<void> {
  if (!configured || configured.length < 32 || !provided ||
      !await credentialsEqual(provided,configured)) throw new ApiError('unauthorized','认证失败');
}
/** 原子自增错误计数，超限时拒绝登录；不会将用户名、IP 明文落库。 */
export async function throttleAdmin(db: D1Database, scope: string, max = 10): Promise<void> {
  const now = Date.now(), windowMs=5*60_000;
  await db.prepare(`INSERT INTO calendar_admin_rate_limits (scope,window_started,attempts) VALUES(?,?,1)
    ON CONFLICT(scope) DO UPDATE SET
      attempts=CASE WHEN window_started < ? THEN 1 ELSE attempts+1 END,
      window_started=CASE WHEN window_started < ? THEN ? ELSE window_started END`)
    .bind(scope,now,now-windowMs,now-windowMs,now).run();
  const row=await db.prepare('SELECT attempts FROM calendar_admin_rate_limits WHERE scope=?')
    .bind(scope).first<{attempts:number}>();
  if (!row || row.attempts>max) throw new ApiError('rate_limited','尝试过于频繁，请稍后再试');
}
export async function startAdminSetup(db: D1Database, configured: string,
  username: string,password: string): Promise<{secret:string;uri:string}> {
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const secretBytes=crypto.getRandomValues(new Uint8Array(20));
  const seed=base32(secretBytes);
  const hash=await passwordHash(password,salt,configured);
  const ciphertext=await encryptSeed(secretBytes,configured);
  const result=await db.prepare(`INSERT INTO calendar_admin_accounts
    (id,username,password_salt,password_hash,totp_ciphertext,created_at)
    VALUES('owner',?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(username,bytesHex(salt),hash,ciphertext,Date.now()).run();
  if (result.meta.changes!==1) throw new ApiError('conflict','管理员已配置或正在绑定验证器');
  return {secret:seed,uri:totpSetupUri(username,seed)};
}
async function matchedStep(secret: Uint8Array, code: string, now=Date.now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const step=Math.floor(now/STEP_MS);
  for (const candidate of [step,step-1,step+1]) {
    if (candidate>=0 && constantTimeEqualStrings(await otpAt(secret,candidate),code)) return candidate;
  }
  return null;
}
export async function validateAdminCredentials(db: D1Database, configured: string | undefined,
  username: string,password: string,code: string,activate: boolean): Promise<boolean> {
  const row=await accountRow(db);
  if (!row || row.username.toLowerCase()!==username.toLowerCase() ||
      Boolean(row.activated_at)!==!activate ||
      !configured || configured.length<32 ||
      !await matchesPassword(password,row,configured)) return false;
  let seed: Uint8Array;
  try { seed=await decryptSeed(row.totp_ciphertext,configured); }
  catch { return false; }
  const step=await matchedStep(seed,code);
  if (step===null || step<=row.totp_last_step) return false;
  const result=await db.prepare(`UPDATE calendar_admin_accounts
    SET totp_last_step=?,activated_at=CASE WHEN ?=1 THEN ? ELSE activated_at END
    WHERE id='owner' AND totp_last_step<? AND
    (activated_at IS NULL AND ?=1 OR activated_at IS NOT NULL AND ?=0)`)
    .bind(step,activate?1:0,Date.now(),step,activate?1:0,activate?1:0).run();
  return result.meta.changes===1;
}
export async function issueAdminSession(db: D1Database): Promise<string> {
  const token='ffh_admin_'+bytesHex(crypto.getRandomValues(new Uint8Array(32)));
  const hash=await hashCredential(token);
  const now=Date.now();
  await db.prepare('INSERT INTO calendar_admin_sessions(token_hash,account_id,expires_at,created_at) VALUES(?,?,?,?)')
    .bind(hash,'owner',now+SESSION_MS,now).run();
  return token;
}
export async function validateAdminSession(db: D1Database, auth: string | undefined): Promise<boolean> {
  const match=/^Bearer (ffh_admin_[0-9a-f]{64})$/i.exec(auth??'');
  if (!match) return false;
  const hash=await hashCredential(match[1]!);
  const row=await db.prepare(`SELECT s.token_hash FROM calendar_admin_sessions s
    INNER JOIN calendar_admin_accounts a ON a.id=s.account_id
    WHERE s.token_hash=? AND s.expires_at>? AND a.activated_at IS NOT NULL`)
    .bind(hash,Date.now()).first<{token_hash:string}>();
  return row!==null && constantTimeEqualStrings(hash,row.token_hash);
}
export async function revokeAdminSession(db: D1Database, authorization: string | undefined): Promise<void> {
  const match=/^Bearer (ffh_admin_[0-9a-f]{64})$/i.exec(authorization??'');
  if (match) await db.prepare('DELETE FROM calendar_admin_sessions WHERE token_hash=?')
    .bind(await hashCredential(match[1]!)).run();
}
