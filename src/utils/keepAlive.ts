/**
 * Self-ping keep-alive service.
 * Periodically pings the public server endpoint (e.g., /health on Render)
 * to reset the 15-minute inactivity idle timer and prevent the instance
 * from spinning down into sleep mode.
 */
export function startKeepAlive() {
  const targetUrl = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
  if (!targetUrl) {
    return;
  }

  const cleanUrl = targetUrl.trim().replace(/\/$/, '');
  const healthEndpoint = `${cleanUrl}/health`;
  const intervalMins = Number(process.env.KEEP_ALIVE_INTERVAL_MINS) || 10;
  const INTERVAL_MS = intervalMins * 60 * 1000;

  console.log(`[KeepAlive] Active: Pinging ${healthEndpoint} every ${intervalMins} minutes to prevent Render sleep.`);

  const ping = async () => {
    try {
      const res = await fetch(healthEndpoint, {
        method: 'GET',
        headers: { 'User-Agent': 'Watch2Gether-KeepAlive/1.0' },
      });
      const timestamp = new Date().toLocaleTimeString();
      console.log(`[KeepAlive] [${timestamp}] Self-ping OK (${res.status}) -> ${healthEndpoint}`);
    } catch (err: any) {
      console.warn(`[KeepAlive] Self-ping failed to ${healthEndpoint}:`, err?.message || err);
    }
  };

  // Stagger first ping by 1 minute, then run on the recurring interval
  setTimeout(ping, 60 * 1000);
  const timer = setInterval(ping, INTERVAL_MS);

  if (timer.unref) {
    timer.unref();
  }
}

