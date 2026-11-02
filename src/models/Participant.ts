import { ParticipantData, Role } from '../types.js';

export class Participant implements ParticipantData {
  userId: string;
  socketId: string;
  username: string;
  role: Role;
  joinedAt: number;

  constructor(socketId: string, username: string, role: Role = 'participant') {
    this.userId = socketId;
    this.socketId = socketId;
    this.username = username || 'Guest';
    this.role = role;
    this.joinedAt = Date.now();
  }

  toJSON(): ParticipantData {
    return {
      userId: this.userId,
      socketId: this.socketId,
      username: this.username,
      role: this.role,
      joinedAt: this.joinedAt
    };
  }
}
