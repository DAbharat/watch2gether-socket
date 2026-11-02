import { Participant } from './Participant.js';
import { ChatMessage, ParticipantData, Role, RoomState } from '../types.js';

export class Room {
  id: string;
  hostSocketId: string;
  videoId: string;
  currentTime: number;
  isPlaying: boolean;
  lastUpdated: number;
  participants: Map<string, Participant>;
  messages: ChatMessage[];

  constructor(id: string, hostSocketId: string, hostUsername: string) {
    this.id = id;
    this.hostSocketId = hostSocketId;
    this.videoId = 'dQw4w9WgXcQ';
    this.currentTime = 0;
    this.isPlaying = false;
    this.lastUpdated = Date.now();
    this.participants = new Map();
    this.messages = [];

    this.addParticipant(hostSocketId, hostUsername, 'host');
  }

  addParticipant(socketId: string, username: string, role: Role = 'participant'): Participant {
    const participant = new Participant(socketId, username, role);
    this.participants.set(socketId, participant);
    return participant;
  }

  removeParticipant(socketId: string): Participant | undefined {
    const participant = this.participants.get(socketId);
    this.participants.delete(socketId);

    // Reassign host if the current host disconnects
    if (this.hostSocketId === socketId && this.participants.size > 0) {
      const nextHost = this.participants.values().next().value;
      if (nextHost) {
        nextHost.role = 'host';
        this.hostSocketId = nextHost.socketId;
      }
    }

    return participant;
  }

  getParticipant(socketId: string): Participant | undefined {
    return this.participants.get(socketId);
  }

  canControl(socketId: string): boolean {
    const p = this.participants.get(socketId);
    return Boolean(p && (p.role === 'host' || p.role === 'moderator'));
  }

  isHost(socketId: string): boolean {
    const p = this.participants.get(socketId);
    return Boolean(p && p.role === 'host');
  }

  assignRole(targetSocketId: string, newRole: Role): Participant | null {
    const p = this.participants.get(targetSocketId);
    if (!p) return null;

    if (newRole === 'host') {
      const currentHost = this.participants.get(this.hostSocketId);
      if (currentHost) currentHost.role = 'moderator';
      p.role = 'host';
      this.hostSocketId = targetSocketId;
    } else {
      p.role = newRole;
    }
    return p;
  }

  updatePlaybackState({
    isPlaying,
    currentTime,
    videoId
  }: {
    isPlaying?: boolean;
    currentTime?: number;
    videoId?: string;
  }): void {
    if (typeof isPlaying === 'boolean') this.isPlaying = isPlaying;
    if (typeof currentTime === 'number') this.currentTime = currentTime;
    if (typeof videoId === 'string' && videoId.trim()) this.videoId = videoId.trim();
    this.lastUpdated = Date.now();
  }

  // Calculates real-time playback offset to keep joining participants synchronized
  getCalculatedCurrentTime(): number {
    if (this.isPlaying) {
      const elapsedSec = (Date.now() - this.lastUpdated) / 1000;
      return this.currentTime + elapsedSec;
    }
    return this.currentTime;
  }

  getParticipantList(): ParticipantData[] {
    return Array.from(this.participants.values()).map((p) => p.toJSON());
  }

  getState(): RoomState {
    return {
      roomId: this.id,
      videoId: this.videoId,
      currentTime: this.getCalculatedCurrentTime(),
      isPlaying: this.isPlaying,
      playState: this.isPlaying ? 'playing' : 'paused',
      hostSocketId: this.hostSocketId,
      participants: this.getParticipantList()
    };
  }

  addMessage(socketId: string, text: string): ChatMessage {
    const p = this.participants.get(socketId);
    const msg: ChatMessage = {
      id: Math.random().toString(36).substring(2, 9),
      userId: socketId,
      username: p ? p.username : 'Unknown',
      role: p ? p.role : 'participant',
      text,
      timestamp: Date.now()
    };
    this.messages.push(msg);
    if (this.messages.length > 100) this.messages.shift();
    return msg;
  }
}
