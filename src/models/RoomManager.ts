import { Room } from './Room.js';
import { Role } from '../types.js';

export class RoomManager {
  rooms: Map<string, Room>;

  constructor() {
    this.rooms = new Map();
  }

  createRoom(
    roomId: string,
    socketId: string,
    username: string,
    userId?: string,
    role: Role = 'participant',
    designatedHostUserId?: string
  ): Room {
    const room = new Room(roomId, socketId, username, userId, role, designatedHostUserId);
    this.rooms.set(roomId, room);
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  getOrCreateRoom(
    roomId: string,
    socketId: string,
    username: string,
    userId?: string,
    role: Role = 'participant',
    designatedHostUserId?: string
  ): { room: Room; isNewRoom: boolean } {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = this.createRoom(roomId, socketId, username, userId, role, designatedHostUserId);
      return { room, isNewRoom: true };
    } else {
      room.addOrUpdateParticipant(userId || socketId, socketId, username, role);
      return { room, isNewRoom: false };
    }
  }

  getRoomBySocketId(socketId: string): Room | null {
    for (const room of this.rooms.values()) {
      if (room.getParticipant(socketId)) {
        return room;
      }
    }
    return null;
  }

  removeRoom(roomId: string): boolean {
    return this.rooms.delete(roomId);
  }
}

export const roomManager = new RoomManager();
