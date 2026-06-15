// ═══════════════════════════════════════════════════════════════════
// ECS Dashboard - Frontend Application
// ═══════════════════════════════════════════════════════════════════

// ─── Configuration ───────────────────────────────────────────────────
// When deployed behind ALB, the backend is on the same host via path-based routing
// For local dev, change this to http://localhost:3000
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : '';  // Empty string = same origin (via ALB path routing)

// ─── State ───────────────────────────────────────────────────────────
let requestCount = 0;
const containerHits = {};

// ─── DOM References ──────────────────────────────────────────────────
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const healthStatus = document.getElementById('healthStatus');
const containerIdEl = document.getElementById('containerId');
const uptimeEl = document.getElementById('uptime');
const requestCountEl = document.getElementById('requestCount');

// ─── Utility Functions ──────────────────────────────────────────────
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function addLogEntry(method, endpoint, status) {
  const logEntries = document.getElementById('logEntries');
  const placeholder = logEntries.querySelector('.placeholder-text');
  if (placeholder) placeholder.remove();

  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-method ${method.toLowerCase()}">${method}</span>
    <span class="log-endpoint">${endpoint}</span>
    <span class="log-status ${status < 400 ? 'success' : 'error'}">${status}</span>
  `;

  logEntries.insertBefore(entry, logEntries.firstChild);

  // Keep max 50 entries
  while (logEntries.children.length > 50) {
    logEntries.removeChild(logEntries.lastChild);
  }

  requestCount++;
  requestCountEl.textContent = requestCount;
}

async function apiCall(method, endpoint, body = null) {
  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`${API_BASE}${endpoint}`, options);
    const data = await response.json();
    addLogEntry(method, endpoint, response.status);
    return data;
  } catch (error) {
    addLogEntry(method, endpoint, 0);
    console.error(`API call failed: ${endpoint}`, error);
    return null;
  }
}

// ─── Health Check ────────────────────────────────────────────────────
async function checkHealth() {
  const data = await apiCall('GET', '/api/health');
  if (data) {
    statusDot.className = 'status-dot online';
    statusText.textContent = 'Connected';
    healthStatus.textContent = data.status.toUpperCase();
    containerIdEl.textContent = data.hostname || '--';
    uptimeEl.textContent = formatUptime(data.uptime || 0);

    const healthCard = document.getElementById('healthCard');
    healthCard.style.borderColor = 'rgba(52, 211, 153, 0.3)';
  } else {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Disconnected';
    healthStatus.textContent = 'OFFLINE';
  }
}

// ─── Load Balancer Test ──────────────────────────────────────────────
async function testLoadBalancer() {
  const btn = document.getElementById('lbTestBtn');
  btn.textContent = 'Sending...';
  btn.disabled = true;

  const data = await apiCall('GET', '/api/lb-test');
  const resultsBox = document.getElementById('lbResults');

  if (data) {
    const placeholder = resultsBox.querySelector('.placeholder-text');
    if (placeholder) resultsBox.innerHTML = '';

    // Track container distribution
    const id = data.containerId || 'unknown';
    containerHits[id] = (containerHits[id] || 0) + 1;

    const entry = document.createElement('div');
    entry.style.marginBottom = '0.5rem';
    entry.style.paddingBottom = '0.5rem';
    entry.style.borderBottom = '1px solid rgba(148, 163, 184, 0.08)';
    entry.innerHTML = `
      <span style="color: #6366f1;">▸</span>
      <span style="color: #94a3b8;">${data.timestamp}</span>
      &nbsp;→&nbsp;
      <span style="color: #34d399; font-weight: 600;">${data.containerId}</span>
    `;
    resultsBox.insertBefore(entry, resultsBox.firstChild);

    updateDistributionChart();
  } else {
    resultsBox.innerHTML = '<p style="color: #f87171;">❌ Failed to reach backend</p>';
  }

  btn.textContent = 'Send Request';
  btn.disabled = false;
}

async function burstTest() {
  const btn = document.getElementById('lbBurstBtn');
  btn.textContent = 'Sending...';
  btn.disabled = true;

  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(
      new Promise(resolve => setTimeout(() => resolve(testLoadBalancer()), i * 100))
    );
  }
  await Promise.all(promises);

  btn.textContent = 'Burst 10 Requests';
  btn.disabled = false;
}

function updateDistributionChart() {
  const section = document.getElementById('distributionSection');
  const barsContainer = document.getElementById('distributionBars');
  section.style.display = 'block';

  const total = Object.values(containerHits).reduce((a, b) => a + b, 0);
  barsContainer.innerHTML = '';

  for (const [id, count] of Object.entries(containerHits)) {
    const pct = ((count / total) * 100).toFixed(1);
    const item = document.createElement('div');
    item.className = 'distribution-bar-item';
    item.innerHTML = `
      <span class="distribution-bar-label">${id.substring(0, 12)}</span>
      <div class="distribution-bar-track">
        <div class="distribution-bar-fill" style="width: ${pct}%">${count} (${pct}%)</div>
      </div>
    `;
    barsContainer.appendChild(item);
  }
}

// ─── Server Info ─────────────────────────────────────────────────────
async function fetchServerInfo() {
  const data = await apiCall('GET', '/api/info');
  const container = document.getElementById('serverInfo');

  if (data) {
    const memMB = (data.memoryUsage?.rss / 1024 / 1024).toFixed(1);
    container.innerHTML = `
      <div class="info-row"><span class="info-key">Service</span><span class="info-val">${data.service}</span></div>
      <div class="info-row"><span class="info-key">Version</span><span class="info-val">${data.version}</span></div>
      <div class="info-row"><span class="info-key">Hostname</span><span class="info-val">${data.hostname}</span></div>
      <div class="info-row"><span class="info-key">Platform</span><span class="info-val">${data.platform}</span></div>
      <div class="info-row"><span class="info-key">Node Version</span><span class="info-val">${data.nodeVersion}</span></div>
      <div class="info-row"><span class="info-key">Memory (RSS)</span><span class="info-val">${memMB} MB</span></div>
      <div class="info-row"><span class="info-key">Timestamp</span><span class="info-val">${data.timestamp}</span></div>
    `;
  } else {
    container.innerHTML = '<p style="color: #f87171;">❌ Failed to fetch server info</p>';
  }
}

// ─── Items API ───────────────────────────────────────────────────────
async function fetchItems() {
  const data = await apiCall('GET', '/api/items');
  const container = document.getElementById('itemsList');

  if (data && data.items) {
    container.innerHTML = data.items.map(item => `
      <div class="item-card">
        <span class="item-name">#${item.id} ${item.name}</span>
        <span class="item-badge ${item.status}">${item.status}</span>
      </div>
    `).join('');

    const served = document.createElement('p');
    served.style.cssText = 'margin-top: 0.75rem; font-size: 0.75rem; color: #64748b;';
    served.textContent = `Served by: ${data.servedBy}`;
    container.appendChild(served);
  } else {
    container.innerHTML = '<p style="color: #f87171;">❌ Failed to fetch items</p>';
  }
}

// ─── Echo Test ───────────────────────────────────────────────────────
async function sendEcho() {
  const input = document.getElementById('echoInput').value.trim();
  const resultsBox = document.getElementById('echoResults');

  let body;
  try {
    body = input ? JSON.parse(input) : { message: 'Hello ECS!' };
  } catch (e) {
    resultsBox.innerHTML = '<p style="color: #fbbf24;">⚠️ Invalid JSON. Using default payload.</p>';
    body = { message: 'Hello ECS!', note: 'Original input was invalid JSON' };
  }

  const data = await apiCall('POST', '/api/echo', body);
  if (data) {
    resultsBox.innerHTML = `<pre style="white-space: pre-wrap; color: #94a3b8;">${JSON.stringify(data, null, 2)}</pre>`;
  } else {
    resultsBox.innerHTML = '<p style="color: #f87171;">❌ Failed to send echo</p>';
  }
}

// ─── Clear Log ───────────────────────────────────────────────────────
function clearLog() {
  const logEntries = document.getElementById('logEntries');
  logEntries.innerHTML = '<p class="placeholder-text">Requests will appear here...</p>';
}

// ─── Initialize ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkHealth();
  // Auto-refresh health every 15 seconds
  setInterval(checkHealth, 15000);
});
