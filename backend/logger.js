// ═══════════════════════════════════════════════════════════════════
// Structured Logger with OpenTelemetry Integration
// ═══════════════════════════════════════════════════════════════════
// Logs are:
//   1. Printed to stdout (for CloudWatch / local dev)
//   2. Sent to SigNoz via OpenTelemetry OTLP (for RCA agent)
// ═══════════════════════════════════════════════════════════════════

const winston = require('winston');
const os = require('os');

// Try to load the OTEL winston transport (sends logs to SigNoz)
let OpenTelemetryTransportV3;
try {
  OpenTelemetryTransportV3 = require('@opentelemetry/winston-transport').OpenTelemetryTransportV3;
} catch (err) {
  console.warn('[Logger] OpenTelemetry winston transport not available, logs will only go to stdout');
}

// ─── Custom Format ───────────────────────────────────────────────────
const structuredFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const log = {
      timestamp,
      level,
      service: 'test',
      hostname: os.hostname(),
      message,
      ...meta,
    };
    return JSON.stringify(log);
  })
);

// ─── Console Format (colorized for local dev) ────────────────────────
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${message}${extra}`;
  })
);

// ─── Transports ──────────────────────────────────────────────────────
const transports = [];

// Always log to stdout (picked up by CloudWatch in ECS)
if (process.env.NODE_ENV === 'production') {
  // JSON format for production (easy to parse in CloudWatch/SigNoz)
  transports.push(
    new winston.transports.Console({ format: structuredFormat })
  );
} else {
  // Pretty format for local development
  transports.push(
    new winston.transports.Console({ format: consoleFormat })
  );
}

// OpenTelemetry transport → sends logs to SigNoz via OTLP
if (OpenTelemetryTransportV3) {
  transports.push(
    new OpenTelemetryTransportV3({
      // Log level to send to SigNoz
      level: 'info',
    })
  );
}

// ─── Create Logger ───────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: {
    service: 'test',
    hostname: os.hostname(),
    pid: process.pid,
  },
  transports,
});

// ─── Request Logger Middleware ────────────────────────────────────────
logger.requestLogger = (req, res, next) => {
  const start = Date.now();

  // Log when response finishes
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration_ms: duration,
      ip: req.headers['x-forwarded-for'] || req.ip,
      userAgent: req.headers['user-agent'],
      contentLength: res.get('content-length'),
    };

    if (res.statusCode >= 500) {
      logger.error(`${req.method} ${req.path} ${res.statusCode}`, logData);
    } else if (res.statusCode >= 400) {
      logger.warn(`${req.method} ${req.path} ${res.statusCode}`, logData);
    } else {
      logger.info(`${req.method} ${req.path} ${res.statusCode}`, logData);
    }
  });

  next();
};

module.exports = logger;
