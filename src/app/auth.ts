import { timingSafeEqual } from 'node:crypto';

export interface Credentials {
  user: string;
  password: string;
}

/** Credentials from TRIALS_AUTH_USER / TRIALS_AUTH_PASSWORD. Neither set means no login; one without the other is an error. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials | undefined {
  const user = env.TRIALS_AUTH_USER?.trim();
  const password = env.TRIALS_AUTH_PASSWORD;
  if (!user && !password) return undefined;
  if (!user || !password) throw new Error('set both TRIALS_AUTH_USER and TRIALS_AUTH_PASSWORD, or neither');
  return { user, password };
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Compare equal-length buffers in constant time; a length mismatch already tells nothing useful here.
  return x.length === y.length && timingSafeEqual(x, y);
};

/** True when an Authorization header carries the right Basic credentials. */
export function basicAuthOk(header: string | undefined, creds: Credentials): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const userOk = same(decoded.slice(0, i), creds.user);
  const passOk = same(decoded.slice(i + 1), creds.password);
  return userOk && passOk;
}

export const CHALLENGE = { 'www-authenticate': 'Basic realm="Prompt Trials", charset="UTF-8"' };
