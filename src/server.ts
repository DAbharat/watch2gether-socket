import express from 'express';
import http from 'node:http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { roomManager } from './models/RoomManager.js';
import { ClientToServerEvents, ServerToClientEvents } from './types.js';

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

    // Validate that user has host or moderator privileges
    if (!room.canControl(socket.id)) {
      return socket.emit('error_message', { message: 'Only Host and Moderators can control playback.' });
    }

    room.updatePlaybackState({ isPlaying: true, currentTime });
    socket.to(roomId).emit('play', { currentTime: room.currentTime });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('pause', ({ roomId, currentTime }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!room.canControl(socket.id)) {
      return socket.emit('error_message', { message: 'Only Host and Moderators can control playback.' });
    }

    room.updatePlaybackState({ isPlaying: false, currentTime });
    socket.to(roomId).emit('pause', { currentTime: room.currentTime });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('seek', ({ roomId, time }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!room.canControl(socket.id)) {
      return socket.emit('error_message', { message: 'Only Host and Moderators can seek.' });
    }

    room.updatePlaybackState({ currentTime: time });
    socket.to(roomId).emit('seek', { time });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('change_video', ({ roomId, videoId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!room.canControl(socket.id)) {
      return socket.emit('error_message', { message: 'Only Host and Moderators can change the video.' });
    }

    room.updatePlaybackState({ videoId, currentTime: 0, isPlaying: true });
    io.to(roomId).emit('change_video', { videoId });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('assign_role', ({ roomId, userId, role }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!room.isHost(socket.id)) {
      return socket.emit('error_message', { message: 'Only the Host can assign roles.' });
    }

    const targetParticipant = room.assignRole(userId, role);
    if (targetParticipant) {
      io.to(roomId).emit('role_assigned', {
        userId: targetParticipant.userId,
        username: targetParticipant.username,
        role: targetParticipant.role,
        participants: room.getParticipantList(),
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('sync_state', room.getState());
    }
  });

  socket.on('remove_participant', ({ roomId, userId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!room.isHost(socket.id)) {
      return socket.emit('error_message', { message: 'Only the Host can remove participants.' });
    }

    const targetSocket = io.sockets.sockets.get(userId);
    if (targetSocket) {
      targetSocket.emit('kicked', { message: 'You were removed from the room by the host.' });
      targetSocket.leave(roomId);
    }

    room.removeParticipant(userId);

    io.to(roomId).emit('participant_removed', {
      userId,
      participants: room.getParticipantList()
    });
    io.to(roomId).emit('sync_state', room.getState());
  });

  socket.on('send_message', ({ roomId, text }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !text?.trim()) return;

    const message = room.addMessage(socket.id, text.trim());
    io.to(roomId).emit('new_message', message);
  });

  socket.on('send_reaction', ({ roomId, emoji }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    const participant = room.getParticipant(socket.id);
    io.to(roomId).emit('new_reaction', {
      emoji,
      userId: socket.id,
      username: participant ? participant.username : 'User'
    });
  });

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
      io.to(roomId).emit('sync_state', room.getState());
    }
  };

  socket.on('leave_room', handleLeave);
  socket.on('disconnect', handleLeave);
});

server.listen(PORT, () => {
  console.log(`>>> Watch2Gether server running on port ${PORT}`);
});
