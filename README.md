# Watch2Gether Socket Server

Stateful, high-throughput WebSocket coordination engine for real-time synchronized video playback, role-based access control, ephemeral chat broadcasting, and room lifecycle management.

This service acts as the central real-time authority in the Watch2Gether platform. It multiplexes persistent bidirectional TCP/WebSocket connections, maintains an in-memory room registry, computes deterministic playback timeline anchors, enforces role-based moderation gates, and interfaces asynchronously with Redis for bounded ephemeral caching.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Architectural Diagrams](#architectural-diagrams)
3. [Core Engineering Mechanisms](#core-engineering-mechanisms)
   - [Timeline Anchor Synchronization Engine](#timeline-anchor-synchronization-engine)
   - [NTP Clock Offset Protocol](#ntp-clock-offset-protocol)
   - [O(1) Delta Join Architecture](#o1-delta-join-architecture)
   - [Asynchronous Non-Blocking Persistence](#asynchronous-non-blocking-persistence)
   - [Disconnection Grace Period & Token Recovery](#disconnection-grace-period--token-recovery)
   - [Role-Based Access Control (RBAC) & Request Pipeline](#role-based-access-control-rbac--request-pipeline)
4. [Storage Strategy: Ephemeral Memory vs. Databases](#storage-strategy-ephemeral-memory-vs-databases)
5. [Technology Stack & Design Choices](#technology-stack--design-choices)
6. [Benchmark & Concurrency Performance](#benchmark--concurrency-performance)
   - [Localhost Concurrency Benchmarks (Raw Engine Performance)](#localhost-concurrency-benchmarks-raw-engine-performance)
   - [Remote Cloud Concurrency Benchmarks (Render Production Environment)](#remote-cloud-concurrency-benchmarks-render-production-environment)
   - [Architectural Optimization Progression](#architectural-optimization-progression)
7. [Socket API Specification](#socket-api-specification)
   - [Client-to-Server Events](#client-to-server-events)
   - [Server-to-Client Events](#server-to-client-events)
8. [Codebase Structure](#codebase-structure)
9. [Configuration & Environment Variables](#configuration--environment-variables)
10. [Local Development & Deployment](#local-development--deployment)

---

## Architecture Overview

The server operates as a hybrid in-memory coordinator backed by an asynchronous key-value persistence layer:

```
+-------------------------------------------------------------------------+
|                    watch2gether-sockets (Node.js)                       |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  |                     Socket.IO Server Engine                       |  |
|  |   - WebSocket Transport Protocol Priority                         |  |
|  |   - Connection Multiplexing & Heartbeat Keep-Alive                |  |
|  |   - CORS Validation & Origin Enforcement                          |  |
|  +---------------------------------+---------------------------------+  |
|                                    |                                    |
|                                    v                                    |
|  +-------------------------------------------------------------------+  |
|  |                   RoomManager (In-Memory Heap)                    |  |
|  |   - Active Room Entities: Map<RoomId, Room>                       |  |
|  |   - Participant Registry: Map<UserId, Participant>                |  |
|  |   - Deterministic Timeline Anchors (anchorPosition, anchorTime)   |  |
|  |   - Active Action Request Queues                                  |  |
|  +---------------------------------+---------------------------------+  |
|                                    |                                    |
|                   Non-Blocking Asynchronous Pipeline                    |
|                                    |                                    |
|                                    v                                    |
|  +-------------------------------------------------------------------+  |
|  |                    Persistence Tier (Redis)                       |  |
|  |   - Ephemeral Chat History: LPUSH + LTRIM (Bounded at 150)        |  |
|  |   - Room Host & Participant Roles: Hash Maps                      |  |
|  |   - Video Request Queues & Tokens with Native TTL Expire          |  |
|  +-------------------------------------------------------------------+  |
+-------------------------------------------------------------------------+
```

### Architectural Principles

- **In-Memory First Execution**: Every state mutation (play, pause, seek, join, leave, chat message) executes synchronously against the in-memory `RoomManager` heap and broadcasts instantly to connected sockets.
- **Off-Path Persistence**: No client socket ever blocks waiting for database round-trips. Disk/database operations are offloaded asynchronously via non-blocking multi-exec pipelines.
- **Deterministic Math over Continuous Polling**: Video playhead positions are computed deterministically using mathematical anchor points rather than continuous position broadcasting.
- **Fail-Safe Grace Periods**: Browser refreshes and brief network interruptions do not destroy user session roles or trigger spurious room notifications.

---

## Architectural Diagrams

### Core Server Architecture & State Flow

```mermaid
graph TD
    ClientConnections["Connected WebSocket Clients"] <-->|Bidirectional Frames| SocketServer["Socket.IO Server Engine"]

    subgraph MemoryEngine["In-Memory Execution Engine"]
        SocketServer --> RoomManager["RoomManager Singleton"]
        RoomManager --> RoomInstance["Room Entity (roomId)"]
        RoomInstance --> ParticipantMap["Participant Map (userId -> Participant)"]
        RoomInstance --> TimelineAnchor["Timeline Anchor (position, serverTime)"]
        RoomInstance --> ActionQueue["Pending Action Request Queue"]
        RoomInstance --> ChatBuffer["Ephemeral Chat Ring Buffer"]
    end

    subgraph SecurityLogic["Control & Validation Gates"]
        SocketServer --> TokenVerifier["Participant Token Validator"]
        SocketServer --> RBACGate["RBAC Gatekeeper (Host / Moderator / Viewer)"]
        SocketServer --> DisconnectQueue["Pending Disconnect Grace Queue (8s Timer)"]
    end

    subgraph PersistencePipeline["Persistence Tier (Redis Cloud)"]
        RoomInstance -.->|Async Fire-and-Forget| RedisChat["LPUSH + LTRIM (Capped 150)"]
        RoomInstance -.->|Async Non-Blocking| RedisRoles["Role Mapping (room:id:roles)"]
        RoomInstance -.->|Async Non-Blocking| RedisHost["Host Record (room:id:host)"]
        RoomInstance -.->|Async Non-Blocking| RedisQueue["Video Request Queue"]
    end
```

### Playback Synchronization State Machine

```mermaid
stateDiagram-v2
    [*] --> Paused: Room Created / Video Loaded

    Paused --> Playing: Host / Mod emits 'play'
    note right of Playing
        Server sets:
        anchorPosition = currentTime
        anchorServerTime = Date.now()
        Broadcasts: anchorPosition, anchorServerTime
    end note

    Playing --> Paused: Host / Mod emits 'pause'
    note right of Paused
        Server sets:
        anchorPosition = currentTime
        anchorServerTime = Date.now()
        isPlaying = false
    end note

    Playing --> Playing: Host / Mod emits 'seek'
    Paused --> Paused: Host / Mod emits 'seek'
    note right of Playing
        Updates anchorPosition = seekTime
        anchorServerTime = Date.now()
    end note

    Playing --> Playing: Heartbeat emitted
    note right of Playing
        Validates target playhead:
        Target = anchorPosition + (Now - anchorServerTime)
    end note
```

### Disconnection & Grace Period Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant Socket as Client Socket
    participant Server as Socket Server
    participant Timer as Pending Disconnect Queue
    participant Room as Room Entity
    participant Redis as Redis Storage

    Socket->>Server: Transport Disconnected (Refresh / Drop)
    Server->>Server: Retrieve Participant Metadata (userId)
    Server->>Timer: Stage Disconnection Timer (8000ms window)
    Server-->>Room: Retain Participant in Map temporarily

    alt User Reconnects within 8 Seconds
        Socket->>Server: join_room { roomId, userId, participantToken }
        Server->>Server: Verify Cryptographic Token
        Server->>Timer: Cancel Staged Timer
        Server->>Room: Bind New Socket ID to Existing Participant
        Server-->>Socket: sync_state (Session Restored)
        Note over Server: Zero room disturbance; role and host intact
    else 8 Seconds Expire
        Timer->>Room: Evict Participant (removeParticipant)
        Timer-.->Redis: Delete Role & Pending Requests asynchronously
        Timer-->>Server: Broadcast 'user_left' { userId }
        opt Evicted Participant Was Room Host
            Timer->>Room: Elect Oldest Remaining Participant to Host
            Timer-.->Redis: Persist New Host Record
            Timer-->>Server: Broadcast 'role_assigned' & 'role_changed'
        end
    end
```

---

## Core Engineering Mechanisms

### Timeline Anchor Synchronization Engine

Continuous synchronization by polling and broadcasting video positions every few hundred milliseconds creates severe network traffic scaling as $O(N \cdot M)$ where $N$ is connected sockets and $M$ is update frequency.

This server implements **Deterministic Timeline Anchoring**:
1. When a playback action occurs (`play`, `pause`, or `seek`), the server anchors the state using two immutable variables:
   - `anchorPosition`: The playhead position in seconds.
   - `anchorServerTime`: The authoritative server epoch timestamp (in milliseconds) at the moment of execution.
2. The server broadcasts a single atomic packet:
   ```json
   {
     "currentTime": 42.5,
     "anchorPosition": 42.5,
     "anchorServerTime": 1730731200000,
     "sentAt": 1730731200002
   }
   ```
3. Any client or server process computes the current video position at any future millisecond $T_{now}$ deterministically:
   $$\text{Playhead}(T_{now}) = \text{anchorPosition} + \frac{T_{now} - \text{anchorServerTime}}{1000}$$
4. Network bandwidth consumption drops to zero during continuous playback. Position calculations remain sample-accurate across arbitrary durations.

### NTP Clock Offset Protocol

To ensure clients can interpret `anchorServerTime` without being affected by client OS clock drift, the server provides an atomic two-way NTP handshake:
1. Client sends `ntp_ping` with local timestamp $T_0$.
2. Server immediately returns `ntp_pong`:
   ```typescript
   socket.on('ntp_ping', ({ clientSendTime }) => {
     socket.emit('ntp_pong', {
       clientSendTime,
       serverTime: Date.now(),
     });
   });
   ```
3. This allows remote clients to calculate one-way network latency and compute an accurate clock offset relative to the server's internal clock.

### O(1) Delta Join Architecture

In a room with $N$ concurrent sockets, a naive join implementation broadcasts the full participant list and room state to all existing members whenever a new user connects. During a connection burst (e.g., 100 users joining within 5 seconds), this causes an $O(N^2)$ quadratic explosion:
$$\text{Total Objects Serialized} = \sum_{i=1}^{N} i = \frac{N(N+1)}{2} \approx 5,050 \text{ full state payloads}$$

The server eliminates this bottleneck:
1. **Unicast Snapshot to Joiner**: The joining client receives the full room state snapshot via a single directed emission:
   ```typescript
   socket.emit('sync_state', room.getState());
   ```
2. **O(1) Delta Broadcast to Room**: Existing participants are sent only an incremental delta object containing the single newly joined user:
   ```typescript
   socket.to(roomId).emit('user_joined', {
     username: participant.username,
     userId: participant.userId,
     role: participant.role,
     participant: {
       socketId: socket.id,
       userId: participant.userId,
       username: participant.username,
       role: participant.role,
       joinedAt: participant.joinedAt,
     }
   });
   ```
3. No redundant full-state re-serialization occurs. Join bursts scale linearly ($O(N)$).

### Asynchronous Non-Blocking Persistence

To sustain thousands of messages and reactions per second, real-time message routing is strictly decoupled from database persistence:
1. When a message is received, it is appended to the room's in-memory array and broadcast immediately:
   ```typescript
   const message = room.addMessage(socket.id, text.trim());
   io.to(roomId).emit('chat_message', message);
   ```
2. Persistence to Redis is dispatched asynchronously outside the event loop critical path:
   ```typescript
   saveMessages(roomId, message).catch((err) => {
     console.error('[Redis] Error saving message:', err.message);
   });
   ```
3. In Redis, the write executes as an atomic multi-exec pipeline that prepends the message, trims the list to 150 items, and updates the TTL:
   ```typescript
   await redis.multi()
     .lpush(`room:${roomId}:messages`, JSON.stringify(message))
     .ltrim(`room:${roomId}:messages`, 0, MAX_MESSAGES - 1)
     .expire(`room:${roomId}:messages`, CHAT_TTL)
     .exec();
   ```
4. If Redis experiences transient network latency or throttles requests, in-memory WebSocket broadcasts remain sub-millisecond and unaffected.

### Disconnection Grace Period & Token Recovery

Mobile devices and web browsers routinely cycle network interfaces, switch between cellular and Wi-Fi, or refresh the page. Immediate socket eviction causes role loss and noisy room alerts.

The server enforces an 8-second grace window:
1. When a socket disconnects, the server extracts `roomId` and `userId` and registers a delayed eviction task:
   ```typescript
   const disconnectKey = `${roomId}:${userId}`;
   const timer = setTimeout(() => {
     pendingDisconnects.delete(disconnectKey);
     // Eviction logic: remove participant, elect new host if needed, broadcast user_left
   }, 8000);
   pendingDisconnects.set(disconnectKey, timer);
   ```
2. If the user reconnects within 8000ms with their matching cryptographic session token, `clearTimeout(timer)` is called. The new socket adopts the existing participant record, preserving host and moderator privileges seamlessly.

### Role-Based Access Control (RBAC) & Request Pipeline

State mutations (`play`, `pause`, `seek`, `change_video`, `assign_role`, `remove_participant`, `transfer_host`) are intercepted by an internal permission gatekeeper:
```typescript
const PERMISSIONS: Record<string, Role[]> = {
  play: ['host', 'moderator'],
  pause: ['host', 'moderator'],
  seek: ['host', 'moderator'],
  change_video: ['host', 'moderator'],
  assign_role: ['host'],
  remove_participant: ['host'],
  transfer_host: ['host'],
};
```
- If an authorized user triggers an action, the mutation applies immediately.
- If a standard participant triggers a restricted action, the request is wrapped into an `ActionRequest` and routed to the room's Host and Moderators via `action_requested`.
- Authorized users review and resolve requests via `approve_action` or `deny_action`.

---

## Storage Strategy: Ephemeral Memory vs. Databases

A foundational architectural decision in `watch2gether-sockets` is the use of Redis as an ephemeral cache rather than a permanent relational database (PostgreSQL/MySQL):

### 1. Transient Watch Party Lifecycle
Watch parties are temporary real-time sessions. Users assemble, watch media together for 30 to 120 minutes, exchange high-frequency reactions and chat messages, and disband. Storing high-frequency chat messages, temporary socket IDs, and ephemeral participant rosters in a permanent relational database creates:
- Severe disk write amplification.
- Continuous B-tree index rebalancing.
- Table bloat and costly background vacuum/cleanup operations for data that has no utility after the room closes.

### 2. Automated Ephemeral Self-Pruning
Redis provides native key expiration (`EXPIRE`) and bounded list trimming (`LTRIM`):
- Chat history is capped at 150 messages per room using `ltrim(key, 0, 149)`.
- Room keys carry an automatic 24-hour TTL (`CHAT_TTL = 86400`).
- When a room is inactive, Redis reclaims memory automatically without manual database garbage collection scripts.

### 3. Clear Separation Between Room Runtime and Platform Store
The storage architecture strictly separates concerns:
- **Redis (This Service)**: Responsible for real-time room runtime state, transient chat logs, active roles, and live request queues.
- **Relational / Document Database (Platform Tier)**: Reserved for persistent platform entities: persistent user identity, authentication credentials, user profiles, saved video playlists, friend graphs, and aggregated historical telemetry (total parties hosted, total attendees, cumulative watch hours).

---

## Technology Stack & Design Choices

| Component | Technology | Technical Justification |
| :--- | :--- | :--- |
| **Runtime Engine** | Node.js (LTS) | Single-threaded non-blocking event loop ideal for asynchronous WebSocket connection multiplexing. |
| **Transport Layer** | Socket.IO 4.8 | Handles WebSocket transport negotiation, connection fallback, automatic heartbeat ping/pong, and isolated room broadcasting. |
| **HTTP Layer** | Express 4 | Minimal footprint for CORS preflight handling and service health checks. |
| **In-Memory Store** | Custom `RoomManager` | Zero-latency RAM heap lookup (`Map<string, Room>`) for active socket routing. |
| **Cache / Persistence**| Upstash Redis via `ioredis` | Sub-millisecond key-value storage with pipelining, multi/exec atomicity, and TLS connection pooling. |
| **Type System** | TypeScript 5.7 | Strict type enforcement across socket event payloads, eliminating property mismatch bugs. |

---

## Benchmark & Concurrency Performance

The socket server was benchmarked using a dedicated multi-socket load test harness running 100 concurrent clients across realistic room conditions and maximum stress flood conditions.

### Localhost Concurrency Benchmarks (Raw Engine Performance)

Tested locally on `http://localhost:4000` to evaluate raw engine throughput and event loop efficiency in the absence of trans-oceanic network latency.

#### Localhost Scenario A: Realistic Watch Party (100 Viewers, 10 Active Chatters)
- 100 concurrent connected sockets in a single room.
- 10 active chatters continuously transmitting messages (1 msg/sec each).
- Live reactions and typing indicator state changes active.

```
+-------------------------------------------------------------------------+
|                  FINAL BENCHMARK PERFORMANCE RESULTS                    |
+--------------------------------+----------------------------------------+
| Metric                         | Value                                  |
+--------------------------------+----------------------------------------+
| Simulated Room Viewers         | 100 concurrent clients                 |
| Successful Connections         | 100 / 100 (100%)                       |
| Connection Failures            | 0                                      |
| Messages Ingested by Server    | 190                                    |
| Broadcast Packets Delivered    | 19,000 packets                         |
| Sustained Delivered Throughput | 950.0 msg/sec                          |
| Reactions Processed            | 19                                     |
| Min Broadcast Latency          | 7 ms                                   |
| Average (Mean) Latency         | 49.4 ms                                |
| Median Latency (p50)           | 47 ms                                  |
| 95th Percentile Latency (p95)  | 95 ms                                  |
| 99th Percentile Latency (p99)  | 114 ms                                 |
| Max Latency                    | 126 ms                                 |
| Packet Loss / Error Count      | 0                                      |
+--------------------------------+----------------------------------------+
```

#### Localhost Scenario B: Maximum Stress Flood (100 Simultaneous Spammers)
- All 100 concurrent sockets transmitting messages simultaneously every second.
- Peak server broadcast volume driving thousands of deliveries per second.

```
+-------------------------------------------------------------------------+
|                  FINAL BENCHMARK PERFORMANCE RESULTS                    |
+--------------------------------+----------------------------------------+
| Metric                         | Value                                  |
+--------------------------------+----------------------------------------+
| Simulated Room Viewers         | 100 concurrent clients                 |
| Successful Connections         | 100 / 100 (100%)                       |
| Connection Failures            | 0                                      |
| Messages Ingested by Server    | 1,900                                  |
| Broadcast Packets Delivered    | 180,000 packets                        |
| Sustained Delivered Throughput | 9,500.0 msg/sec                        |
| Reactions Processed            | 19                                     |
| Min Broadcast Latency          | 6 ms                                   |
| Average (Mean) Latency         | 343.4 ms                               |
| Median Latency (p50)           | 347 ms                                 |
| 95th Percentile Latency (p95)  | 640 ms                                 |
| 99th Percentile Latency (p99)  | 728 ms                                 |
| Max Latency                    | 763 ms                                 |
| Packet Loss / Error Count      | 0                                      |
+--------------------------------+----------------------------------------+
```

---

### Remote Cloud Concurrency Benchmarks (Render Production Environment)

Tested against a deployed container on Render (`https://your-server.onrender.com`) communicating across a trans-continental link (India to North America datacenter, physical fiber transit RTT baseline of ~260ms).

#### Cloud Scenario A: Realistic Watch Party (100 Viewers, 10 Active Chatters)

```
+-------------------------------------------------------------------------+
| Metric                                 | Result                         |
+----------------------------------------+--------------------------------+
| Simulated Room Viewers                 | 100 concurrent users           |
| Connection Success Rate                | 100 / 100 (100%)               |
| Connection Failures                    | 0                              |
| Messages Ingested by Server            | 190                            |
| Broadcast Packets Delivered            | 19,000 packets                 |
| Sustained Delivered Throughput         | 950.0 msg/sec                  |
| Packet Delivery Reliability            | 100.0% (Zero dropped packets)  |
| Trans-Continental Baseline Latency     | 262 ms                         |
| Median Latency (p50)                   | 419 ms                         |
| Average (Mean) Latency                 | 447.8 ms                       |
| 95th Percentile Latency (p95)          | 696 ms                         |
| 99th Percentile Latency (p99)          | 860 ms                         |
| Maximum Recorded Latency               | 1,052 ms                       |
| Error Count                            | 0                              |
+-------------------------------------------------------------------------+
```

#### Cloud Scenario B: Maximum Stress Flood (100 Simultaneous Spammers)

```
+-------------------------------------------------------------------------+
| Metric                                 | Result                         |
+----------------------------------------+--------------------------------+
| Simulated Room Viewers                 | 100 concurrent users           |
| Connection Success Rate                | 100 / 100 (100%)               |
| Connection Failures                    | 0                              |
| Messages Ingested by Server            | 1,900                          |
| Broadcast Packets Delivered            | 67,365+ packets                |
| Peak Delivered Throughput              | 3,368.3 msg/sec                |
| Trans-Continental Baseline Latency     | 291 ms                         |
| Median Latency (p50)                   | 3,443 ms                       |
| Average (Mean) Latency                 | 4,272.1 ms                     |
| Error Count                            | 0                              |
+-------------------------------------------------------------------------+
```

---

### Architectural Optimization Progression

Comparison of metrics before and after the introduction of O(1) delta join broadcasting and asynchronous non-blocking Redis persistence:

| Metric | Prior Implementation | Optimized Implementation | Net Performance Gain |
| :--- | :--- | :--- | :--- |
| **Average Latency** | 1,754.4 ms | 447.8 ms | ~74% Reduction |
| **p95 Latency** | 7,535.0 ms | 696.0 ms | ~10.8x Faster |
| **p99 Latency** | 11,282.0 ms | 860.0 ms | ~13.1x Faster |
| **Max Latency** | 12,420.0 ms | 1,052.0 ms | ~11.8x Faster |
| **Delivery Reliability** | 97.9% | 100.0% | Zero Packet Loss |

---

## Socket API Specification

### Client-to-Server Events

| Event | Payload Signature | Description |
| :--- | :--- | :--- |
| `join_room` | `{ roomId, username, participantId, participantToken? }` | Authenticates and registers client into the specified room. |
| `ntp_ping` | `{ clientSendTime: number }` | Initiates clock skew calculation handshake. |
| `play` | `{ roomId, currentTime: number }` | Updates timeline anchor and broadcasts play command (Host/Mod). |
| `pause` | `{ roomId, currentTime: number }` | Freezes playhead at position and broadcasts pause command (Host/Mod). |
| `seek` | `{ roomId, time: number }` | Relocates timeline anchor to new offset and broadcasts seek (Host/Mod). |
| `playback_heartbeat` | `{ roomId, currentTime, isPlaying }` | Periodic authority state check from the host. |
| `change_video` | `{ roomId, videoId: string }` | Changes room media source and resets playhead to 0 (Host/Mod). |
| `request_action` | `{ roomId, type: string, payload: any }` | Submits an action request from viewer for host/mod approval. |
| `approve_action` | `{ roomId, requestId: string }` | Approves and executes a pending viewer request (Host/Mod). |
| `deny_action` | `{ roomId, requestId: string }` | Rejects a pending viewer request (Host/Mod). |
| `chat_message` | `{ roomId, text: string }` | Ingests chat message, dispatches room broadcast, triggers async Redis log. |
| `typing_start` | `{ roomId: string }` | Broadcasts active typing state to room peers. |
| `typing_stop` | `{ roomId: string }` | Broadcasts cessation of typing to room peers. |
| `reaction` | `{ roomId, emoji: string }` | Dispatches ephemeral animated reaction event to room. |
| `assign_role` | `{ roomId, userId, role: Role }` | Promotes or demotes participant privileges (Host only). |
| `remove_participant`| `{ roomId, userId: string }` | Immediately kicks user from room and revokes roles (Host only). |
| `transfer_host` | `{ roomId, targetUserId: string }` | Steps down caller and transfers host ownership (Host only). |
| `update_username` | `{ roomId, username: string }` | Renames participant and syncs across room roster. |
| `leave_room` | `{ roomId: string }` | Explicit client leave triggering immediate teardown. |

### Server-to-Client Events

| Event | Payload Signature | Description |
| :--- | :--- | :--- |
| `sync_state` | `RoomState` object | Complete snapshot of room (timeline, roster, messages, host) sent to joiner. |
| `user_joined` | `{ userId, username, role, participant }` | Lightweight delta notifying peers of a new participant. |
| `user_left` | `{ userId, username, participants, hostSocketId }` | Notification of participant departure after grace period expiry. |
| `play` | `{ currentTime, anchorPosition, anchorServerTime, sentAt }` | Playback command with authoritative server timeline anchors. |
| `pause` | `{ currentTime, anchorPosition, anchorServerTime, sentAt }` | Pause command with playhead freeze anchor. |
| `seek` | `{ time, anchorPosition, anchorServerTime, sentAt }` | Seek command with relocated playhead anchor. |
| `change_video` | `{ videoId: string }` | Notification of video change. |
| `chat_message` | `ChatMessage` object | Broadcast of formatted chat entry to room participants. |
| `user_typing` | `{ userId, username, isTyping: boolean }` | Real-time typing status of peers. |
| `reaction` | `{ id, emoji, userId, username }` | Ephemeral reaction event for UI display. |
| `action_requested` | `ActionRequest` object | Direct notification to Hosts/Moderators when viewer requests action. |
| `action_resolved` | `{ requestId: string }` | Informs room that pending request has been processed. |
| `role_assigned` | `{ userId, username, role, participants, hostSocketId }`| Broadcast of roster role updates. |
| `kicked` | `{ message: string }` | Directed kick notification sent to ejected socket before disconnect. |
| `error_message` | `{ message: string }` | Permission rejection or validation failure notification. |

---

## Codebase Structure

```
watch2gether-sockets/
├── src/
│   ├── config/
│   │   ├── redis.ts               # Upstash Redis ioredis client configuration
│   │   └── storage/
│   │       ├── chat.ts            # Bounded chat persistence (LPUSH, LTRIM, EXPIRE)
│   │       ├── requests.ts        # Video request queue storage & resolution
│   │       ├── role.ts            # Persistent host & role assignments
│   │       └── participant/
│   │           └── participant.ts # Cryptographic participant session token verification
│   ├── models/
│   │   ├── Participant.ts         # In-memory participant entity model
│   │   ├── Room.ts                # In-memory room state entity & math calculations
│   │   └── RoomManager.ts         # Singleton registry managing active room instances
│   ├── utils/
│   │   └── youtubeValidator.ts    # Canonical YouTube URL validation & ID parser
│   ├── server.ts                  # Main Express & Socket.IO initialization & event handlers
│   └── types.ts                   # Authoritative TypeScript event contracts & data models
├── package.json
└── tsconfig.json
```

---

## Configuration & Environment Variables

Create a `.env` file in the root directory:

```env
# Server port
PORT=4000

# Client origin permitted for Cross-Origin Resource Sharing (CORS)
CLIENT_URL=https://your-frontend-domain.com

# Upstash / Redis Connection URL (Requires TLS)
REDIS_URL=rediss://default:your-token@your-redis-instance.upstash.io:6379

# Maximum message backlog persisted in Redis per room
MAX_MESSAGES=150

# Chat retention Time-To-Live in seconds (Default: 24 Hours)
CHAT_TTL=86400
```

---

## Local Development & Deployment

### Prerequisites

- Node.js 18.x or later
- An active Redis instance (local server or Upstash cloud instance)
- npm or pnpm

### 1. Installation

```bash
git clone https://github.com/your-username/watch2gether-sockets.git
cd watch2gether-sockets
npm install
```

### 2. Running Locally

```bash
# Start server with hot-reload via tsx
npm run dev

# Compile TypeScript to JavaScript (dist/)
npm run build

# Run production build
npm run start:dist
```

### 3. Deploying to Production (Render / Docker)

The service is pre-configured for containerized deployment:
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm run start` or `npm run start:dist`
- **Health Check Path**: `/` (returns HTTP 200)
- **Auto-Deploy**: Connect the repository to Render as a Web Service.

