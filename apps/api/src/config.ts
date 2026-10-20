import { z } from 'zod';
import { DEFAULT_SITE_TZ } from './db.js';

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1),
  /** Public URL of the web app. Used to build invite links. */
  APP_URL: z.url(),
  /** WebAuthn relying-party ID: the web app's domain, e.g. "tooltrace.vercel.app". */
  RP_ID: z.string().min(1),
  RP_NAME: z.string().min(1).default('ToolTrace'),
  /** Comma-separated list of origins allowed to use passkeys and send state-changing requests. */
  RP_ORIGINS: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.url()).min(1)),
  /** Must be true in production. Only false for plain-http local development. */
  COOKIE_SECURE: bool.default(true),
  /** Trust X-Forwarded-For (set to true only behind a known reverse proxy such as Render or Vercel). */
  TRUST_PROXY: bool.default(false),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(336).default(72),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  /** Requests per minute per signed-in person, across the whole API. */
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  /** Shared rate-limit counters, e.g. rediss://default:pass@xyz.upstash.io:6379. In memory if unset. */
  REDIS_URL: z.string().optional(),
  /**
   * If set, /api only answers requests that carry this secret in X-ToolTrace-Proxy: the
   * web app's proxy adds it, so the API can't be called directly from the internet.
   */
  PROXY_SECRET: z.string().min(32).optional(),
  /**
   * Public demo: one-click personas that sign in without a passkey. Only allowed on a
   * database marked as a demo database (see src/demo/demo.ts). Never on real data.
   */
  DEMO_MODE: bool.default(false),

  // --- Smart tool stations (optional) ---------------------------------------
  /** Secret from which every station's signing key is derived. 32+ random bytes, hex or base64. */
  STATION_MASTER_KEY: z.string().min(43).optional(),
  /** MQTT broker the stations talk to, e.g. mqtts://xyz.hivemq.cloud:8883 */
  MQTT_URL: z.string().optional(),
  MQTT_USERNAME: z.string().optional(),
  MQTT_PASSWORD: z.string().optional(),
  MQTT_TOPIC_PREFIX: z.string().regex(/^[a-z0-9/_-]+$/).default('tooltrace/v1'),
  /** Development only: run a tiny MQTT broker inside the API on this port. */
  DEV_MQTT_BROKER_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /** How long a checkout made at a station lasts. */
  STATION_CHECKOUT_HOURS: z.coerce.number().int().min(1).max(72).default(8),
  /** How long a badge tap stays valid while the person taps their tools. */
  STATION_SESSION_SECONDS: z.coerce.number().int().min(5).max(300).default(30),

  // --- Data sources (optional) -----------------------------------------------
  /**
   * Encrypts saved database passwords (AES-256-GCM). 32+ random bytes, hex or base64.
   * Without it, Excel/CSV imports still work but database connections are switched off.
   */
  DATA_SOURCE_KEY: z.string().min(43).optional(),
  /**
   * Allow connections to private and loopback addresses (10.x, 192.168.x, localhost...).
   * Off by default, so the server can't be used to probe its own network. Turn it on for
   * an on-premises install whose databases live on the factory network.
   */
  DATA_SOURCES_ALLOW_PRIVATE: bool.default(false),

  // --- Site ------------------------------------------------------------------
  /**
   * The plant's time zone (IANA name). "Today" means today on the shop floor: calibration
   * due dates expire at local midnight, and a calibration done today is never "in the future".
   * The nightly ML job reads the same variable.
   */
  TOOLTRACE_SITE_TZ: z
    .string()
    .default(DEFAULT_SITE_TZ)
    .refine(isTimeZone, 'must be an IANA time zone such as Asia/Kolkata or Europe/Berlin'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.COOKIE_SECURE) {
    throw new Error('Invalid configuration: COOKIE_SECURE must be true in production');
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DEV_MQTT_BROKER_PORT) {
    throw new Error('Invalid configuration: DEV_MQTT_BROKER_PORT is for development only');
  }
  return parsed.data;
}
