import express from 'express';
import http from 'node:http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import 'dotenv/config';
import { roomManager } from './models/RoomManager.js';
import { Room } from './models/Room.js';
import { ClientToServerEvents, ServerToClientEvents, Role, ActionRequest } from './types.js';
import { assignRole, getRole, getAllParticipantRoles, removeParticipantRole } from './config/storage/role.js';
import { saveMessages, getMessages } from './config/storage/chat.js';
import { verifyParticipantToken } from './config/storage/participant/participant.js';

const app = express();
const PORT = process.env.PORT || 4000;

// Parse allowed frontend origins from CLIENT_URL (supports comma-separated URLs or '*')
const rawClientUrls = process.env.CLIENT_URL || process.env.FRONTEND_URL || '*';
const allowedOrigins = rawClientUrls.split(',').map((url) => url.trim().replace(/\/$/, ''));

const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return true;
  if (allowedOrigins.includes('*')) return true;
  if (allowedOrigins.includes(origin)) return true;
  // Always permit local development ports (e.g. http://localhost:3000)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
};

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with']
};

app.use(cors(corsOptions));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeRooms: roomManager.rooms.size,
    timestamp: Date.now()
  });
});

app.get('/', (req, res) => {
  res.send('Watch2Gether WebSocket Server is running.');
});

const server = http.createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const PERMISSIONS: Record<string, Role[]> = {
  play: ['host', 'moderator'],
  pause: ['host', 'moderator'],
  seek: ['host', 'moderator'],
  change_video: ['host', 'moderator'],
  assign_role: ['host'],
  remove_participant: ['host'],
  transfer_host: ['host'],
};

function hasPermission(room: Room, socketIdOrUserId: string, action: string): boolean {
  const participant = room.getParticipant(socketIdOrUserId);
  if (!participant) return false;
  const allowedRoles = PERMISSIONS[action];
  return allowedRoles ? allowedRoles.includes(participant.role) : false;
}

function sendError(socket: Socket<any, any>, message: string) {
  socket.emit('error_message', { message });
  socket.emit('error', { message });
}

// Grace period tracker: key = `${roomId}:${userId}` -> NodeJS.Timeout
const pendingDisconnects = new Map<string, NodeJS.Timeout>();

io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
  console.log(`[Connected] Socket ID: ${socket.id}`);

  socket.on('join_room', async ({ roomId, username, participantId, participantToken }) => {
    if (!roomId) return;
    const cleanRoomId = roomId.trim();
    const cleanUsername = (username || 'Guest').trim();

    let stableUserId = (participantId || '').trim();
    if (!stableUserId) {
      stableUserId = `usr_${Math.random().toString(36).substring(2, 11)}`;
    }

    if (participantToken) {
      const isTokenValid = await verifyParticipantToken(cleanRoomId, stableUserId, participantToken.trim());
      if (!isTokenValid) {
        console.warn(`[Security] Unauthorized participant token for ${stableUserId} in room ${cleanRoomId}. Assigning new ID.`);
        stableUserId = `usr_${Math.random().toString(36).substring(2, 11)}`;
      }
    }

    const disconnectKey = `${cleanRoomId}:${stableUserId}`;
    if (pendingDisconnects.has(disconnectKey)) {
      clearTimeout(pendingDisconnects.get(disconnectKey)!);
      pendingDisconnects.delete(disconnectKey);
    }

    socket.join(cleanRoomId);

    const existingRoom = roomManager.getRoom(cleanRoomId);
    let role: Role = 'participant';
    try {
      // Check whether there is an active host currently connected in this room
      const activeHost = existingRoom && existingRoom.participants.size > 0
        ? Array.from(existingRoom.participants.values()).find((p) => p.role === 'host')
        : undefined;

      const existingRole = await getRole(cleanRoomId, stableUserId);

      if (existingRole && ['host', 'moderator', 'participant'].includes(existingRole)) {
        role = existingRole as Role;
        // If this user has a stored host role, but another user is already the active host in this room
        if (role === 'host' && activeHost && activeHost.userId !== stableUserId) {
          role = 'participant';
          await assignRole(cleanRoomId, stableUserId, 'participant');
        }
      } else {
        // If there is no active host currently connected in the room, the joining user is the host!
        if (!activeHost) {
          role = 'host';
        } else {
          role = 'participant';
        }

        await assignRole(cleanRoomId, stableUserId, role);
      }
    } catch (err: any) {
      console.error('[Redis] Error fetching/assigning role:', err.message);
      // Fallback: If Redis is unavailable or empty, the first user in the room is host
      if (!existingRoom || existingRoom.participants.size === 0) {
        role = 'host';
      }
    }

    const { room } = roomManager.getOrCreateRoom(
      cleanRoomId,
      socket.id,
      cleanUsername,
      stableUserId,
      role
    );

    const currentActiveHost = Array.from(room.participants.values()).find((p) => p.role === 'host');
    if (!currentActiveHost || room.participants.size === 1) {
      const p = room.getParticipant(stableUserId);
      if (p) {
        p.role = 'host';
        room.hostUserId = p.userId;
        room.hostSocketId = p.socketId;
        try {
          await assignRole(cleanRoomId, p.userId, 'host');
        } catch (err: any) {
          console.error("Assign role error: ", err)
        }
      }
    }

    if (room.messages.length === 0) {
      try {
        const storedMessages = await getMessages(cleanRoomId);
        if (storedMessages.length > 0) {
          room.messages = storedMessages;
        }
      } catch (err: any) {
        console.error('[Redis] Error loading messages:', err.message);
      }
    }

    const participant = room.getParticipant(stableUserId);
    if (!participant) return;

    socket.emit('sync_state', room.getState());

    io.to(cleanRoomId).emit('user_joined', {
      username: participant.username,
      userId: participant.userId,
      role: participant.role,
      participants: room.getParticipantList()
    });
  });

  socket.on('ntp_ping', ({ clientSendTime }: { clientSendTime: number }) => {
    socket.emit('ntp_pong', {
      clientSendTime,
      serverTime: Date.now(),
    });
  });

  socket.on('play', ({ roomId, currentTime }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'play')) {
      return sendError(socket, 'Permission denied: Only Host and Moderators can control playback.');
    }

    const validTime = typeof currentTime === 'number' && !isNaN(currentTime) ? currentTime : room.currentTime;
    room.updatePlaybackState({ isPlaying: true, currentTime: validTime });

    const sentAt = Date.now();
    socket.to(roomId).emit('play', {
      currentTime: validTime,
      anchorPosition: room.anchorPosition,
      anchorServerTime: room.anchorServerTime,
      sentAt
    });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('pause', ({ roomId, currentTime }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'pause')) {
      return sendError(socket, 'Permission denied: Only Host and Moderators can pause playback.');
    }

    const validTime = typeof currentTime === 'number' && !isNaN(currentTime) ? currentTime : room.currentTime;
    room.updatePlaybackState({ isPlaying: false, currentTime: validTime });

    const sentAt = Date.now();
    socket.to(roomId).emit('pause', {
      currentTime: validTime,
      anchorPosition: room.anchorPosition,
      anchorServerTime: room.anchorServerTime,
      sentAt
    });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('seek', ({ roomId, time }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'seek')) {
      return sendError(socket, 'Permission denied: Only Host and Moderators can seek.');
    }

    const validTime = typeof time === 'number' && !isNaN(time) ? time : 0;
    room.updatePlaybackState({ currentTime: validTime });

    const sentAt = Date.now();
    socket.to(roomId).emit('seek', {
      time: validTime,
      anchorPosition: room.anchorPosition,
      anchorServerTime: room.anchorServerTime,
      sentAt
    });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('playback_heartbeat', ({ roomId, currentTime, isPlaying }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'play')) return;

    const validTime = typeof currentTime === 'number' && !isNaN(currentTime) ? currentTime : room.currentTime;
    room.updatePlaybackState({
      currentTime: validTime,
      isPlaying: typeof isPlaying === 'boolean' ? isPlaying : room.isPlaying
    });

    socket.to(roomId).emit('playback_sync', {
      currentTime: validTime,
      isPlaying: room.isPlaying,
      anchorPosition: room.anchorPosition,
      anchorServerTime: room.anchorServerTime,
      sentAt: Date.now()
    });
  });

  socket.on('change_video', ({ roomId, videoId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'change_video')) {
      return sendError(socket, 'Permission denied: Only Host and Moderators can change the video.');
    }

    room.updatePlaybackState({ videoId, currentTime: 0, isPlaying: true });
    io.to(roomId).emit('change_video', { videoId });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('assign_role', async ({ roomId, userId, targetSocketId, role, newRole }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'assign_role')) {
      return sendError(socket, 'Permission denied: Only the Host can assign roles.');
    }

    const targetId = userId || targetSocketId;
    const targetRole = role || newRole;

    if (!targetId) {
      return sendError(socket, 'Target user ID is required.');
    }

    const caller = room.getParticipant(socket.id);
    if (caller && (targetId === caller.userId || targetId === caller.socketId)) {
      return sendError(socket, 'You cannot change your own role or demote yourself.');
    }

    const targetParticipant = room.getParticipant(targetId);
    if (!targetParticipant) {
      return sendError(socket, 'Target user not found in this room.');
    }

    if (!targetRole || !['host', 'moderator', 'participant'].includes(targetRole)) {
      return sendError(socket, 'Invalid role value.');
    }

    const updatedParticipant = room.assignRole(targetId, targetRole);
    if (updatedParticipant) {
      try {
        await assignRole(roomId, updatedParticipant.userId, targetRole);
      } catch (err: any) {
        console.error('[Redis] Error saving assigned role:', err.message);
      }

      io.to(roomId).emit('role_assigned', {
        userId: updatedParticipant.userId,
        username: updatedParticipant.username,
        role: updatedParticipant.role,
        participants: room.getParticipantList(),
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('role_changed', {
        socketId: updatedParticipant.socketId,
        newRole: updatedParticipant.role,
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('sync_state', room.getState());
    }
  });

  socket.on('transfer_host', async ({ roomId, userId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'transfer_host')) {
      return sendError(socket, 'Permission denied: Only the Host can transfer host status.');
    }

    if (!userId) {
      return sendError(socket, 'Target user ID is required.');
    }

    const caller = room.getParticipant(socket.id);
    if (caller && (userId === caller.userId || userId === caller.socketId)) {
      return sendError(socket, 'You are already the host.');
    }

    const targetParticipant = room.getParticipant(userId);
    if (!targetParticipant) {
      return sendError(socket, 'Target user not found in this room.');
    }

    const previousHost = room.getParticipant(room.hostUserId || room.hostSocketId);
    const updatedParticipant = room.transferHost(userId);

    if (updatedParticipant) {
      try {
        await assignRole(roomId, updatedParticipant.userId, 'host');
        if (previousHost && previousHost.userId !== updatedParticipant.userId) {
          await assignRole(roomId, previousHost.userId, 'moderator');
        }
      } catch (err: any) {
        console.error('[Redis] Error updating host transfer in Redis:', err.message);
      }

      io.to(roomId).emit('role_assigned', {
        userId: updatedParticipant.userId,
        username: updatedParticipant.username,
        role: 'host',
        participants: room.getParticipantList(),
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('role_changed', {
        socketId: updatedParticipant.socketId,
        newRole: 'host',
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('sync_state', room.getState());
    }
  });

  const handleRemoveParticipant = async ({ roomId, userId, targetSocketId }: { roomId: string; userId?: string; targetSocketId?: string }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'remove_participant')) {
      return sendError(socket, 'Permission denied: Only the Host can remove participants.');
    }

    const targetId = userId || targetSocketId;
    if (!targetId) {
      return sendError(socket, 'Target user ID is required.');
    }

    const caller = room.getParticipant(socket.id);
    if (caller && (targetId === caller.userId || targetId === caller.socketId)) {
      return sendError(socket, 'The Host cannot remove themselves.');
    }

    const targetParticipant = room.getParticipant(targetId);
    if (!targetParticipant) {
      return sendError(socket, 'Target user not found in this room.');
    }

    const targetSocket = io.sockets.sockets.get(targetParticipant.socketId);
    if (targetSocket) {
      targetSocket.emit('kicked', { message: 'You were removed from the room by the host.' });
      targetSocket.leave(roomId);
    }

    const disconnectKey = `${roomId}:${targetParticipant.userId}`;
    if (pendingDisconnects.has(disconnectKey)) {
      clearTimeout(pendingDisconnects.get(disconnectKey)!);
      pendingDisconnects.delete(disconnectKey);
    }

    room.removeParticipant(targetParticipant.userId);

    try {
      await removeParticipantRole(roomId, targetParticipant.userId);
    } catch (err: any) {
      console.error('[Redis] Error removing participant role on kick:', err.message);
    }

    io.to(roomId).emit('participant_removed', {
      userId: targetParticipant.userId,
      participants: room.getParticipantList()
    });
    io.to(roomId).emit('sync_state', room.getState());
  };

  socket.on('remove_participant', handleRemoveParticipant);
  socket.on('kick_user', handleRemoveParticipant);

  socket.on('request_action', ({ roomId, type, payload }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    const requester = room.getParticipant(socket.id);
    if (!requester) return sendError(socket, 'You are not in this room.');

    if (room.canControl(socket.id)) {
      if (type === 'play') {
        room.updatePlaybackState({ isPlaying: true, currentTime: payload?.currentTime });
        io.to(roomId).emit('play', {
          currentTime: room.currentTime,
          anchorPosition: room.anchorPosition,
          anchorServerTime: room.anchorServerTime,
          sentAt: Date.now()
        });
        return io.to(roomId).emit('sync_state', room.getState());
      }
      if (type === 'pause') {
        room.updatePlaybackState({ isPlaying: false, currentTime: payload?.currentTime });
        io.to(roomId).emit('pause', {
          currentTime: room.currentTime,
          anchorPosition: room.anchorPosition,
          anchorServerTime: room.anchorServerTime,
          sentAt: Date.now()
        });
        return io.to(roomId).emit('sync_state', room.getState());
      }
      if (type === 'seek') {
        room.updatePlaybackState({ currentTime: payload?.time });
        io.to(roomId).emit('seek', {
          time: payload?.time,
          anchorPosition: room.anchorPosition,
          anchorServerTime: room.anchorServerTime,
          sentAt: Date.now()
        });
        return io.to(roomId).emit('sync_state', room.getState());
      }
      if (type === 'change_video') {
        room.updatePlaybackState({ videoId: payload?.videoId, currentTime: 0, isPlaying: true });
        io.to(roomId).emit('change_video', { videoId: payload?.videoId });
        return io.to(roomId).emit('sync_state', room.getState());
      }
    }

    const requestId = Math.random().toString(36).substring(2, 9);
    const actionReq: ActionRequest = {
      requestId,
      requesterId: socket.id,
      requesterName: requester.username,
      type,
      payload: payload || {},
      timestamp: Date.now()
    };

    room.addActionRequest(actionReq);

    for (const [pUserId, participant] of room.participants.entries()) {
      if (participant.role === 'host' || participant.role === 'moderator') {
        const pSocket = io.sockets.sockets.get(participant.socketId);
        if (pSocket) {
          pSocket.emit('action_requested', actionReq);
        }
      }
    }

    socket.emit('action_request_sent', {
      message: `Request to ${type.replace('_', ' ')} sent to host and moderators.`,
      requestId
    });
  });

  socket.on('approve_action', ({ roomId, requestId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!room.canControl(socket.id)) {
      return sendError(socket, 'Permission denied: Only Host and Moderators can approve requests.');
    }

    const actionReq = room.removeActionRequest(requestId);
    if (!actionReq) {
      return sendError(socket, 'Request not found or already resolved.');
    }

    if (actionReq.type === 'play') {
      room.updatePlaybackState({ 
        isPlaying: true, 
        currentTime: actionReq.payload?.currentTime 
      });

      io.to(roomId).emit('play', { 
        currentTime: room.currentTime,
        anchorPosition: room.anchorPosition,
        anchorServerTime: room.anchorServerTime,
        sentAt: Date.now()
      });
      io.to(roomId).emit('sync_state', room.getState());

    } else if (actionReq.type === 'pause') {
      room.updatePlaybackState({ 
        isPlaying: false, 
        currentTime: actionReq.payload?.currentTime 
      });

      io.to(roomId).emit('pause', { 
        currentTime: room.currentTime,
        anchorPosition: room.anchorPosition,
        anchorServerTime: room.anchorServerTime,
        sentAt: Date.now()
      });
      io.to(roomId).emit('sync_state', room.getState());

    } else if (actionReq.type === 'seek') {
      room.updatePlaybackState({ 
        currentTime: actionReq.payload?.time 
      });

      io.to(roomId).emit('seek', { 
        time: actionReq.payload?.time,
        anchorPosition: room.anchorPosition,
        anchorServerTime: room.anchorServerTime,
        sentAt: Date.now()
      });
      io.to(roomId).emit('sync_state', room.getState());
    } else if (actionReq.type === 'change_video') {
      room.updatePlaybackState({ 
        videoId: actionReq.payload?.videoId, 
        currentTime: 0, 
        isPlaying: true 
      });

      io.to(roomId).emit('change_video', { 
        videoId: actionReq.payload?.videoId 
      });
      io.to(roomId).emit('sync_state', room.getState());
    }

    const requesterSocket = io.sockets.sockets.get(actionReq.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('action_approved', { requestId, type: actionReq.type });
    }

    io.to(roomId).emit('action_resolved', { requestId });
  });

  socket.on('deny_action', ({ roomId, requestId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!room.canControl(socket.id)) {
      return sendError(socket, 'Permission denied: Only Host and Moderators can deny requests.');
    }

    const actionReq = room.removeActionRequest(requestId);
    if (!actionReq) {
      return sendError(socket, 'Request not found or already resolved.');
    }

    const requesterSocket = io.sockets.sockets.get(actionReq.requesterId);
    if (requesterSocket) {
      requesterSocket.emit('action_denied', {
        requestId,
        type: actionReq.type,
        reason: 'Request was declined by host/moderator.'
      });
    }

    io.to(roomId).emit('action_resolved', { requestId });
  });

  const handleMessage = async ({ roomId, text }: { roomId: string; text: string }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !text?.trim()) return;

    const message = room.addMessage(socket.id, text.trim());
    try {
      await saveMessages(roomId, message);
    } catch (err: any) {
      console.error('[Redis] Error saving message:', err.message);
    }

    io.to(roomId).emit('new_message', message);
    io.to(roomId).emit('chat_message', message);
  };

  socket.on('send_message', handleMessage);
  socket.on('chat_message', handleMessage);

  const handleReaction = ({ roomId, emoji }: { roomId: string; emoji: string }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    const participant = room.getParticipant(socket.id);
    const payload = {
      id: Math.random().toString(36).substring(2, 9),
      emoji,
      userId: participant ? participant.userId : socket.id,
      username: participant ? participant.username : 'User'
    };
    io.to(roomId).emit('new_reaction', payload);
    io.to(roomId).emit('reaction', payload);
  };

  socket.on('send_reaction', handleReaction);
  socket.on('reaction', handleReaction);

  // Explicit leave: immediate removal
  const handleExplicitLeave = () => {
    const room = roomManager.getRoomBySocketId(socket.id);
    if (!room) return;

    const participant = room.getParticipant(socket.id);
    if (!participant) return;

    const disconnectKey = `${room.id}:${participant.userId}`;
    if (pendingDisconnects.has(disconnectKey)) {
      clearTimeout(pendingDisconnects.get(disconnectKey)!);
      pendingDisconnects.delete(disconnectKey);
    }

    room.removeParticipant(participant.userId);
    removeParticipantRole(room.id, participant.userId).catch(() => {});

    if (room.participants.size === 0) {
      roomManager.removeRoom(room.id);
    } else {
      io.to(room.id).emit('user_left', {
        userId: participant.userId,
        username: participant.username,
        participants: room.getParticipantList(),
        hostSocketId: room.hostSocketId
      });

      const currentHost = room.getParticipant(room.hostUserId || room.hostSocketId);
      if (currentHost) {
        assignRole(room.id, currentHost.userId, 'host').catch(() => {});
        io.to(room.id).emit('role_assigned', {
          userId: currentHost.userId,
          username: currentHost.username,
          role: 'host',
          participants: room.getParticipantList(),
          hostSocketId: room.hostSocketId
        });
        io.to(room.id).emit('role_changed', {
          socketId: currentHost.socketId,
          newRole: 'host',
          hostSocketId: room.hostSocketId
        });
      }
      io.to(room.id).emit('sync_state', room.getState());
    }
  };

  // Disconnect: apply grace period to tolerate page refreshes without dropping role or user
  const handleDisconnect = () => {
    const room = roomManager.getRoomBySocketId(socket.id);
    if (!room) return;

    const participant = room.getParticipant(socket.id);
    if (!participant) return;

    const roomId = room.id;
    const userId = participant.userId;
    const disconnectKey = `${roomId}:${userId}`;

    if (pendingDisconnects.has(disconnectKey)) {
      clearTimeout(pendingDisconnects.get(disconnectKey)!);
    }

    const timer = setTimeout(() => {
      pendingDisconnects.delete(disconnectKey);

      const currentParticipant = room.getParticipant(userId);
      // If participant still has the disconnected socketId, they haven't reconnected
      if (currentParticipant && currentParticipant.socketId === socket.id) {
        room.removeParticipant(userId);
        removeParticipantRole(roomId, userId).catch(() => {});

        if (room.participants.size === 0) {
          roomManager.removeRoom(roomId);
        } else {
          io.to(roomId).emit('user_left', {
            userId: currentParticipant.userId,
            username: currentParticipant.username,
            participants: room.getParticipantList(),
            hostSocketId: room.hostSocketId
          });

          const currentHost = room.getParticipant(room.hostUserId || room.hostSocketId);
          if (currentHost) {
            assignRole(roomId, currentHost.userId, 'host').catch(() => {});
            io.to(roomId).emit('role_assigned', {
              userId: currentHost.userId,
              username: currentHost.username,
              role: 'host',
              participants: room.getParticipantList(),
              hostSocketId: room.hostSocketId
            });
            io.to(roomId).emit('role_changed', {
              socketId: currentHost.socketId,
              newRole: 'host',
              hostSocketId: room.hostSocketId
            });
          }
          io.to(roomId).emit('sync_state', room.getState());
        }
      }
    }, 8000); // 8-second grace period for refresh/reconnection

    pendingDisconnects.set(disconnectKey, timer);
  };

  socket.on('leave_room', handleExplicitLeave);
  socket.on('disconnect', handleDisconnect);
});

server.listen(PORT, () => {
  console.log(`>>> Watch2Gether server running on port ${PORT}`);
});
