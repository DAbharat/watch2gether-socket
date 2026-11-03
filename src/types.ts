export type Role = 'host' | 'moderator' | 'participant';

export interface ParticipantData {
  userId: string;
  socketId: string;
  username: string;
  role: Role;
  joinedAt: number;
  avatar?: string;
}

export interface RoomState {
  roomId: string;
  videoId: string;
  currentTime: number;
  isPlaying: boolean;
  playState: 'playing' | 'paused';
  hostSocketId: string;
  participants: ParticipantData[];
}

export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  role: Role;
  text: string;
  timestamp: number;
  avatar?: string;
}

export interface UserJoinedPayload {
  username: string;
  userId: string;
  role: Role;
  participants: ParticipantData[];
}

export interface UserLeftPayload {
  userId: string;
  username: string;
  participants: ParticipantData[];
  hostSocketId: string;
}

export interface RoleAssignedPayload {
  userId: string;
  username: string;
  role: Role;
  participants: ParticipantData[];
  hostSocketId: string;
}

export interface ParticipantRemovedPayload {
  userId: string;
  participants: ParticipantData[];
}

export interface ReactionPayload {
  emoji: string;
  userId: string;
  username: string;
}

export interface ErrorMessagePayload {
  message: string;
}

export interface ClientToServerEvents {
  join_room: (data: { roomId: string; username: string }) => void;
  leave_room: () => void;
  play: (data: { roomId: string; currentTime: number }) => void;
  pause: (data: { roomId: string; currentTime: number }) => void;
  seek: (data: { roomId: string; time: number }) => void;
  change_video: (data: { roomId: string; videoId: string }) => void;
  assign_role: (data: { roomId: string; userId: string; role: Role }) => void;
  remove_participant: (data: { roomId: string; userId: string }) => void;
  send_message: (data: { roomId: string; text: string }) => void;
  send_reaction: (data: { roomId: string; emoji: string }) => void;
}

export interface ServerToClientEvents {
  sync_state: (state: RoomState) => void;
  user_joined: (data: UserJoinedPayload) => void;
  user_left: (data: UserLeftPayload) => void;
  play: (data: { currentTime: number }) => void;
  pause: (data: { currentTime: number }) => void;
  seek: (data: { time: number }) => void;
  change_video: (data: { videoId: string }) => void;
  role_assigned: (data: RoleAssignedPayload) => void;
  participant_removed: (data: ParticipantRemovedPayload) => void;
  kicked: (data: { message: string }) => void;
  new_message: (message: ChatMessage) => void;
  new_reaction: (reaction: ReactionPayload) => void;
  error_message: (error: ErrorMessagePayload) => void;
}
