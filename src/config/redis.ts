import 'dotenv/config';
import { Redis } from "ioredis";

declare global {
  var redisClient: Redis | undefined;
}

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redisOptions: any = {
  maxRetriesPerRequest: null,
  connectTimeout: Number(process.env.REDIS_TIMEOUT) || 5000,
  retryStrategy(times: number) {
    const maxRetry = Number(process.env.REDIS_MAX_RETRY) || 5;

    if (times >= maxRetry) {
      console.error(`Redis connection failed after ${times} attempts.`);
      return null;
    }

    const delay = Math.min(times * 200, 2000);
    console.warn(`Redis connection failed. Retrying in ${delay}ms... (Attempt ${times}/${maxRetry})`);

    return delay;
  }
};

// Enable TLS for secure connections (e.g. Render external Redis rediss:// URL)
if (REDIS_URL.startsWith('rediss://')) {
  redisOptions.tls = {
    rejectUnauthorized: false
  };
}

const createRedisClient = () => new Redis(REDIS_URL, redisOptions);

const redis = global.redisClient || createRedisClient();

if (process.env.NODE_ENV !== "production") {
  global.redisClient = redis;
}

redis.on("connect", () => {
  console.log("Connected to Redis successfully.");
});

redis.on("ready", () => {
  console.log("Redis connection is ready to use.");
});

redis.on("error", (err: Error) => {
  console.error("Redis error:", err.message);
});

redis.on("close", () => {
  console.warn("Redis connection closed");
});

redis.on("reconnecting", () => {
  console.log("Redis reconnecting...");
});

let isShuttingDown = false;

export async function shutDown(signal?: string) {
  if (isShuttingDown) return;

  isShuttingDown = true;

  if (signal) {
    console.log(`Received ${signal}. Closing Redis...`);
  }

  const forceExit = setTimeout(() => {
    console.error("Redis shutdown timeout. Force exiting...");
    process.exit(1);
  }, 5000);

  try {
    await redis.quit();
    clearTimeout(forceExit);
    console.log("Redis closed gracefully");
  } catch (error: any) {
    clearTimeout(forceExit);
    console.error("Shutdown failed: ", error.message);
  }
}

process.on("SIGINT", async () => {
  await shutDown("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutDown("SIGTERM");
  process.exit(0);
});

export async function healthCheck() {
  const start = Date.now();

  try {
    const response = await redis.ping();

    return {
      status: response === "PONG" ? "ok" : "error",
      latency: Date.now() - start
    };
  } catch (error: any) {
    return {
      status: "error",
      message: error.message
    };
  }
}

export default redis;
