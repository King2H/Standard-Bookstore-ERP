/**
 * Startup checks for environment configuration.
 *
 * The API refuses to start with missing, invalid or placeholder secrets, or with
 * settings that would silently weaken security. Placeholder secrets are tolerated
 * only when NODE_ENV is explicitly "development" (with a warning) or "test".
 * Any other NODE_ENV, including an unset one, is treated as production.
 */

export interface EnvCheck {
  errors: string[];
  warnings: string[];
}

export interface HttpConfig {
  /** Origins allowed to call the API cross-origin with credentials. */
  allowedOrigins: string[];
  /** Development convenience: allow any origin when FRONTEND_URL is not set. */
  allowAnyOrigin: boolean;
  /** Value for Express `trust proxy`. */
  trustProxy: boolean | number | string;
}

// Example values shipped in this repository (.env.example, docker-compose.yml,
// test and CI configuration). They are public, so they are never secret.
const PLACEHOLDER_SECRETS = new Set([
  'change_this_to_a_secure_random_string_in_production',
  'dev_jwt_secret_change_in_production',
  'test_jwt_secret_not_for_production',
  'ci_test_jwt_secret_not_for_production',
  '0000000000000000000000000000000000000000000000000000000000000001',
]);

const MIN_JWT_SECRET_LENGTH = 32;
const GENERATE_JWT = `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`;
const GENERATE_KEY = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

type Mode = 'production' | 'development' | 'test';

function modeOf(env: NodeJS.ProcessEnv): Mode {
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return env.NODE_ENV;
  return 'production';
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_SECRETS.has(value) || /^(.)\1*$/.test(value);
}

export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter((o) => o.length > 0);
}

/**
 * TRUST_PROXY is the number of reverse proxies in front of the API, or a list of
 * trusted proxy addresses/subnets (e.g. "loopback, 10.0.0.0/8"). Unset means no
 * proxy: the client address is the socket address and X-Forwarded-For is ignored.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = (value ?? '').trim();
  if (v === '' || v === 'false' || v === '0') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export function readHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const allowedOrigins = parseAllowedOrigins(env.FRONTEND_URL);
  return {
    allowedOrigins,
    allowAnyOrigin: modeOf(env) !== 'production' && allowedOrigins.length === 0,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}

export function checkEnvironment(env: NodeJS.ProcessEnv = process.env): EnvCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mode = modeOf(env);

  const placeholder = (name: string, generate: string) => {
    const message = `${name} is a published example value. Generate a real one with: ${generate}`;
    if (mode === 'production') errors.push(message);
    else if (mode === 'development') warnings.push(message);
  };

  const jwtSecret = env.JWT_SECRET ?? '';
  if (!jwtSecret) {
    errors.push(`JWT_SECRET is not set. Generate one with: ${GENERATE_JWT}`);
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    errors.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters. Generate one with: ${GENERATE_JWT}`);
  } else if (isPlaceholder(jwtSecret)) {
    placeholder('JWT_SECRET', GENERATE_JWT);
  }

  const key = env.COLUMN_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    errors.push(`COLUMN_ENCRYPTION_KEY must be a 64-character hex string. Generate one with: ${GENERATE_KEY}`);
  } else if (isPlaceholder(key.toLowerCase())) {
    placeholder('COLUMN_ENCRYPTION_KEY', GENERATE_KEY);
  }

  for (const origin of parseAllowedOrigins(env.FRONTEND_URL)) {
    let valid = false;
    try {
      const url = new URL(origin);
      valid = (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === origin;
    } catch {
      valid = false;
    }
    if (!valid) {
      errors.push(`FRONTEND_URL entry "${origin}" is not an origin (scheme://host[:port], no path).`);
    }
  }

  if ((env.TRUST_PROXY ?? '').trim() === 'true') {
    errors.push(
      'TRUST_PROXY=true would trust X-Forwarded-For from any client. ' +
        'Set it to the number of proxies in front of the API (usually 1) or their addresses.',
    );
  }

  return { errors, warnings };
}

/** Logs warnings and throws if the environment is unsafe to start with. */
export function assertEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const { errors, warnings } = checkEnvironment(env);
  for (const msg of warnings) {
    console.warn(JSON.stringify({ level: 'warn', msg }));
  }
  if (errors.length > 0) {
    throw new Error(`Unsafe configuration, refusing to start:\n- ${errors.join('\n- ')}`);
  }
}
