import crypto from 'node:crypto';
import redis from "../../redis.js";

const TOKEN_TTL = Number(process.env.ROOM_TTL) || 60 * 60 * 24;

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateParticipantToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function generateSecureUserId(): string {
  return `usr_${crypto.randomBytes(9).toString('hex')}`;
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
  if (!roomId || !participantId || !rawToken) {
    return false;
  }

  const key = `room:${roomId}:token:${participantId}`;
  const storedHash = await redis.get(key);
  if (!storedHash) {
    return false;
  }

  const incomingHash = hashToken(rawToken);

  try {
    const a = Buffer.from(storedHash, 'hex');
    const b = Buffer.from(incomingHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
