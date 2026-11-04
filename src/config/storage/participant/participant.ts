import crypto from 'node:crypto';
import redis from "../../redis.js";

const TOKEN_TTL = Number(process.env.ROOM_TTL) || 60 * 60 * 24;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function storeParticipantToken(
  roomId: string,
  participantId: string,
  rawToken: string
): Promise<void> {
  const key = `room:${roomId}:token:${participantId}`;
  const hashed = hashToken(rawToken);
  await redis.set(key, hashed, "EX", TOKEN_TTL);
}

export async function verifyParticipantToken(
  roomId: string,
  participantId: string,
  rawToken?: string
): Promise<boolean> {
  if (!participantId || !rawToken) {
    return false;
  }

  const key = `room:${roomId}:token:${participantId}`;
  const storedHash = await redis.get(key);
  const incomingHash = hashToken(rawToken);

  if (!storedHash) {
    await redis.set(key, incomingHash, "EX", TOKEN_TTL);
    return true;
  }

  return storedHash === incomingHash;
}
