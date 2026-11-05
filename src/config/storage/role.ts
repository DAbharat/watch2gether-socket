import redis from "../redis.js";
import { ROOM_TTL, atomicTransferHost } from "./roomLifecycle.js";

export async function assignRole(
  roomId: string,
  participantId: string,
  role: string
): Promise<void> {
  if (role === 'host') {
    const currentHost = await getRoomHost(roomId);
    await atomicTransferHost(roomId, participantId, currentHost || undefined);
    return;
  }

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

export async function setRoomHost(
  roomId: string,
  hostUserId: string
): Promise<void> {
  const key = `room:${roomId}:host`;
  await redis.set(key, hostUserId, "EX", ROOM_TTL);
}

export async function getRoomHost(
  roomId: string
): Promise<string | null> {
  const key = `room:${roomId}:host`;
  return await redis.get(key);
}

export async function removeRoomHost(
  roomId: string
): Promise<number> {
  const key = `room:${roomId}:host`;
  return await redis.del(key);
}

export const removeParticipantRole = removeParticipant;