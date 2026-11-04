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
  messages?: ChatMessage[];
  anchorPosition?: number;
  anchorServerTime?: number;
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

export interface ActionRequest {
  requestId: string;
  requesterId: string;
  requesterName: string;
  type: 'play' | 'pause' | 'seek' | 'change_video';
  payload: any;
  timestamp: number;
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

export interface VideoRequest {
  requestId: string;
  userId: string;
  username: string;
  videoId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  action?: 'play_now' | 'queue' | 'reject';
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface QueueItem {
  videoId: string;
  requestedBy: string;
  requestedByUsername: string;
  approvedAt: number;
}

export interface ClientToServerEvents {
  join_room: (data: { roomId: string; username: string; participantId?: string; participantToken?: string }) => void;
  leave_room: () => void;
  ntp_ping: (data: { clientSendTime: number }) => void;
  play: (data: { roomId: string; currentTime: number; timestamp?: number }) => void;
  pause: (data: { roomId: string; currentTime: number; timestamp?: number }) => void;
  seek: (data: { roomId: string; time: number }) => void;
  playback_heartbeat: (data: { roomId: string; currentTime: number; isPlaying: boolean; timestamp?: number }) => void;
  change_video: (data: { roomId: string; videoId: string }) => void;
  assign_role: (data: { roomId: string; userId?: string; targetSocketId?: string; role?: Role; newRole?: Role }) => void;
  remove_participant: (data: { roomId: string; userId?: string; targetSocketId?: string }) => void;
  kick_user: (data: { roomId: string; targetSocketId?: string; userId?: string }) => void;
  transfer_host: (data: { roomId: string; userId: string }) => void;
  request_action: (data: { roomId: string; type: 'play' | 'pause' | 'seek' | 'change_video'; payload?: any }) => void;
  approve_action: (data: { roomId: string; requestId: string }) => void;
  deny_action: (data: { roomId: string; requestId: string }) => void;
  send_message: (data: { roomId: string; text: string }) => void;
  chat_message: (data: { roomId: string; text: string }) => void;
  send_reaction: (data: { roomId: string; emoji: string }) => void;
  reaction: (data: { roomId: string; emoji: string }) => void;
  request_video: (data: { roomId: string; participantToken: string; videoUrl: string }) => void;
  resolve_request: (data: { roomId: string; participantToken: string; requestId: string; action: 'play_now' | 'queue' | 'reject' }) => void;
  video_ended: (data: { roomId: string; videoId: string; participantToken?: string }) => void;
  get_requests: (data: { roomId: string; participantToken: string }) => void;
}

export interface ServerToClientEvents {
  sync_state: (state: RoomState) => void;
  ntp_pong: (data: { clientSendTime: number; serverTime: number }) => void;
  user_joined: (data: UserJoinedPayload) => void;
  user_left: (data: UserLeftPayload) => void;
  play: (data: { currentTime: number; anchorPosition?: number; anchorServerTime?: number; sentAt?: number }) => void;
  pause: (data: { currentTime: number; anchorPosition?: number; anchorServerTime?: number; sentAt?: number }) => void;
  seek: (data: { time: number; anchorPosition?: number; anchorServerTime?: number; sentAt?: number }) => void;
  playback_sync: (data: { currentTime: number; isPlaying: boolean; anchorPosition?: number; anchorServerTime?: number; sentAt?: number }) => void;
  change_video: (data: { videoId: string }) => void;
  role_assigned: (data: RoleAssignedPayload) => void;
  role_changed: (data: { socketId: string; newRole: Role; hostSocketId: string }) => void;
  participant_removed: (data: ParticipantRemovedPayload) => void;
  kicked: (data: { message: string }) => void;
  new_message: (message: ChatMessage) => void;
  chat_message: (message: ChatMessage) => void;
  new_reaction: (reaction: ReactionPayload) => void;
  reaction: (reaction: ReactionPayload) => void;
  error_message: (error: ErrorMessagePayload) => void;
  error: (error: ErrorMessagePayload) => void;
  action_requested: (request: ActionRequest) => void;
  action_request_sent: (data: { message: string; requestId: string }) => void;
  action_approved: (data: { requestId: string; type: string }) => void;
  action_denied: (data: { requestId: string; type: string; reason: string }) => void;
  action_resolved: (data: { requestId: string }) => void;
  request_created: (data: { request: VideoRequest }) => void;
  request_updated: (data: { request: VideoRequest; message?: string }) => void;
  requests_sync: (data: { requests: VideoRequest[] }) => void;
  queue_updated: (data: { queue: QueueItem[] }) => void;
  request_notification: (data: { message: string; type: 'info' | 'success' | 'warning' | 'error' }) => void;
}
