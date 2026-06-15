# ─── Stage 1: Build ──────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# ─── Stage 2: Production ─────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy built dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Switch to non-root user
USER appuser

# Environment variables (overridden by ECS task definition)
ENV NODE_ENV=production
ENV PORT=3000
ENV OTEL_SERVICE_NAME=test
ENV OTEL_EXPORTER_OTLP_ENDPOINT=https://signoz.decodeage.in

# Expose the port
EXPOSE 3000

# Health check for Docker / ECS
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

# Start with OpenTelemetry instrumentation loaded first
CMD ["node", "--require", "./instrumentation.js", "server.js"]
