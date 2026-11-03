import express from 'express';
import http from 'node:http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { roomManager } from './models/RoomManager.js';
import { Room } from './models/Room.js';
import { ClientToServerEvents, ServerToClientEvents, Role, ActionRequest } from './types.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
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
    origin: '*',
    methods: ['GET', 'POST']
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

function hasPermission(room: Room, socketId: string, action: string): boolean {
  const participant = room.getParticipant(socketId);
  if (!participant) return false;
  const allowedRoles = PERMISSIONS[action];
  return allowedRoles ? allowedRoles.includes(participant.role) : false;
}

function sendError(socket: Socket<any, any>, message: string) {
  socket.emit('error_message', { message });
  socket.emit('error', { message });
}

io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
  console.log(`[Connected] Socket ID: ${socket.id}`);

  socket.on('join_room', ({ roomId, username }) => {
    if (!roomId) return;
    const cleanRoomId = roomId.trim();
    const cleanUsername = (username || 'Guest').trim();

    socket.join(cleanRoomId);

    const room = roomManager.getOrCreateRoom(cleanRoomId, socket.id, cleanUsername);
    const participant = room.getParticipant(socket.id);
    if (!participant) return;

    socket.emit('sync_state', room.getState());

    io.to(cleanRoomId).emit('user_joined', {
      username: participant.username,
      userId: participant.userId,
      role: participant.role,
      participants: room.getParticipantList()
    });
  });

  socket.on('play', ({ roomId, currentTime }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'play')) {
      return sendError(socket, 'Permission denied: Only Host and Moderators can control playback.');
    }

    room.updatePlaybackState({ isPlaying: true, currentTime });
    socket.to(roomId).emit('play', { currentTime: room.currentTime });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('pause', ({ roomId, currentTime }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'pause')) {
      return sendError(socket, 'Permission denied: Only Host and Moderators can pause playback.');
    }

    room.updatePlaybackState({ isPlaying: false, currentTime });
    socket.to(roomId).emit('pause', { currentTime: room.currentTime });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('seek', ({ roomId, time }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'seek')) {
      return sendError(socket, 'Permission denied: Only Host and Moderators can seek.');
    }

    room.updatePlaybackState({ currentTime: time });
    socket.to(roomId).emit('seek', { time });
    io.to(roomId).emit('sync_state', room.getState());
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

  socket.on('assign_role', ({ roomId, userId, targetSocketId, role, newRole }) => {
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

    if (targetId === socket.id) {
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
      io.to(roomId).emit('role_assigned', {
        userId: updatedParticipant.userId,
        username: updatedParticipant.username,
        role: updatedParticipant.role,
        participants: room.getParticipantList(),
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('role_changed', {
        socketId: updatedParticipant.userId,
        newRole: updatedParticipant.role,
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('sync_state', room.getState());
    }
  });

  socket.on('transfer_host', ({ roomId, userId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'transfer_host')) {
      return sendError(socket, 'Permission denied: Only the Host can transfer host status.');
    }

    if (!userId) {
      return sendError(socket, 'Target user ID is required.');
    }

    if (userId === socket.id) {
      return sendError(socket, 'You are already the host.');
    }

    const targetParticipant = room.getParticipant(userId);
    if (!targetParticipant) {
      return sendError(socket, 'Target user not found in this room.');
    }

    const updatedParticipant = room.transferHost(userId);
    if (updatedParticipant) {
      io.to(roomId).emit('role_assigned', {
        userId: updatedParticipant.userId,
        username: updatedParticipant.username,
        role: 'host',
        participants: room.getParticipantList(),
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('role_changed', {
        socketId: updatedParticipant.userId,
        newRole: 'host',
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('sync_state', room.getState());
    }
  });

  const handleRemoveParticipant = ({ roomId, userId, targetSocketId }: { roomId: string; userId?: string; targetSocketId?: string }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'remove_participant')) {
      return sendError(socket, 'Permission denied: Only the Host can remove participants.');
    }

    const targetId = userId || targetSocketId;
    if (!targetId) {
      return sendError(socket, 'Target user ID is required.');
    }

    if (targetId === socket.id) {
      return sendError(socket, 'The Host cannot remove themselves.');
    }

    const targetParticipant = room.getParticipant(targetId);
    if (!targetParticipant) {
      return sendError(socket, 'Target user not found in this room.');
    }

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('kicked', { message: 'You were removed from the room by the host.' });
      targetSocket.leave(roomId);
    }

    room.removeParticipant(targetId);

    io.to(roomId).emit('participant_removed', {
      userId: targetId,
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
        io.to(roomId).emit('play', { currentTime: room.currentTime });
        return io.to(roomId).emit('sync_state', room.getState());
      }
      if (type === 'pause') {
        room.updatePlaybackState({ isPlaying: false, currentTime: payload?.currentTime });
        io.to(roomId).emit('pause', { currentTime: room.currentTime });
        return io.to(roomId).emit('sync_state', room.getState());
      }
      if (type === 'seek') {
        room.updatePlaybackState({ currentTime: payload?.time });
        io.to(roomId).emit('seek', { time: payload?.time });
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

    for (const [pSocketId, participant] of room.participants.entries()) {
      if (participant.role === 'host' || participant.role === 'moderator') {
        const pSocket = io.sockets.sockets.get(pSocketId);
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
        currentTime: room.currentTime 
      });
      io.to(roomId).emit('sync_state', room.getState());

    } else if (actionReq.type === 'pause') {
      room.updatePlaybackState({ 
        isPlaying: false, 
        currentTime: actionReq.payload?.currentTime 
      });

      io.to(roomId).emit('pause', { 
        currentTime: room.currentTime 
      });
      io.to(roomId).emit('sync_state', room.getState());

    } else if (actionReq.type === 'seek') {
      room.updatePlaybackState({ 
        currentTime: actionReq.payload?.time 
      });

      io.to(roomId).emit('seek', { 
        time: actionReq.payload?.time 
      });
      io.to(roomId).emit('sync_state', room.getState());
    } else if (actionReq.type === 'change_video') {
      room.updatePlaybackState({ videoId: actionReq.payload?.videoId, 
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

  const handleMessage = ({ roomId, text }: { roomId: string; text: string }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !text?.trim()) return;

    const message = room.addMessage(socket.id, text.trim());
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
      userId: socket.id,
      username: participant ? participant.username : 'User'
    };
    io.to(roomId).emit('new_reaction', payload);
    io.to(roomId).emit('reaction', payload);
  };

  socket.on('send_reaction', handleReaction);
  socket.on('reaction', handleReaction);

  const handleLeave = () => {
    const room = roomManager.getRoomBySocketId(socket.id);
    if (!room) return;

    const roomId = room.id;
    const participant = room.removeParticipant(socket.id);

    if (room.participants.size === 0) {
      roomManager.removeRoom(roomId);
    } else {
      io.to(roomId).emit('user_left', {
        userId: socket.id,
        username: participant ? participant.username : 'Guest',
        participants: room.getParticipantList(),
        hostSocketId: room.hostSocketId
      });

      const currentHost = room.getParticipant(room.hostSocketId);
      if (currentHost) {
        io.to(roomId).emit('role_assigned', {
          userId: currentHost.userId,
          username: currentHost.username,
          role: 'host',
          participants: room.getParticipantList(),
          hostSocketId: room.hostSocketId
        });
        io.to(roomId).emit('role_changed', {
          socketId: currentHost.userId,
          newRole: 'host',
          hostSocketId: room.hostSocketId
        });
      }
      io.to(roomId).emit('sync_state', room.getState());
    }
  };

  socket.on('leave_room', handleLeave);
  socket.on('disconnect', handleLeave);
});

server.listen(PORT, () => {
  console.log(`>>> Watch2Gether server running on port ${PORT}`);
});
