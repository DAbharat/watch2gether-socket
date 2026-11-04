import { ChatMessage } from "../../types.js";
import redis from "../redis.js";

const MAX_MESSAGES = Number(process.env.MAX_MESSAGES) || 150;
const CHAT_TTL = Number(process.env.CHAT_TTL) || 60 * 60 * 24;

export async function saveMessages(
  roomId: string,
  message: ChatMessage
): Promise<void> {
  const key = `room:${roomId}:messages`;

  await redis
    .multi()
    .lpush(key, JSON.stringify(message))
    .ltrim(key, 0, MAX_MESSAGES - 1)
    .expire(key, CHAT_TTL)
    .exec();
}

export async function getMessages(roomId: string): Promise<ChatMessage[]> {
  const key = `room:${roomId}:messages`;

  const messages = await redis.lrange(key, 0, -1);
  const parsedMessages: ChatMessage[] = [];

  for (const raw of messages) {
    try {
      parsedMessages.push(JSON.parse(raw) as ChatMessage);
    } catch {
      // Ignore corrupted message entry
    }
  }

  return parsedMessages.reverse();
}
