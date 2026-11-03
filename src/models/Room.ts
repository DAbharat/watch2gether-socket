import { Participant } from './Participant.js';
import { ActionRequest, ChatMessage, ParticipantData, Role, RoomState } from '../types.js';

export const SHADCN_AVATARS: string[] = [
  '/avatars/01.png',
  '/avatars/02.png',
  '/avatars/03.png',
  '/avatars/04.png',
  '/avatars/05.png',
];

export class Room {
  id: string;
  hostSocketId: string;
  videoId: string;
  currentTime: number;
  isPlaying: boolean;
  lastUpdated: number;
  participants: Map<string, Participant>;
  messages: ChatMessage[];
  pendingRequests: Map<string, ActionRequest>;
  joinCounter: number = 0;

  constructor(id: string, hostSocketId: string, hostUsername: string) {
    this.id = id;
    this.hostSocketId = hostSocketId;
    this.videoId = 'dQw4w9WgXcQ';
    this.currentTime = 0;
    this.isPlaying = false;
    this.lastUpdated = Date.now();
    this.participants = new Map();
    this.messages = [];
    this.pendingRequests = new Map();

    this.addParticipant(hostSocketId, hostUsername, 'host');
  }

  addParticipant(socketId: string, username: string, role: Role = 'participant'): Participant {
    const avatarIndex = this.joinCounter % SHADCN_AVATARS.length;
    this.joinCounter++;
    const avatar = SHADCN_AVATARS[avatarIndex];
    const participant = new Participant(socketId, username, role, avatar);
    this.participants.set(socketId, participant);
    return participant;
  }

  removeParticipant(socketId: string): Participant | undefined {
    const participant = this.participants.get(socketId);
    this.participants.delete(socketId);

    // Clean up any pending requests made by this user
    for (const [reqId, req] of this.pendingRequests.entries()) {
      if (req.requesterId === socketId) {
        this.pendingRequests.delete(reqId);
      }
    }

    // Auto-promote: If host left/disconnected, promote a Moderator first, else first participant
    if (this.hostSocketId === socketId && this.participants.size > 0) {
      const participantsList = Array.from(this.participants.values());
      const nextHost = participantsList.find((p) => p.role === 'moderator') || participantsList[0];
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
      if (currentHost && currentHost.socketId !== targetSocketId) {
        currentHost.role = 'moderator';
      }
      p.role = 'host';
      this.hostSocketId = targetSocketId;
    } else {
      p.role = newRole;
    }
    return p;
  }

  transferHost(targetSocketId: string): Participant | null {
    return this.assignRole(targetSocketId, 'host');
  }

  addActionRequest(request: ActionRequest): void {
    this.pendingRequests.set(request.requestId, request);
  }

  getActionRequest(requestId: string): ActionRequest | undefined {
    return this.pendingRequests.get(requestId);
  }

  removeActionRequest(requestId: string): ActionRequest | undefined {
    const req = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    return req;
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
      timestamp: Date.now(),
      avatar: p ? p.avatar : SHADCN_AVATARS[0],
    };
    this.messages.push(msg);
    if (this.messages.length > 100) this.messages.shift();
    return msg;
  }
}
