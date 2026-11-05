import { ParticipantData, Role } from '../types.js';

export class Participant implements ParticipantData {
  userId: string;
  socketId: string;
  username: string;
  role: Role;
  joinedAt: number;
  avatar: string;
  connected: boolean;

  constructor(
    userId: string,
    socketId: string,
    username: string,
    role: Role = 'participant',
    avatar: string = '/avatars/01.png',
    connected: boolean = true
  ) {
    this.userId = userId || socketId;
    this.socketId = socketId;
    this.username = username || 'Guest';
    this.role = role;
    this.joinedAt = Date.now();
    this.avatar = avatar;
    this.connected = connected;
  }

  toJSON(): ParticipantData {
    return {
      userId: this.userId,
      socketId: this.socketId,
      username: this.username,
      role: this.role,
      joinedAt: this.joinedAt,
      avatar: this.avatar,
      connected: this.connected,
    };
  }
}
