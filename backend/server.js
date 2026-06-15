const express = require('express');
const cors = require('cors');
const os = require('os');
const logger = require('./logger');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVICE_NAME = 'test';

// Enable CORS for frontend
app.use(cors());
app.use(express.json());

// ─── Request Logging Middleware (logs every request to SigNoz) ────────
app.use(logger.requestLogger);

// ─── Health Check Endpoint (used by ALB) ─────────────────────────────
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    uptime: process.uptime()
  });
});

// ─── Sample API Endpoints ────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  logger.info('Server info requested', { endpoint: '/api/info' });
  res.json({
    service: SERVICE_NAME,
    version: '1.0.0',
    hostname: os.hostname(),
    platform: os.platform(),
    nodeVersion: process.version,
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/items', (req, res) => {
  const category = req.query.category;
  const items = [
    { id: 1, name: 'Item Alpha', status: 'active', category: 'electronics' },
    { id: 2, name: 'Item Beta', status: 'active', category: 'clothing' },
    { id: 3, name: 'Item Gamma', status: 'inactive', category: 'electronics' }
  ];

  try {
    // BUG: category.toLowerCase() throws TypeError if category is undefined
    const filtered = items.filter(i => i.category === category.toLowerCase());
    logger.info('Items list requested', { endpoint: '/api/items', itemCount: filtered.length, category });
    res.json({ items: filtered, servedBy: os.hostname() });
  } catch (err) {
    // Explicitly mark the current span as ERROR so SigNoz traces show it
    const span = trace.getActiveSpan();
    if (span) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.setAttribute('error.type', err.constructor.name);
      span.setAttribute('error.message', err.message);
      span.setAttribute('error.stack', err.stack);
    }
    logger.error('TypeError in /api/items', {
      errorType: err.constructor.name,
      message: err.message,
      stack: err.stack,
      endpoint: '/api/items',
      category,
    });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

// ─── Orders Endpoint ─────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  const userId = req.query.userId;

  // BUG: No await, and no try/catch — unhandled promise rejection crashes Node
  const orders = fetchOrdersFromDB(userId);

  logger.info('Orders fetched', { endpoint: '/api/orders', userId, count: orders.length });
  res.json({ orders, userId });
});

// Simulates a DB call that always rejects
async function fetchOrdersFromDB(userId) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`DB connection refused for user ${userId}`)), 100)
  );
}

app.post('/api/echo', (req, res) => {
  logger.info('Echo request received', {
    endpoint: '/api/echo',
    payloadSize: JSON.stringify(req.body).length,
    payload: req.body
  });
  res.json({
    received: req.body,
    echoedAt: new Date().toISOString(),
    servedBy: os.hostname()
  });
});

// ─── Load Balancer Test Endpoint ─────────────────────────────────────
app.get('/api/lb-test', (req, res) => {
  logger.info('Load balancer test hit', {
    endpoint: '/api/lb-test',
    containerId: os.hostname(),
    forwardedFor: req.headers['x-forwarded-for'] || 'direct',
  });
  res.json({
    message: 'Load Balancer Test',
    containerId: os.hostname(),
    timestamp: new Date().toISOString(),
    requestHeaders: {
      'x-forwarded-for': req.headers['x-forwarded-for'] || 'N/A',
      'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'N/A',
      host: req.headers['host'] || 'N/A'
    }
  });
});

// ─── Simulate Error Endpoint (for RCA testing) ──────────────────────
app.get('/api/error-test', (req, res) => {
  const errorType = req.query.type || 'generic';

  if (errorType === 'timeout') {
    logger.error('Simulated timeout error', {
      errorType: 'TimeoutError',
      endpoint: '/api/error-test',
      containerId: os.hostname(),
      details: 'Database connection timed out after 30000ms'
    });
    return res.status(504).json({ error: 'Gateway Timeout', message: 'Simulated timeout' });
  }

  if (errorType === 'crash') {
    logger.error('Simulated application crash', {
      errorType: 'ApplicationError',
      endpoint: '/api/error-test',
      containerId: os.hostname(),
      stack: new Error('Simulated crash for RCA testing').stack,
      details: 'Null pointer exception in processOrder()'
    });
    res.status(500).json({ error: 'Internal Server Error', message: 'Simulated crash' });
    // Flush response then exit so ECS detects a real container crash
    res.on('finish', () => {
      logger.error('Container exiting due to simulated crash');
      setTimeout(() => process.exit(1), 100);
    });
    return;
  }

  if (errorType === 'memory') {
    logger.warn('High memory usage detected', {
      errorType: 'MemoryWarning',
      endpoint: '/api/error-test',
      containerId: os.hostname(),
      memoryUsage: process.memoryUsage(),
      heapUsedPercent: ((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100).toFixed(1)
    });
    return res.status(200).json({ warning: 'High memory usage', memoryUsage: process.memoryUsage() });
  }

  if (errorType === 'cpu_spike') {
    // Burn CPU for 60 seconds to generate a real metric anomaly
    const durationMs = parseInt(req.query.duration || '60000', 10);
    logger.warn('CPU spike simulation started', {
      errorType: 'PerformanceWarning',
      endpoint: '/api/error-test',
      containerId: os.hostname(),
      durationMs,
      details: 'Intentional CPU burn for RCA testing'
    });
    res.status(200).json({ ok: true, message: `CPU spike started for ${durationMs}ms` });
    // Run the burn in a microtask after the response is sent
    const end = Date.now() + durationMs;
    setImmediate(function burn() {
      const now = Date.now();
      if (now < end) {
        // Tight synchronous loop — burns one CPU core at ~100%
        const stop = now + 50; // 50ms slices to avoid completely starving event loop
        while (Date.now() < stop) { /* spin */ }
        setImmediate(burn);
      } else {
        logger.info('CPU spike simulation ended', { containerId: os.hostname(), durationMs });
      }
    });
    return;
  }

  if (errorType === 'memory_leak') {
    // Leak memory until the container OOMs (~200MB allocated, held in closure)
    const leakMb = parseInt(req.query.mb || '200', 10);
    logger.warn('Memory leak simulation started', {
      errorType: 'MemoryWarning',
      endpoint: '/api/error-test',
      containerId: os.hostname(),
      leakMb,
      details: 'Intentional memory leak for RCA testing — OOM kill expected'
    });
    const leak = [];
    for (let i = 0; i < leakMb; i++) {
      leak.push(Buffer.alloc(1024 * 1024, 'x')); // 1 MB per iteration
    }
    // Hold the reference so GC can't reclaim it
    global.__leak = leak;
    return res.status(200).json({
      ok: true,
      message: `Allocated ${leakMb}MB — heap will stay elevated`,
      heapUsed: process.memoryUsage().heapUsed
    });
  }

  logger.error('Generic error occurred', {
    errorType: 'GenericError',
    endpoint: '/api/error-test',
    containerId: os.hostname(),
    message: 'Something went wrong'
  });
  res.status(500).json({ error: 'Internal Server Error', message: 'Generic error for RCA testing' });
});

// ─── Global Error Handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  // Explicitly mark span as ERROR so it shows in SigNoz traces
  const span = trace.getActiveSpan();
  if (span) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.setAttribute('error.type', err.constructor.name);
    span.setAttribute('error.message', err.message);
  }
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    containerId: os.hostname(),
  });
  res.status(500).json({ error: 'Internal Server Error' });
});

// ─── Start Server ────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Service "${SERVICE_NAME}" started`, {
    port: PORT,
    hostname: os.hostname(),
    nodeEnv: process.env.NODE_ENV || 'development',
    otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'not configured',
    pid: process.pid,
  });
  console.log(`🚀 [${SERVICE_NAME}] Backend running on port ${PORT}`);
  console.log(`📍 Hostname: ${os.hostname()}`);
  console.log(`🔗 Health: http://localhost:${PORT}/api/health`);
});
