// ═══════════════════════════════════════════════════════════════════
// OpenTelemetry Instrumentation for SigNoz
// ═══════════════════════════════════════════════════════════════════
// This file MUST be loaded before any other module via:
//   node --require ./instrumentation.js server.js
// ═══════════════════════════════════════════════════════════════════

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT } = require('@opentelemetry/semantic-conventions');
const { SpanStatusCode } = require('@opentelemetry/api');

// Trace exporter → SigNoz
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

// Log exporter → SigNoz
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { BatchLogRecordProcessor, LoggerProvider } = require('@opentelemetry/sdk-logs');

// Auto-instrumentation (HTTP, Express, etc.)
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

// ─── Configuration ───────────────────────────────────────────────────
const OTEL_EXPORTER_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'https://signoz.decodeage.in';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'test';
const ENVIRONMENT = process.env.NODE_ENV || 'development';

console.log(`[OTEL] Initializing OpenTelemetry for service: ${SERVICE_NAME}`);
console.log(`[OTEL] Exporting to SigNoz at: ${OTEL_EXPORTER_ENDPOINT}`);

// ─── Resource (identifies this service in SigNoz) ────────────────────
const resource = new Resource({
  [ATTR_SERVICE_NAME]: SERVICE_NAME,
  [ATTR_SERVICE_VERSION]: '1.0.0',
  [ATTR_DEPLOYMENT_ENVIRONMENT]: ENVIRONMENT,
  'service.namespace': 'test-ecs',
  'host.name': require('os').hostname(),
});

// ─── Trace Exporter ──────────────────────────────────────────────────
const traceExporter = new OTLPTraceExporter({
  url: `${OTEL_EXPORTER_ENDPOINT}/v1/traces`,
  headers: process.env.SIGNOZ_ACCESS_TOKEN
    ? { 'signoz-access-token': process.env.SIGNOZ_ACCESS_TOKEN }
    : {},
});

// ─── Log Exporter ────────────────────────────────────────────────────
const logExporter = new OTLPLogExporter({
  url: `${OTEL_EXPORTER_ENDPOINT}/v1/logs`,
  headers: process.env.SIGNOZ_ACCESS_TOKEN
    ? { 'signoz-access-token': process.env.SIGNOZ_ACCESS_TOKEN }
    : {},
});

// ─── Logger Provider (for OTEL Logs API) ─────────────────────────────
const loggerProvider = new LoggerProvider({ resource });
loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(logExporter));

// ─── Initialize SDK ─────────────────────────────────────────────────
const sdk = new NodeSDK({
  resource,
  traceExporter,
  logRecordProcessor: new BatchLogRecordProcessor(logExporter),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Instrument HTTP requests → traces appear in SigNoz APM
      '@opentelemetry/instrumentation-http': {
        enabled: true,
        // ─── Mark 5XX responses as ERROR spans in SigNoz traces ──────
        responseHook: (span, response) => {
          const status = response.statusCode || (response.status);
          if (status >= 500) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `HTTP ${status} response`,
            });
            span.setAttribute('http.error', true);
            span.setAttribute('error', true);
            span.setAttribute('http.status_code', status);
            span.setAttribute('http.response.status_code', status);
          }
        },
        // ─── Record exceptions thrown during request handling ─────────
        applyCustomAttributesOnSpan: (span, request, response) => {
          const status = response.statusCode || response.status;
          if (status) {
            span.setAttribute('http.status_code', status);
            span.setAttribute('http.response.status_code', status);
          }
          if (status >= 500) {
            span.setAttribute('error.type', 'HTTPError');
          }
        },
      },
      // Instrument Express routes → route-level traces
      '@opentelemetry/instrumentation-express': {
        enabled: true,
      },
      // Disable noisy fs instrumentation
      '@opentelemetry/instrumentation-fs': {
        enabled: false,
      },
    }),
  ],
});

sdk.start();
console.log(`[OTEL] ✅ OpenTelemetry SDK started — traces & logs → SigNoz`);

// Graceful shutdown
const shutdown = async () => {
  console.log('[OTEL] Shutting down OpenTelemetry SDK...');
  try {
    await sdk.shutdown();
    console.log('[OTEL] SDK shut down successfully');
  } catch (err) {
    console.error('[OTEL] Error shutting down SDK:', err);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
