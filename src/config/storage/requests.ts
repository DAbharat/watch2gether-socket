import redis from '../redis.js';

const ROOM_TTL = Number(process.env.ROOM_TTL) || 60 * 60 * 24;
const PENDING_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

export interface VideoRequest {
  requestId: string;
  userId: string;
  username: string;
  videoId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  action?: 'play_now' | 'queue' | 'reject';
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface QueueItem {
  videoId: string;
  requestedBy: string;
  requestedByUsername: string;
  approvedAt: number;
}

export async function saveRequest(roomId: string, request: VideoRequest): Promise<void> {
  const key = `room:${roomId}:requests`;
  await redis
    .multi()
    .hset(key, request.requestId, JSON.stringify(request))
    .expire(key, ROOM_TTL)
    .exec();
}

export async function getRequest(roomId: string, requestId: string): Promise<VideoRequest | null> {
  const key = `room:${roomId}:requests`;
  const raw = await redis.hget(key, requestId);
  if (!raw) return null;
  try {
    const req = JSON.parse(raw) as VideoRequest;
    // Check if expired
    if (req.status === 'pending' && Date.now() - req.createdAt > PENDING_EXPIRY_MS) {
      req.status = 'rejected';
      req.resolvedAt = Date.now();
      await redis.hset(key, requestId, JSON.stringify(req));
    }
    return req;
  } catch {
    return null;
  }
}

export async function updateRequest(roomId: string, request: VideoRequest): Promise<void> {
  const key = `room:${roomId}:requests`;
  await redis
    .multi()
    .hset(key, request.requestId, JSON.stringify(request))
    .expire(key, ROOM_TTL)
    .exec();
}

export async function getAllRequests(roomId: string): Promise<VideoRequest[]> {
  const key = `room:${roomId}:requests`;
  const rawAll = await redis.hgetall(key);
  if (!rawAll) return [];

  const requests: VideoRequest[] = [];
  const now = Date.now();
  const toUpdate: Record<string, string> = {};

  for (const [id, raw] of Object.entries(rawAll)) {
    try {
      const parsed = JSON.parse(raw) as VideoRequest;
      if (parsed.status === 'pending' && now - parsed.createdAt > PENDING_EXPIRY_MS) {
        parsed.status = 'rejected';
        parsed.resolvedAt = now;
        toUpdate[id] = JSON.stringify(parsed);
      }
      requests.push(parsed);
    } catch {
      // Ignore corrupted entries
    }
  }

  if (Object.keys(toUpdate).length > 0) {
    await redis.hset(key, toUpdate);
  }

  return requests.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getUserRequests(roomId: string, userId: string): Promise<VideoRequest[]> {
  const all = await getAllRequests(roomId);
  return all.filter((r) => r.userId === userId);
}

export async function getUserPendingCount(roomId: string, userId: string): Promise<number> {
  const all = await getAllRequests(roomId);
  return all.filter((r) => r.userId === userId && r.status === 'pending').length;
}

export async function removeUserPendingRequests(roomId: string, userId: string): Promise<string[]> {
  const key = `room:${roomId}:requests`;
  const rawAll = await redis.hgetall(key);
  if (!rawAll) return [];

  const droppedIds: string[] = [];
  for (const [id, raw] of Object.entries(rawAll)) {
    try {
      const parsed = JSON.parse(raw) as VideoRequest;
      if (parsed.userId === userId && parsed.status === 'pending') {
        droppedIds.push(id);
      }
    } catch {
      // ignore
    }
  }

  if (droppedIds.length > 0) {
    await redis.hdel(key, ...droppedIds);
  }

  return droppedIds;
}

export async function checkRateLimit(roomId: string, userId: string): Promise<boolean> {
  const key = `room:${roomId}:ratelimit:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60);
  }
  return count <= 5;
}

export async function checkDuplicate(roomId: string, videoId: string): Promise<boolean> {
  // Check pending requests
  const requests = await getAllRequests(roomId);
  const isPending = requests.some((r) => r.status === 'pending' && r.videoId === videoId);
  if (isPending) return true;

  // Check queue
  const queue = await getQueue(roomId);
  const isInQueue = queue.some((q) => q.videoId === videoId);
  if (isInQueue) return true;

  return false;
}

export async function addToQueue(roomId: string, item: QueueItem): Promise<number> {
  const key = `room:${roomId}:queue`;
  const currentLen = await redis.llen(key);
  if (currentLen >= 20) {
    throw new Error('Queue is full (maximum 20 videos).');
  }

  const multi = redis.multi();
  multi.rpush(key, JSON.stringify(item));
  multi.expire(key, ROOM_TTL);
  const results = await multi.exec();
  const newLen = results && results[0] ? (results[0][1] as number) : currentLen + 1;
  return newLen;
}

export async function getQueue(roomId: string): Promise<QueueItem[]> {
  const key = `room:${roomId}:queue`;
  const rawList = await redis.lrange(key, 0, -1);
  const items: QueueItem[] = [];

  for (const raw of rawList) {
    try {
      items.push(JSON.parse(raw) as QueueItem);
    } catch {
      // ignore
    }
  }

  return items;
}

export async function popNextQueueItem(roomId: string): Promise<QueueItem | null> {
  const key = `room:${roomId}:queue`;
  const raw = await redis.lpop(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as QueueItem;
  } catch {
    return null;
  }
}

