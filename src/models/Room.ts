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
  hostUserId: string;
  videoId: string;
  currentTime: number;
  isPlaying: boolean;
  lastUpdated: number;
  participants: Map<string, Participant>; // Keyed by stable userId
  socketToUserId: Map<string, string>;   // Maps socketId -> userId
  messages: ChatMessage[];
  pendingRequests: Map<string, ActionRequest>;
  joinCounter: number = 0;

  constructor(id: string, hostSocketId: string, hostUsername: string, hostUserId?: string) {
    this.id = id;
    this.hostSocketId = hostSocketId;
    this.hostUserId = hostUserId || hostSocketId;
    this.videoId = 'dQw4w9WgXcQ';
    this.currentTime = 0;
    this.isPlaying = false;
    this.lastUpdated = Date.now();
    this.participants = new Map();
    this.socketToUserId = new Map();
    this.messages = [];
    this.pendingRequests = new Map();

    this.addOrUpdateParticipant(this.hostUserId, hostSocketId, hostUsername, 'host');
  }

  addOrUpdateParticipant(
    userId: string,
    socketId: string,
    username: string,
    role: Role = 'participant'
  ): { participant: Participant; isNew: boolean } {
    const existing = this.participants.get(userId);

    if (existing) {
      if (existing.socketId && existing.socketId !== socketId) {
        this.socketToUserId.delete(existing.socketId);
      }
      existing.socketId = socketId;
      if (username) existing.username = username;
      if (role) existing.role = role;

      this.socketToUserId.set(socketId, userId);

      if (existing.role === 'host') {
        this.hostSocketId = socketId;
        this.hostUserId = userId;
      }

      return { participant: existing, isNew: false };
    }

    const avatarIndex = this.joinCounter % SHADCN_AVATARS.length;
    this.joinCounter++;
    const avatar = SHADCN_AVATARS[avatarIndex];

    const participant = new Participant(userId, socketId, username, role, avatar);
    this.participants.set(userId, participant);
    this.socketToUserId.set(socketId, userId);

    if (role === 'host') {
      this.hostSocketId = socketId;
      this.hostUserId = userId;
    }

    return { participant, isNew: true };
  }

  removeParticipant(socketIdOrUserId: string): Participant | undefined {
    const participant = this.getParticipant(socketIdOrUserId);
    if (!participant) return undefined;

    this.participants.delete(participant.userId);
    this.socketToUserId.delete(participant.socketId);

    // Clean up any pending requests made by this user
    for (const [reqId, req] of this.pendingRequests.entries()) {
      if (req.requesterId === participant.socketId || req.requesterId === participant.userId) {
        this.pendingRequests.delete(reqId);
      }
    }

    // Auto-promote: If host left/disconnected, promote a Moderator first, else first participant
    if (
      (this.hostUserId === participant.userId || this.hostSocketId === participant.socketId) &&
      this.participants.size > 0
    ) {
      const participantsList = Array.from(this.participants.values());
      const nextHost = participantsList.find((p) => p.role === 'moderator') || participantsList[0];
      if (nextHost) {
        nextHost.role = 'host';
        this.hostUserId = nextHost.userId;
        this.hostSocketId = nextHost.socketId;
      }
    }

    return participant;
  }

  getParticipant(socketIdOrUserId: string): Participant | undefined {
    const userId = this.socketToUserId.get(socketIdOrUserId);
    if (userId) {
      return this.participants.get(userId);
    }
    return this.participants.get(socketIdOrUserId);
  }

  canControl(socketIdOrUserId: string): boolean {
    const p = this.getParticipant(socketIdOrUserId);
    return Boolean(p && (p.role === 'host' || p.role === 'moderator'));
  }

  isHost(socketIdOrUserId: string): boolean {
    const p = this.getParticipant(socketIdOrUserId);
    return Boolean(p && p.role === 'host');
  }

  assignRole(targetId: string, newRole: Role): Participant | null {
    const p = this.getParticipant(targetId);
    if (!p) return null;

    if (newRole === 'host') {
      const currentHost = this.getParticipant(this.hostUserId || this.hostSocketId);
      if (currentHost && currentHost.userId !== p.userId) {
        currentHost.role = 'moderator';
      }
      p.role = 'host';
      this.hostUserId = p.userId;
      this.hostSocketId = p.socketId;
    } else {
      p.role = newRole;
    }
    return p;
  }

  transferHost(targetId: string): Participant | null {
    return this.assignRole(targetId, 'host');
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
      participants: this.getParticipantList(),
      messages: this.messages,
    };
  }

  addMessage(socketIdOrUserId: string, text: string): ChatMessage {
    const p = this.getParticipant(socketIdOrUserId);
    const msg: ChatMessage = {
      id: Math.random().toString(36).substring(2, 9),
      userId: p ? p.userId : socketIdOrUserId,
      username: p ? p.username : 'Unknown',
      role: p ? p.role : 'participant',
      text,
      timestamp: Date.now(),
      avatar: p ? p.avatar : SHADCN_AVATARS[0],
    };
    this.messages.push(msg);
    if (this.messages.length > 150) this.messages.shift();
    return msg;
  }
}
