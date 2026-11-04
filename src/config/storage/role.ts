import redis from "../redis.js";

const ROOM_TTL = Number(process.env.ROOM_TTL) || 60 * 60 * 24;

export async function assignRole(
  roomId: string,
  participantId: string,
  role: string
): Promise<void> {
  const key = `room:${roomId}:roles`;

  await redis
    .multi()
    .hset(key, participantId, role)
    .expire(key, ROOM_TTL)
    .exec();
}

export async function getRole(
  roomId: string,
  participantId: string
): Promise<string | null> {
  const key = `room:${roomId}:roles`;

  return await redis.hget(key, participantId);
}

export async function getAllParticipantRoles(
  roomId: string
): Promise<Record<string, string>> {
  const key = `room:${roomId}:roles`;

  return await redis.hgetall(key);
}

export async function removeParticipant(
  roomId: string,
  participantId: string
): Promise<number> {
  const key = `room:${roomId}:roles`;

  return await redis.hdel(key, participantId);
}

export const removeParticipantRole = removeParticipant;