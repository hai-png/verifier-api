import { createLogger, format, transports, Logger } from 'winston';
import 'winston-daily-rotate-file';
import { shouldSuppressSensitiveLogs } from './sensitiveLogContext';

const { combine, timestamp, printf, errors, colorize } = format;

const redactSensitiveStatusProbeLogs = format((info) => {
    if (!shouldSuppressSensitiveLogs()) return info;
    for (const key of Object.keys(info)) {
        if (!['level', 'timestamp', 'service'].includes(key)) delete info[key];
    }
    info.message = 'Status provider probe activity redacted.';
    info.statusProbe = true;
    return info;
});

// 🎨 Fancy Console Format with Emojis and Timestamp
const emojiFormat = printf(info => {
    const { level, message, timestamp, stack, ...meta } = info;

    const emojis: Record<string, string> = {
        info: 'ℹ️ ',
        warn: '⚠️ ',
        error: '❌',
        debug: '🐛',
    };

    const emoji = emojis[level] || '';
    let log = `${emoji}[${timestamp}] ${level.toUpperCase()}: ${message}`;

    if (stack) {
        log += `\n🔍 Stack:\n${stack}`;
    }

    const { service, ...rest } = meta;
    const extraMeta = Object.keys(rest).length > 0 ? rest : null;

    if (extraMeta) {
        const formatted = JSON.stringify(extraMeta, null, 2).replace(/^/gm, '   › ');
        log += `\n📦 Metadata:\n${formatted}`;
    }

    return log;
});

// 📝 Plain Format for File Logging
const fileFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    if (stack) log += `\n${stack}`;
    if (Object.keys(meta).length > 0) {
        log += `\n${JSON.stringify(meta, null, 2)}`;
    }
    return log;
});

// 🔒 Redact credentials before any transport renders them.
//
// This lives in the shared format pipeline rather than on a single file
// transport, because the Console transport is what the platform actually
// captures: redaction applied to only one transport left every secret intact on
// stdout. Request bodies reach the logger from the request logger, so a
// POST /auth/login body used to be written with the plaintext password intact.
const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|apikey|api_key|authorization|cookie|signature|credential|otp|pin)/i;
const REDACTED = '[redacted]';

// Values that look like a long random/encoded string are masked even when the
// key is innocuous (`body`, `query`, `url`), because credentials and session
// tokens travel under those keys.
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
    /^(sk_live_|sk_test_)\S+/i,          // API keys
    /^nvd_sess_\S+/i,                    // session tokens
    /\bBearer\s+\S+/i,                   // authorization header values
];

function looksSensitiveValue(value: unknown): boolean {
    if (typeof value !== 'string' || value.length < 8) return false;
    return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
        if (looksSensitiveValue(value)) return REDACTED;
        // A JSON string can itself contain a nested credential, e.g. a
        // serialised request body or query string.
        if (value.includes('{') || value.includes('"')) return redactSerialized(value);
        return value;
    }
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === 'object') return redactObject(value as Record<string, unknown>);
    return value;
}

function redactSerialized(text: string): string {
    let result = text;
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
        result = result.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), REDACTED);
    }
    return result;
}

function redactObject(input: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(value);
    }
    return output;
}

// Winston merges `logger.info(message, meta)` into the info object at the top
// level, so redact every own key rather than a nested `meta` property.
const redactSecrets = format((info) => {
    for (const key of Object.keys(info)) {
        if (key === 'level' || key === 'message') continue;
        info[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(info[key]);
    }
    return info;
})();

// 🗂 Error Log File (Rotating)
const errorRotateFile = new transports.DailyRotateFile({
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    maxSize: '5m',
    maxFiles: '14d',
    format: combine(
        errors({ stack: true }),
        redactSensitiveStatusProbeLogs(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        fileFormat
    )
});

// 🗂 Combined Log File (Rotating)
const combinedRotateFile = new transports.DailyRotateFile({
    filename: 'logs/combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '5m',
    maxFiles: '14d',
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        fileFormat
    )
});

// File transports write to the container's ephemeral disk. On a free tier that
// is both wasted I/O and lost on every redeploy (the platform already captures
// stdout), so they can be turned off with LOG_TO_FILES=false.
const LOG_TO_FILES = (process.env.LOG_TO_FILES ?? 'true').toLowerCase() !== 'false';

// 🧠 Main Winston Logger
const logger = createLogger({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    format: combine(
        errors({ stack: true }),
        redactSecrets,
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        fileFormat
    ),
    defaultMeta: { service: 'verifier-api' },
    transports: [
        new transports.Console({
            format: combine(
                redactSecrets,
                colorize(),
                timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                emojiFormat
            )
        }),
        ...(LOG_TO_FILES ? [errorRotateFile, combinedRotateFile] : [])
    ],
    exitOnError: false
});

// ➕ Optional stream for morgan logging
interface CustomLogger extends Omit<Logger, 'stream'> {
    stream?: { write(message: string): void };
}

const customLogger = logger as unknown as CustomLogger;
customLogger.stream = {
    write: (message: string) => {
        logger.info(message.trim());
    }
};

export default customLogger;
