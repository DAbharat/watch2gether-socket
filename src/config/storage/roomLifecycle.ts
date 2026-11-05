import redis from '../redis.js';

export const ROOM_TTL = Number(process.env.ROOM_TTL) || 60 * 60 * 24; 
export const EMPTY_ROOM_TTL = 300; 

export interface HostGraceMarker {
  hostId: string;
  deadline: number;
}

export interface StoredRoomState {
  videoId: string;
  currentTime: number;
  isPlaying: boolean;
  anchorPosition: number;
  anchorServerTime: number;
}

export async function setRoomTTL(roomId: string, ttlSeconds: number): Promise<void> {
  const pattern = `room:${roomId}:*`;
  let cursor = '0';
  const matchedKeys: string[] = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys && keys.length > 0) {
      matchedKeys.push(...keys);
    }
  } while (cursor !== '0');

  if (matchedKeys.length === 0) return;

  const multi = redis.multi();
  for (const key of matchedKeys) {
    multi.expire(key, ttlSeconds);
  }
  await multi.exec();
}

export async function refreshRoomActivity(roomId: string): Promise<void> {
  await setRoomTTL(roomId, ROOM_TTL);
}

export async function addConnectedParticipant(roomId: string, userId: string): Promise<void> {
  const key = `room:${roomId}:connected`;
  await redis.sadd(key, userId);
  await redis.expire(key, ROOM_TTL);
}

export async function removeConnectedParticipantAtomic(roomId: string, userId: string): Promise<number> {
  const script = `
    redis.call('SREM', KEYS[1], ARGV[1])
    return redis.call('SCARD', KEYS[1])
  `;
  const result = await redis.eval(script, 1, `room:${roomId}:connected`, userId);
  return typeof result === 'number' ? result : Number(result) || 0;
}

export async function getConnectedCount(roomId: string): Promise<number> {
  const key = `room:${roomId}:connected`;
  return await redis.scard(key);
}

export async function isParticipantConnected(roomId: string, userId: string): Promise<boolean> {
  const key = `room:${roomId}:connected`;
  const isMember = await redis.sismember(key, userId);
  return isMember === 1;
}

export async function addKickedUser(roomId: string, userId: string): Promise<void> {
  const key = `room:${roomId}:kicked`;
  await redis.sadd(key, userId);
  await redis.expire(key, ROOM_TTL);
}

export async function isUserKicked(roomId: string, userId: string): Promise<boolean> {
  const key = `room:${roomId}:kicked`;
  const isMember = await redis.sismember(key, userId);
  return isMember === 1;
}

export async function clearAllConnectedSets(): Promise<number> {
  let cursor = '0';
  const setsToDelete: string[] = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'room:*:connected', 'COUNT', 100);
    cursor = nextCursor;
    if (keys && keys.length > 0) {
      setsToDelete.push(...keys);
    }
  } while (cursor !== '0');

  if (setsToDelete.length > 0) {
    const count = await redis.del(...setsToDelete);
    console.log(`[Lifecycle] Cleared ${count} stale connected set(s) on startup.`);
    return count;
  }
  return 0;
}

export async function setHostGrace(
  roomId: string,
  hostId: string,
  durationMs: number = 60000
): Promise<HostGraceMarker> {
  const key = `room:${roomId}:hostGrace`;
  const deadline = Date.now() + durationMs;
  const marker: HostGraceMarker = { hostId, deadline };
  const ttlSec = Math.max(1, Math.ceil(durationMs / 1000));

  await redis.set(key, JSON.stringify(marker), 'EX', ttlSec);
  return marker;
}

export async function getHostGrace(roomId: string): Promise<HostGraceMarker | null> {
  const key = `room:${roomId}:hostGrace`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HostGraceMarker;
  } catch {
    return null;
  }
}

export async function clearHostGrace(roomId: string): Promise<void> {
  const key = `room:${roomId}:hostGrace`;
  await redis.del(key);
}

export async function atomicTransferHost(
  roomId: string,
  newHostId: string,
  oldHostId?: string
): Promise<void> {
  const hostKey = `room:${roomId}:host`;
  const rolesKey = `room:${roomId}:roles`;
  const graceKey = `room:${roomId}:hostGrace`;

  const multi = redis.multi();
  multi.set(hostKey, newHostId, 'EX', ROOM_TTL);
  multi.hset(rolesKey, newHostId, 'host');
  if (oldHostId && oldHostId !== newHostId) {
    multi.hset(rolesKey, oldHostId, 'moderator');
  }
  multi.del(graceKey);
  multi.expire(rolesKey, ROOM_TTL);

  await multi.exec();
}

export async function atomicCheckAndPromoteHost(
  roomId: string,
  departedHostId: string,
  newHostId: string
): Promise<boolean> {
  const script = `
    local hostKey = KEYS[1]
    local rolesKey = KEYS[2]
    local connectedKey = KEYS[3]
    local graceKey = KEYS[4]
    local departedHost = ARGV[1]
    local newHost = ARGV[2]
    local roomTTL = ARGV[3]

    local currentHost = redis.call('GET', hostKey)
    if currentHost ~= departedHost then
      return 0
    end

    local isHostConnected = redis.call('SISMEMBER', connectedKey, departedHost)
    if isHostConnected == 1 then
      return 0
    end

    redis.call('SET', hostKey, newHost, 'EX', roomTTL)
    redis.call('HSET', rolesKey, newHost, 'host')
    redis.call('HSET', rolesKey, departedHost, 'moderator')
    redis.call('DEL', graceKey)
    redis.call('EXPIRE', rolesKey, roomTTL)
    return 1
  `;

  const hostKey = `room:${roomId}:host`;
  const rolesKey = `room:${roomId}:roles`;
  const connectedKey = `room:${roomId}:connected`;
  const graceKey = `room:${roomId}:hostGrace`;

  const res = await redis.eval(
    script,
    4,
    hostKey,
    rolesKey,
    connectedKey,
    graceKey,
    departedHostId,
    newHostId,
    ROOM_TTL.toString()
  );

  return res === 1;
}

export async function saveRoomState(
  roomId: string,
  state: StoredRoomState
): Promise<void> {
  const key = `room:${roomId}:state`;
  await redis.set(key, JSON.stringify(state), 'EX', ROOM_TTL);
}

export async function getRoomState(
  roomId: string
): Promise<StoredRoomState | null> {
  const key = `room:${roomId}:state`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredRoomState;
  } catch {
    return null;
  }
}

export async function checkRoomExists(roomId: string): Promise<boolean> {
  const host = await redis.get(`room:${roomId}:host`);
  if (host) return true;
  const state = await redis.get(`room:${roomId}:state`);
  if (state) return true;
  const roles = await redis.hlen(`room:${roomId}:roles`);
  return roles > 0;
}

export async function scanAllGraceMarkers(): Promise<
  Array<{ roomId: string; marker: HostGraceMarker }>
> {
  let cursor = '0';
  const markers: Array<{ roomId: string; marker: HostGraceMarker }> = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'room:*:hostGrace', 'COUNT', 100);
    cursor = nextCursor;
    if (keys && keys.length > 0) {
      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length === 3) {
          const roomId = parts[1];
          const raw = await redis.get(key);
          if (raw) {
            try {
              markers.push({ roomId, marker: JSON.parse(raw) });
            } catch {
              // ignore invalid json
            }
          }
        }
      }
    }
  } while (cursor !== '0');

  return markers;
}

