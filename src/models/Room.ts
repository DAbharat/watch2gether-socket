import crypto from 'node:crypto';
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
  anchorPosition: number;
  anchorServerTime: number;
  participants: Map<string, Participant>; // Keyed by stable userId
  socketToUserId: Map<string, string>;   // Maps socketId -> userId
  messages: ChatMessage[];
  pendingRequests: Map<string, ActionRequest>;
  joinCounter: number = 0;

  constructor(
    id: string,
    socketId: string,
    username: string,
    userId?: string,
    role: Role = 'participant',
    designatedHostUserId?: string
  ) {
    this.id = id;
    this.hostSocketId = role === 'host' ? socketId : '';
    this.hostUserId = designatedHostUserId || (role === 'host' ? (userId || socketId) : '');
    this.videoId = 'dQw4w9WgXcQ';
    this.currentTime = 0;
    this.isPlaying = false;
    this.lastUpdated = Date.now();
    this.anchorPosition = 0;
    this.anchorServerTime = this.lastUpdated;
    this.participants = new Map();
    this.socketToUserId = new Map();
    this.messages = [];
    this.pendingRequests = new Map();

    this.addOrUpdateParticipant(userId || socketId, socketId, username, role);
  }

  addOrUpdateParticipant(
    userId: string,
    socketId: string,
    username: string,
    role: Role = 'participant'
  ): { participant: Participant; isNew: boolean } {
    // Only clean up if another entry is holding this exact active socket
    if (socketId) {
      for (const [existingId, p] of this.participants.entries()) {
        if (existingId !== userId && p.socketId && p.socketId === socketId) {
          this.participants.delete(existingId);
          this.socketToUserId.delete(socketId);
        }
      }
    }

    const existing = this.participants.get(userId);

    if (existing) {
      if (existing.socketId && existing.socketId !== socketId) {
        this.socketToUserId.delete(existing.socketId);
      }
      existing.socketId = socketId;
      existing.connected = true;
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

    // Single-host invariant: A room can only have one active host
    const activeHost = this.hostUserId ? this.participants.get(this.hostUserId) : undefined;
    if (role === 'host' && activeHost && activeHost.userId !== userId) {
      role = 'participant';
    }

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
    if (this.participants.size === 0) {
      this.hostUserId = '';
      this.hostSocketId = '';
    } else if (this.hostUserId === participant.userId || this.hostSocketId === participant.socketId) {
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

  markParticipantDisconnected(userIdOrSocketId: string): Participant | undefined {
    const p = this.getParticipant(userIdOrSocketId);
    if (p) {
      p.connected = false;
    }
    return p;
  }

  markParticipantConnected(userId: string, socketId: string): Participant | undefined {
    const p = this.getParticipant(userId);
    if (p) {
      p.connected = true;
      if (p.socketId && p.socketId !== socketId) {
        this.socketToUserId.delete(p.socketId);
      }
      p.socketId = socketId;
      this.socketToUserId.set(socketId, userId);
      if (p.role === 'host') {
        this.hostSocketId = socketId;
        this.hostUserId = userId;
      }
    }
    return p;
  }

  getConnectedParticipants(): Participant[] {
    return Array.from(this.participants.values()).filter((p) => p.connected !== false);
  }

  getConnectedCount(): number {
    return this.getConnectedParticipants().length;
  }

  setHost(userId: string, socketId: string = ''): Participant | null {
    const p = this.getParticipant(userId);
    if (!p) return null;

    const oldHost = this.getParticipant(this.hostUserId);
    if (oldHost && oldHost.userId !== userId) {
      oldHost.role = 'moderator';
    }

    p.role = 'host';
    this.hostUserId = p.userId;
    this.hostSocketId = socketId || p.socketId;
    return p;
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
    const now = Date.now();
    if (typeof videoId === 'string' && videoId.trim()) {
      this.videoId = videoId.trim();
      this.anchorPosition = 0;
      this.currentTime = 0;
      this.isPlaying = true;
      this.anchorServerTime = now;
      this.lastUpdated = now;
      return;
    }

    const newPlaying = typeof isPlaying === 'boolean' ? isPlaying : this.isPlaying;
    const newTime = typeof currentTime === 'number' && !isNaN(currentTime)
      ? currentTime
      : this.getCalculatedCurrentTime();

    this.currentTime = newTime;
    this.anchorPosition = newTime;
    this.isPlaying = newPlaying;
    this.anchorServerTime = now;
    this.lastUpdated = now;
  }

  getCalculatedCurrentTime(): number {
    if (this.isPlaying) {
      const elapsedSec = (Date.now() - this.anchorServerTime) / 1000;
      return Math.max(0, this.anchorPosition + elapsedSec);
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
      anchorPosition: this.anchorPosition,
      anchorServerTime: this.anchorServerTime,
    };
  }

  addMessage(socketIdOrUserId: string, text: string): ChatMessage {
    const p = this.getParticipant(socketIdOrUserId);
    const cleanText = (typeof text === 'string' ? text : '').trim().slice(0, 500);
    const msg: ChatMessage = {
      id: crypto.randomBytes(8).toString('hex'),
      userId: p ? p.userId : socketIdOrUserId,
      username: p ? p.username : 'Unknown',
      role: p ? p.role : 'participant',
      text: cleanText,
      timestamp: Date.now(),
      avatar: p ? p.avatar : SHADCN_AVATARS[0],
    };
    this.messages.push(msg);
    if (this.messages.length > 150) this.messages.shift();
    return msg;
  }
}
