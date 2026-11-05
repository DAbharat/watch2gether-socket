import express from 'express';
import http from 'node:http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import 'dotenv/config';
import { roomManager } from './models/RoomManager.js';
import { Room } from './models/Room.js';
import { ClientToServerEvents, ServerToClientEvents, Role, ActionRequest } from './types.js';
import { assignRole, getRole, getAllParticipantRoles, removeParticipantRole, getRoomHost, setRoomHost, removeRoomHost } from './config/storage/role.js';
import {
  setRoomTTL,
  refreshRoomActivity,
  addConnectedParticipant,
  removeConnectedParticipantAtomic,
  getConnectedCount,
  isParticipantConnected,
  clearAllConnectedSets,
  setHostGrace,
  getHostGrace,
  clearHostGrace,
  atomicTransferHost,
  atomicCheckAndPromoteHost,
  saveRoomState,
  getRoomState,
  checkRoomExists,
  scanAllGraceMarkers,
  EMPTY_ROOM_TTL,
} from './config/storage/roomLifecycle.js';
import { saveMessages, getMessages } from './config/storage/chat.js';
import { verifyParticipantToken } from './config/storage/participant/participant.js';
import {
  saveRequest,
  getRequest,
  getAllRequests,
  getUserRequests,
  updateRequest,
  removeUserPendingRequests,
  checkRateLimit,
  checkDuplicate,
  addToQueue,
  getQueue,
  popNextQueueItem,
  getUserPendingCount,
  VideoRequest,
  QueueItem,
} from './config/storage/requests.js';
import { validateYouTubeUrl } from './utils/youtubeValidator.js';
import { startKeepAlive } from './utils/keepAlive.js';

const app = express();
const PORT = process.env.PORT || 4000;

const rawClientUrls = process.env.CLIENT_URL || process.env.FRONTEND_URL || '*';
const allowedOrigins = rawClientUrls.split(',').map((url) => url.trim().replace(/\/$/, ''));

const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return true;
  if (allowedOrigins.includes('*')) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
};

const corsOptions: cors.CorsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, origin?: any) => void) => {
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
    origin: (origin: string | undefined, callback: (err: Error | null, origin?: any) => void) => {
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

function sendError(socket: Socket<ClientToServerEvents, ServerToClientEvents>, message: string) {
  socket.emit('error_message', { message });
  socket.emit('error', { message });
}

// Grace period tracker: key = roomId -> NodeJS.Timeout (60s host grace period)
const hostGraceTimers = new Map<string, NodeJS.Timeout>();

// Disconnect debounce tracker: key = `${roomId}:${userId}` -> NodeJS.Timeout (2s debounce for page refresh/flapping)
const disconnectDebounceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Executes automatic host promotion after grace period ends without host returning.
 * Promotion order: connected Moderator first (longest-present first),
 * otherwise longest-present connected Participant.
 */
async function executeHostPromotion(roomId: string, reason?: string) {
  const room = roomManager.getRoom(roomId);
  const graceMarker = await getHostGrace(roomId);
  const currentHostId = (await getRoomHost(roomId)) || (room ? room.hostUserId : null);
  const departedHostId = graceMarker ? graceMarker.hostId : currentHostId;

  if (!departedHostId) {
    if (hostGraceTimers.has(roomId)) {
      clearTimeout(hostGraceTimers.get(roomId)!);
      hostGraceTimers.delete(roomId);
    }
    await clearHostGrace(roomId);
    return;
  }

  // Double-check if the departed host has reconnected before promoting
  const isHostConnected = await isParticipantConnected(roomId, departedHostId);
  if (isHostConnected) {
    console.log(`[Lifecycle] Host ${departedHostId} is connected; skipping promotion for room ${roomId}.`);
    if (hostGraceTimers.has(roomId)) {
      clearTimeout(hostGraceTimers.get(roomId)!);
      hostGraceTimers.delete(roomId);
    }
    await clearHostGrace(roomId);
    return;
  }

  let nextHostCandidate: { userId: string; username: string; socketId: string } | null = null;
  let oldHostUsername = 'Host';

  if (room) {
    const oldHostP = room.getParticipant(departedHostId);
    if (oldHostP) oldHostUsername = oldHostP.username;

    const connectedParticipants = room.getConnectedParticipants().filter(p => p.userId !== departedHostId);
    const connectedMods = connectedParticipants
      .filter(p => p.role === 'moderator')
      .sort((a, b) => a.joinedAt - b.joinedAt);
    const connectedRegulars = connectedParticipants
      .filter(p => p.role === 'participant')
      .sort((a, b) => a.joinedAt - b.joinedAt);

    const chosen = connectedMods[0] || connectedRegulars[0];
    if (chosen) {
      nextHostCandidate = {
        userId: chosen.userId,
        username: chosen.username,
        socketId: chosen.socketId
      };
    }
  }

  if (!nextHostCandidate) {
    console.log(`[Lifecycle] No connected candidate to promote in room ${roomId}.`);
    if (hostGraceTimers.has(roomId)) {
      clearTimeout(hostGraceTimers.get(roomId)!);
      hostGraceTimers.delete(roomId);
    }
    await clearHostGrace(roomId);
    return;
  }

  const promoted = await atomicCheckAndPromoteHost(roomId, departedHostId, nextHostCandidate.userId);
  if (promoted) {
    console.log(`[Lifecycle] Promoted ${nextHostCandidate.username} (${nextHostCandidate.userId}) to host in room ${roomId}. Reason: ${reason || 'Grace ended'}`);
    if (hostGraceTimers.has(roomId)) {
      clearTimeout(hostGraceTimers.get(roomId)!);
      hostGraceTimers.delete(roomId);
    }
    await clearHostGrace(roomId);

    if (room) {
      const oldHostP = room.getParticipant(departedHostId);
      if (oldHostP) {
        oldHostP.role = 'moderator';
      }
      const newHostP = room.getParticipant(nextHostCandidate.userId);
      if (newHostP) {
        newHostP.role = 'host';
        room.hostUserId = newHostP.userId;
        room.hostSocketId = newHostP.socketId;
      }

      io.to(roomId).emit('role_assigned', {
        userId: nextHostCandidate.userId,
        username: nextHostCandidate.username,
        role: 'host',
        participants: room.getParticipantList(),
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('role_changed', {
        socketId: nextHostCandidate.socketId,
        newRole: 'host',
        hostSocketId: room.hostSocketId
      });
      io.to(roomId).emit('toast_notification', {
        title: 'New Host Assigned',
        message: `${oldHostUsername} left. ${nextHostCandidate.username} is now the host.`,
        type: 'info'
      });
      if (nextHostCandidate.socketId) {
        io.to(nextHostCandidate.socketId).emit('toast_notification', {
          title: 'Host Status',
          message: 'You are now the host.',
          type: 'success'
        });
      }
      io.to(roomId).emit('host_grace_cancelled', { hostId: departedHostId });
      io.to(roomId).emit('sync_state', room.getState());
    }
    await refreshRoomActivity(roomId);
  }
}

/**
 * Lazy check for expired grace marker on room actions / join.
 */
async function checkHostGraceLazily(roomId: string) {
  const marker = await getHostGrace(roomId);
  if (!marker) return null;

  if (Date.now() >= marker.deadline) {
    console.log(`[Lifecycle] Lazy check: Grace expired for room ${roomId}, promoting...`);
    await executeHostPromotion(roomId, 'Grace deadline passed');
    return null;
  }
  return marker;
}

/**
 * Core user disconnection processor with empty-room cleanup and host grace period.
 */
async function processUserDisconnection(
  roomId: string,
  userId: string,
  socketId: string,
  isExplicitLeave: boolean = false
) {
  const remainingConnected = await removeConnectedParticipantAtomic(roomId, userId);
  console.log(`[Lifecycle] User ${userId} disconnected from room ${roomId}. Remaining connected: ${remainingConnected}`);

  const room = roomManager.getRoom(roomId);
  if (!room) return;

  const participant = room.getParticipant(userId);
  if (!participant) return;

  const currentHostId = (await getRoomHost(roomId)) || room.hostUserId;
  const isHost = (currentHostId === userId || participant.role === 'host');

  // Case B.2: When the last connected participant leaves (count == 0)
  if (remainingConnected <= 0) {
    console.log(`[Lifecycle] Last participant left room ${roomId}. Applying 5-minute empty room TTL.`);
    if (hostGraceTimers.has(roomId)) {
      clearTimeout(hostGraceTimers.get(roomId)!);
      hostGraceTimers.delete(roomId);
    }
    await clearHostGrace(roomId);

    await saveRoomState(roomId, {
      videoId: room.videoId,
      currentTime: room.getCalculatedCurrentTime(),
      isPlaying: room.isPlaying,
      anchorPosition: room.anchorPosition,
      anchorServerTime: room.anchorServerTime
    });

    await setRoomTTL(roomId, EMPTY_ROOM_TTL);
    room.markParticipantDisconnected(userId);
    return;
  }

  // Case A.1: The Host left while other participants remain (count > 0)
  if (isHost) {
    console.log(`[Lifecycle] Host ${userId} disconnected with ${remainingConnected} participants remaining. Starting 60s grace period.`);
    room.markParticipantDisconnected(userId);

    const marker = await setHostGrace(roomId, userId, 60000);

    io.to(roomId).emit('toast_notification', {
      title: 'Host Disconnected',
      message: 'Host disconnected. Waiting 60 seconds before assigning a new host.',
      type: 'warning'
    });

    io.to(roomId).emit('host_grace_started', {
      hostId: userId,
      deadline: marker.deadline,
      remainingSeconds: 60
    });

    io.to(roomId).emit('participants_update', room.getParticipantList());
    io.to(roomId).emit('user_left', {
      userId,
      username: participant.username,
      participants: room.getParticipantList(),
      hostSocketId: room.hostSocketId
    });

    if (hostGraceTimers.has(roomId)) {
      clearTimeout(hostGraceTimers.get(roomId)!);
    }

    const timer = setTimeout(async () => {
      hostGraceTimers.delete(roomId);
      await executeHostPromotion(roomId, '60s grace period ended');
    }, 60000);

    hostGraceTimers.set(roomId, timer);
    return;
  }

  // Case: Non-host left
  if (isExplicitLeave) {
    room.removeParticipant(userId);
    removeParticipantRole(roomId, userId).catch(() => {});
  } else {
    room.markParticipantDisconnected(userId);
  }

  removeUserPendingRequests(roomId, userId).then(async (droppedIds) => {
    if (droppedIds.length > 0) {
      const refreshed = await getAllRequests(roomId);
      for (const [_, p] of room.participants.entries()) {
        if (p.role === 'host' || p.role === 'moderator') {
          io.sockets.sockets.get(p.socketId)?.emit('requests_sync', { requests: refreshed });
        }
      }
    }
  }).catch(() => {});

  io.to(roomId).emit('user_left', {
    userId,
    username: participant.username,
    participants: room.getParticipantList(),
    hostSocketId: room.hostSocketId
  });
  io.to(roomId).emit('sync_state', room.getState());
}

/**
 * On server startup: prunes stale room:*:connected keys and restores/schedules active grace timers.
 */
async function initializeServerLifecycle() {
  try {
    await clearAllConnectedSets();
    const markers = await scanAllGraceMarkers();
    for (const { roomId, marker } of markers) {
      const remaining = marker.deadline - Date.now();
      if (remaining <= 0) {
        console.log(`[Lifecycle] Expired grace marker found for room ${roomId}, promoting immediately.`);
        await executeHostPromotion(roomId, 'Expired on startup');
      } else {
        console.log(`[Lifecycle] Active grace marker found for room ${roomId}, rescheduling for ${Math.round(remaining / 1000)}s.`);
        const timer = setTimeout(() => {
          executeHostPromotion(roomId, 'Startup rescheduled timer').catch(err => console.error('[Lifecycle] Promotion failed:', err));
        }, remaining);
        hostGraceTimers.set(roomId, timer);
      }
    }
  } catch (err: any) {
    console.error('[Lifecycle] Startup initialization error:', err.message);
  }
}

io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
  console.log(`[Connected] Socket ID: ${socket.id}`);

  socket.on('join_room', async ({ roomId, username, participantId, participantToken, isCreating }) => {
    if (!roomId) return;
    const cleanRoomId = roomId.trim();
    const cleanUsername = (username || 'Guest').trim();

    // Verify room existence: check memory & Redis
    const roomInMemory = roomManager.getRoom(cleanRoomId);
    const roomInRedis = await checkRoomExists(cleanRoomId);

    if (!roomInMemory && !roomInRedis && !isCreating) {
      console.log(`[Lifecycle] Unknown or expired room ${cleanRoomId} joined without create flag.`);
      sendError(socket, 'This room no longer exists.');
      socket.emit('room_not_found', {
        roomId: cleanRoomId,
        message: 'This room no longer exists.'
      });
      return;
    }

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

    // Cancel 2-second reconnect debounce if user reconnected quickly
    const disconnectKey = `${cleanRoomId}:${stableUserId}`;
    if (disconnectDebounceTimers.has(disconnectKey)) {
      clearTimeout(disconnectDebounceTimers.get(disconnectKey)!);
      disconnectDebounceTimers.delete(disconnectKey);
    }

    socket.join(cleanRoomId);

    // Lazy check grace marker
    await checkHostGraceLazily(cleanRoomId);

    // Check if user is returning host during active grace period
    const activeGrace = await getHostGrace(cleanRoomId);
    const isReturningHostInGrace = Boolean(activeGrace && activeGrace.hostId === stableUserId);

    if (isReturningHostInGrace) {
      console.log(`[Lifecycle] Host ${stableUserId} returned within grace period!`);
      if (hostGraceTimers.has(cleanRoomId)) {
        clearTimeout(hostGraceTimers.get(cleanRoomId)!);
        hostGraceTimers.delete(cleanRoomId);
      }
      await clearHostGrace(cleanRoomId);
      io.to(cleanRoomId).emit('host_grace_cancelled', { hostId: stableUserId });
      io.to(cleanRoomId).emit('toast_notification', {
        title: 'Host is Back',
        message: 'Host is back.',
        type: 'success'
      });
    }

    let role: Role = 'participant';
    let designatedHostId: string | null = null;

    try {
      designatedHostId = await getRoomHost(cleanRoomId);
      const existingRole = await getRole(cleanRoomId, stableUserId);
      const connectedCount = await getConnectedCount(cleanRoomId);

      if (isReturningHostInGrace || (designatedHostId && stableUserId === designatedHostId)) {
        role = 'host';
        designatedHostId = stableUserId;
      } else if (!designatedHostId || connectedCount === 0) {
        // If room had no host (the only member left while being host), first person to rejoin becomes Host
        role = 'host';
        designatedHostId = stableUserId;
        await atomicTransferHost(cleanRoomId, stableUserId);
      } else if (existingRole && ['moderator', 'participant'].includes(existingRole)) {
        role = existingRole as Role;
      } else {
        role = 'participant';
        await assignRole(cleanRoomId, stableUserId, 'participant');
      }
    } catch (err: any) {
      console.error('[Redis] Error fetching/assigning role:', err.message);
      if (!roomInMemory || roomInMemory.participants.size === 0) {
        role = 'host';
        designatedHostId = stableUserId;
      }
    }

    const { room, isNewRoom } = roomManager.getOrCreateRoom(
      cleanRoomId,
      socket.id,
      cleanUsername,
      stableUserId,
      role,
      designatedHostId || undefined
    );

    if (isNewRoom) {
      try {
        const savedState = await getRoomState(cleanRoomId);
        if (savedState) {
          room.videoId = savedState.videoId;
          room.currentTime = savedState.currentTime;
          room.isPlaying = savedState.isPlaying;
          room.anchorPosition = savedState.anchorPosition;
          room.anchorServerTime = savedState.anchorServerTime;
        }
      } catch (err: any) {
        console.error('[Redis] Error restoring state:', err.message);
      }
    }

    if (role === 'host') {
      room.hostUserId = stableUserId;
      room.hostSocketId = socket.id;
    }

    // Mark connected in room model and Redis connected set
    room.markParticipantConnected(stableUserId, socket.id);
    await addConnectedParticipant(cleanRoomId, stableUserId);

    // Restore sliding 24h TTL across all room keys on rejoin
    await refreshRoomActivity(cleanRoomId);

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

    // If grace is active for another user, let this socket know immediately
    if (activeGrace && !isReturningHostInGrace) {
      const remainingSec = Math.max(0, Math.ceil((activeGrace.deadline - Date.now()) / 1000));
      socket.emit('host_grace_started', {
        hostId: activeGrace.hostId,
        deadline: activeGrace.deadline,
        remainingSeconds: remainingSec
      });
    }

    try {
      const queue = await getQueue(cleanRoomId);
      socket.emit('queue_updated', { queue });

      if (participant.role === 'host' || participant.role === 'moderator') {
        const allReqs = await getAllRequests(cleanRoomId);
        socket.emit('requests_sync', { requests: allReqs });
      } else {
        const userReqs = await getUserRequests(cleanRoomId, participant.userId);
        socket.emit('requests_sync', { requests: userReqs });
      }
    } catch (err: any) {
      console.error('[Redis] Error loading queue/requests on join:', err.message);
    }

    socket.to(cleanRoomId).emit('user_joined', {
      username: participant.username,
      userId: participant.userId,
      role: participant.role,
      joinedAt: participant.joinedAt,
      participant: {
        socketId: socket.id,
        userId: participant.userId,
        username: participant.username,
        role: participant.role,
        joinedAt: participant.joinedAt,
        connected: true
      }
    });
    io.to(cleanRoomId).emit('participants_update', room.getParticipantList());
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
    refreshRoomActivity(roomId).catch(() => {});
    saveRoomState(roomId, {
      videoId: room.videoId,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      anchorPosition: room.anchorPosition,
      anchorServerTime: room.anchorServerTime
    }).catch(() => {});
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
    refreshRoomActivity(roomId).catch(() => {});
    saveRoomState(roomId, {
      videoId: room.videoId,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      anchorPosition: room.anchorPosition,
      anchorServerTime: room.anchorServerTime
    }).catch(() => {});
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
    refreshRoomActivity(roomId).catch(() => {});
    saveRoomState(roomId, {
      videoId: room.videoId,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      anchorPosition: room.anchorPosition,
      anchorServerTime: room.anchorServerTime
    }).catch(() => {});
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
    refreshRoomActivity(roomId).catch(() => {});
    saveRoomState(roomId, {
      videoId: room.videoId,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      anchorPosition: room.anchorPosition,
      anchorServerTime: room.anchorServerTime
    }).catch(() => {});
  });

  socket.on('assign_role', async ({ roomId, userId, targetSocketId, role, newRole }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'assign_role')) {
      return sendError(socket, 'Permission denied: Only the Host can assign roles.');
    }

    const activeGrace = await checkHostGraceLazily(roomId);
    if (activeGrace) {
      return sendError(socket, 'Host-only actions are locked while waiting for host reconnection.');
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

    if (targetRole === 'host') {
      const previousHost = room.getParticipant(room.hostUserId || room.hostSocketId);
      const updatedParticipant = room.transferHost(targetId);
      if (updatedParticipant) {
        try {
          await atomicTransferHost(roomId, updatedParticipant.userId, previousHost?.userId);
          if (hostGraceTimers.has(roomId)) {
            clearTimeout(hostGraceTimers.get(roomId)!);
            hostGraceTimers.delete(roomId);
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
        io.to(roomId).emit('toast_notification', {
          title: 'Host Transferred',
          message: `${previousHost ? previousHost.username : 'Previous host'} transferred host to ${updatedParticipant.username}.`,
          type: 'info'
        });
        if (updatedParticipant.socketId) {
          io.to(updatedParticipant.socketId).emit('toast_notification', {
            title: 'Host Status',
            message: 'You are now the host.',
            type: 'success'
          });
        }
        io.to(roomId).emit('sync_state', room.getState());
        refreshRoomActivity(roomId).catch(() => {});
      }
      return;
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
      refreshRoomActivity(roomId).catch(() => {});
    }
  });

  socket.on('transfer_host', async ({ roomId, userId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'transfer_host')) {
      return sendError(socket, 'Permission denied: Only the Host can transfer host status.');
    }

    const activeGrace = await checkHostGraceLazily(roomId);
    if (activeGrace) {
      return sendError(socket, 'Host-only actions are locked while waiting for host reconnection.');
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
        await atomicTransferHost(roomId, updatedParticipant.userId, previousHost?.userId);
        if (hostGraceTimers.has(roomId)) {
          clearTimeout(hostGraceTimers.get(roomId)!);
          hostGraceTimers.delete(roomId);
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
      io.to(roomId).emit('toast_notification', {
        title: 'Host Transferred',
        message: `${previousHost ? previousHost.username : 'Previous host'} transferred host to ${updatedParticipant.username}.`,
        type: 'info'
      });
      if (updatedParticipant.socketId) {
        io.to(updatedParticipant.socketId).emit('toast_notification', {
          title: 'Host Status',
          message: 'You are now the host.',
          type: 'success'
        });
      }
      io.to(roomId).emit('sync_state', room.getState());
      refreshRoomActivity(roomId).catch(() => {});
    }
  });

  const handleRemoveParticipant = async ({ roomId, userId, targetSocketId }: { roomId: string; userId?: string; targetSocketId?: string }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (!hasPermission(room, socket.id, 'remove_participant')) {
      return sendError(socket, 'Permission denied: Only the Host can remove participants.');
    }

    const activeGrace = await checkHostGraceLazily(roomId);
    if (activeGrace) {
      return sendError(socket, 'Host-only actions are locked while waiting for host reconnection.');
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
    if (disconnectDebounceTimers.has(disconnectKey)) {
      clearTimeout(disconnectDebounceTimers.get(disconnectKey)!);
      disconnectDebounceTimers.delete(disconnectKey);
    }

    room.removeParticipant(targetParticipant.userId);

    try {
      await removeParticipantRole(roomId, targetParticipant.userId);
    } catch (err: any) {
      console.error('[Redis] Error removing participant role on kick:', err.message);
    }

    const remaining = await removeConnectedParticipantAtomic(roomId, targetParticipant.userId);
    if (remaining <= 0) {
      await setRoomTTL(roomId, EMPTY_ROOM_TTL);
    } else {
      refreshRoomActivity(roomId).catch(() => {});
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

  const handleMessage = ({ roomId, text }: { roomId: string; text: string }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !text?.trim()) return;

    const participant = room.getParticipant(socket.id);
    if (participant) {
      socket.to(roomId).emit('user_typing', {
        userId: participant.userId,
        username: participant.username,
        isTyping: false,
      });
    }

    const message = room.addMessage(socket.id, text.trim());

    io.to(roomId).emit('chat_message', message);
    saveMessages(roomId, message).catch((err: any) => {
      console.error('[Redis] Error saving message:', err?.message);
    });
    refreshRoomActivity(roomId).catch(() => {});
  };

  socket.on('send_message', handleMessage);
  socket.on('chat_message', handleMessage);

  socket.on('typing_start', ({ roomId }: { roomId: string }) => {
    if (!roomId) return;
    const room = roomManager.getRoom(roomId);
    if (!room) return;
    const participant = room.getParticipant(socket.id);
    if (!participant) return;

    socket.to(roomId).emit('user_typing', {
      userId: participant.userId,
      username: participant.username,
      isTyping: true,
    });
  });

  socket.on('typing_stop', ({ roomId }: { roomId: string }) => {
    if (!roomId) return;
    const room = roomManager.getRoom(roomId);
    if (!room) return;
    const participant = room.getParticipant(socket.id);
    if (!participant) return;

    socket.to(roomId).emit('user_typing', {
      userId: participant.userId,
      username: participant.username,
      isTyping: false,
    });
  });

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
    io.to(roomId).emit('reaction', payload);
  };

  socket.on('send_reaction', handleReaction);
  socket.on('reaction', handleReaction);

  socket.on('get_requests', async ({ roomId, participantToken }) => {
    if (!roomId) return;
    const cleanRoomId = roomId.trim();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room) return;

    const participant = room.getParticipant(socket.id);
    if (!participant) return;

    if (participantToken) {
      const isValid = await verifyParticipantToken(cleanRoomId, participant.userId, participantToken.trim());
      if (!isValid) return sendError(socket, 'Unauthorized participant token.');
    }

    try {
      const currentRole = await getRole(cleanRoomId, participant.userId);
      if (currentRole === 'host' || currentRole === 'moderator') {
        const requests = await getAllRequests(cleanRoomId);
        socket.emit('requests_sync', { requests });
      } else {
        const requests = await getUserRequests(cleanRoomId, participant.userId);
        socket.emit('requests_sync', { requests });
      }

      const queue = await getQueue(cleanRoomId);
      socket.emit('queue_updated', { queue });
    } catch (err: any) {
      console.error('[Redis] Error fetching requests:', err.message);
    }
  });

  socket.on('request_video', async ({ roomId, participantToken, videoUrl }) => {
    if (!roomId || !participantToken || !videoUrl) {
      return sendError(socket, 'Missing required parameters for video request.');
    }

    const cleanRoomId = roomId.trim();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room) return sendError(socket, 'Room not found.');

    const participant = room.getParticipant(socket.id);
    if (!participant) return sendError(socket, 'You are not in this room.');

    const isTokenValid = await verifyParticipantToken(cleanRoomId, participant.userId, participantToken.trim());
    if (!isTokenValid) {
      return sendError(socket, 'Unauthorized participant token.');
    }

    const currentRole = await getRole(cleanRoomId, participant.userId);
    if (currentRole !== 'participant') {
      return sendError(socket, 'Host and moderators can change or queue videos directly.');
    }

    const validation = validateYouTubeUrl(videoUrl);
    if (!validation.valid || !validation.videoId) {
      return sendError(socket, validation.error || 'Invalid YouTube URL.');
    }

    const videoId = validation.videoId;

    const rateOk = await checkRateLimit(cleanRoomId, participant.userId);
    if (!rateOk) {
      return sendError(socket, 'Rate limit exceeded: Max 5 requests per minute.');
    }

    const pendingCount = await getUserPendingCount(cleanRoomId, participant.userId);
    if (pendingCount >= 3) {
      return sendError(socket, 'You already have 3 pending requests. Please wait for them to be reviewed.');
    }

    const isDup = await checkDuplicate(cleanRoomId, videoId);
    if (isDup) {
      return sendError(socket, 'This video is already requested or in the queue.');
    }

    const queue = await getQueue(cleanRoomId);
    if (queue.length >= 20) {
      return sendError(socket, 'Queue is currently full (max 20 videos).');
    }

    const requestId = `req_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
    const newRequest: VideoRequest = {
      requestId,
      userId: participant.userId,
      username: participant.username,
      videoId,
      status: 'pending',
      createdAt: Date.now(),
    };

    try {
      await saveRequest(cleanRoomId, newRequest);

      socket.emit('request_created', { request: newRequest });
      socket.emit('request_notification', { message: 'Video request submitted!', type: 'success' });

      for (const [_, p] of room.participants.entries()) {
        if (p.role === 'host' || p.role === 'moderator') {
          const s = io.sockets.sockets.get(p.socketId);
          if (s && s.id !== socket.id) {
            s.emit('request_created', { request: newRequest });
          }
        }
      }
      refreshRoomActivity(cleanRoomId).catch(() => {});
    } catch (err: any) {
      console.error('[Redis] Error saving video request:', err.message);
      sendError(socket, 'Failed to save video request. Please try again.');
    }
  });

  socket.on('resolve_request', async ({ roomId, participantToken, requestId, action }) => {
    if (!roomId || !participantToken || !requestId || !action) {
      return sendError(socket, 'Missing required parameters to resolve request.');
    }

    const cleanRoomId = roomId.trim();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room) return sendError(socket, 'Room not found.');

    const approver = room.getParticipant(socket.id);
    if (!approver) return sendError(socket, 'You are not in this room.');

    const isTokenValid = await verifyParticipantToken(cleanRoomId, approver.userId, participantToken.trim());
    if (!isTokenValid) {
      return sendError(socket, 'Unauthorized participant token.');
    }

    const approverRole = await getRole(cleanRoomId, approver.userId);
    if (approverRole !== 'host' && approverRole !== 'moderator') {
      return sendError(socket, 'Permission denied: Only Host and Moderators can resolve requests.');
    }

    const reqItem = await getRequest(cleanRoomId, requestId);
    if (!reqItem || reqItem.status !== 'pending') {
      return sendError(socket, 'Request not found or already resolved.');
    }

    if (action === 'play_now') {
      reqItem.status = 'accepted';
      reqItem.action = 'play_now';
      reqItem.resolvedAt = Date.now();
      reqItem.resolvedBy = approver.username;
      await updateRequest(cleanRoomId, reqItem);

      room.updatePlaybackState({ videoId: reqItem.videoId, currentTime: 0, isPlaying: true });
      io.to(cleanRoomId).emit('change_video', { videoId: reqItem.videoId });
      io.to(cleanRoomId).emit('sync_state', room.getState());

      const requesterParticipant = room.participants.get(reqItem.userId);
      if (requesterParticipant) {
        const reqSocket = io.sockets.sockets.get(requesterParticipant.socketId);
        reqSocket?.emit('request_updated', { request: reqItem, message: 'Accepted' });
        reqSocket?.emit('request_notification', { message: 'Your video request was accepted and is playing now!', type: 'success' });
      }

      for (const [_, p] of room.participants.entries()) {
        if (p.role === 'host' || p.role === 'moderator') {
          io.sockets.sockets.get(p.socketId)?.emit('request_updated', { request: reqItem });
        }
      }
    } else if (action === 'queue') {
      const currentQueue = await getQueue(cleanRoomId);
      if (currentQueue.length >= 20) {
        return sendError(socket, 'Queue is full (maximum 20 videos).');
      }

      const queueItem: QueueItem = {
        videoId: reqItem.videoId,
        requestedBy: reqItem.userId,
        requestedByUsername: reqItem.username,
        approvedAt: Date.now(),
      };

      await addToQueue(cleanRoomId, queueItem);

      reqItem.status = 'accepted';
      reqItem.action = 'queue';
      reqItem.resolvedAt = Date.now();
      reqItem.resolvedBy = approver.username;
      await updateRequest(cleanRoomId, reqItem);

      const updatedQueue = await getQueue(cleanRoomId);
      io.to(cleanRoomId).emit('queue_updated', { queue: updatedQueue });

      const requesterParticipant = room.participants.get(reqItem.userId);
      if (requesterParticipant) {
        const reqSocket = io.sockets.sockets.get(requesterParticipant.socketId);
        reqSocket?.emit('request_updated', { request: reqItem, message: 'Added to queue' });
        reqSocket?.emit('request_notification', { message: 'Your video request was added to the queue!', type: 'success' });
      }

      for (const [_, p] of room.participants.entries()) {
        if (p.role === 'host' || p.role === 'moderator') {
          io.sockets.sockets.get(p.socketId)?.emit('request_updated', { request: reqItem });
        }
      }
    } else if (action === 'reject') {
      reqItem.status = 'rejected';
      reqItem.action = 'reject';
      reqItem.resolvedAt = Date.now();
      reqItem.resolvedBy = approver.username;
      await updateRequest(cleanRoomId, reqItem);

      const requesterParticipant = room.participants.get(reqItem.userId);
      if (requesterParticipant) {
        const reqSocket = io.sockets.sockets.get(requesterParticipant.socketId);
        reqSocket?.emit('request_updated', { request: reqItem, message: 'Rejected' });
        reqSocket?.emit('request_notification', { message: 'Your video request was rejected.', type: 'info' });
      }

      for (const [_, p] of room.participants.entries()) {
        if (p.role === 'host' || p.role === 'moderator') {
          io.sockets.sockets.get(p.socketId)?.emit('request_updated', { request: reqItem });
        }
      }
    }
    refreshRoomActivity(cleanRoomId).catch(() => {});
  });

  socket.on('video_ended', async ({ roomId, videoId, participantToken }) => {
    if (!roomId) return;
    const cleanRoomId = roomId.trim();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room) return;

    const caller = room.getParticipant(socket.id);
    if (!caller) return;

    if (participantToken) {
      const isTokenValid = await verifyParticipantToken(cleanRoomId, caller.userId, participantToken.trim());
      if (!isTokenValid) return;
    }

    const callerRole = await getRole(cleanRoomId, caller.userId);
    if (callerRole !== 'host' && callerRole !== 'moderator') return;

    if (videoId && videoId !== room.videoId) return;

    try {
      const nextItem = await popNextQueueItem(cleanRoomId);
      if (nextItem) {
        room.updatePlaybackState({ videoId: nextItem.videoId, currentTime: 0, isPlaying: true });
        io.to(cleanRoomId).emit('change_video', { videoId: nextItem.videoId });
        const updatedQueue = await getQueue(cleanRoomId);
        io.to(cleanRoomId).emit('queue_updated', { queue: updatedQueue });
        io.to(cleanRoomId).emit('sync_state', room.getState());
      } else {
        room.updatePlaybackState({ isPlaying: false, currentTime: room.currentTime });
        io.to(cleanRoomId).emit('pause', {
          currentTime: room.currentTime,
          anchorPosition: room.anchorPosition,
          anchorServerTime: room.anchorServerTime,
          sentAt: Date.now(),
        });
        io.to(cleanRoomId).emit('sync_state', room.getState());
      }
    } catch (err: any) {
      console.error('[Redis] Error advancing queue:', err.message);
    }
  });

  const handleExplicitLeave = async () => {
    const room = roomManager.getRoomBySocketId(socket.id);
    if (!room) return;

    const participant = room.getParticipant(socket.id);
    if (!participant) return;

    const roomId = room.id;
    const userId = participant.userId;
    const disconnectKey = `${roomId}:${userId}`;

    if (disconnectDebounceTimers.has(disconnectKey)) {
      clearTimeout(disconnectDebounceTimers.get(disconnectKey)!);
      disconnectDebounceTimers.delete(disconnectKey);
    }

    socket.leave(roomId);
    await processUserDisconnection(roomId, userId, socket.id, true);
  };

  const handleDisconnect = () => {
    const room = roomManager.getRoomBySocketId(socket.id);
    if (!room) return;

    const participant = room.getParticipant(socket.id);
    if (!participant) return;

    const roomId = room.id;
    const userId = participant.userId;
    socket.to(roomId).emit('user_typing', {
      userId,
      username: participant.username,
      isTyping: false,
    });

    const disconnectKey = `${roomId}:${userId}`;
    if (disconnectDebounceTimers.has(disconnectKey)) {
      clearTimeout(disconnectDebounceTimers.get(disconnectKey)!);
    }

    // 2-second reconnect debounce to absorb page refreshes / quick drops
    const debounceTimer = setTimeout(async () => {
      disconnectDebounceTimers.delete(disconnectKey);
      const currentParticipant = room.getParticipant(userId);
      if (currentParticipant && currentParticipant.socketId === socket.id) {
        await processUserDisconnection(roomId, userId, socket.id, false);
      }
    }, 2000);

    disconnectDebounceTimers.set(disconnectKey, debounceTimer);
  };

  socket.on('leave_room', handleExplicitLeave);
  socket.on('disconnect', handleDisconnect);
});

server.listen(PORT, async () => {
  console.log(`>>> Watch2Gether server running on port ${PORT}`);
  await initializeServerLifecycle();
  startKeepAlive();
});
