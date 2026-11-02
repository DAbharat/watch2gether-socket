import { Room } from './Room.js';

export class RoomManager {
  rooms: Map<string, Room>;

  constructor() {
    this.rooms = new Map();
  }

  createRoom(roomId: string, hostSocketId: string, hostUsername: string): Room {
    const room = new Room(roomId, hostSocketId, hostUsername);
    this.rooms.set(roomId, room);
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getOrCreateRoom(roomId: string, socketId: string, username: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = this.createRoom(roomId, socketId, username);
    } else {
      room.addParticipant(socketId, username, 'participant');
    }
    return room;
  }

  getRoomBySocketId(socketId: string): Room | null {
    for (const room of this.rooms.values()) {
      if (room.participants.has(socketId)) {
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
