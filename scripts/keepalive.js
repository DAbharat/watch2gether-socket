// Standalone Keep-Alive Ping Script for Render
// Can be run locally, in background, or on a secondary machine/cron to keep Render awake.

const TARGET_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || 'https://watch2gether-socket.onrender.com';
const INTERVAL_MINS = Number(process.env.KEEP_ALIVE_INTERVAL_MINS) || 10;
const HEALTH_ENDPOINT = `${TARGET_URL.replace(/\/$/, '')}/health`;

console.log('='.repeat(65));
console.log('Watch2Gether Socket Keep-Alive Ping Service');
console.log(`Target:   ${HEALTH_ENDPOINT}`);
console.log(`Interval: Every ${INTERVAL_MINS} minutes`);
console.log('='.repeat(65));

async function ping() {
  const time = new Date().toLocaleTimeString();
  try {
    const res = await fetch(HEALTH_ENDPOINT, {
      method: 'GET',
      headers: { 'User-Agent': 'Watch2Gether-KeepAlive-Worker/1.0' },
    });
    console.log(`[${time}] Ping OK (HTTP ${res.status}) -> ${HEALTH_ENDPOINT}`);
  } catch (err) {
    console.warn(`[${time}] Ping error:`, err?.message || err);
  }
}

// Initial ping, then recurring
ping();
setInterval(ping, INTERVAL_MINS * 60 * 1000);

