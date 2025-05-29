const express = require("express")
const https = require("https")
const http = require("http")
const socketIo = require("socket.io")
const fs = require("fs")
const path = require("path")
const cors = require("cors")
const { log } = require("console")

// Create HTTPS server with self-signed certificate for development

const app = express()

// Check if HTTPS should be used based on environment variable
const useHTTPS = process.env.USE_HTTPS === "true"  // Only true when explicitly set in the .env

let server
const certPath = path.join(__dirname, "localhost.pem")
const keyPath = path.join(__dirname, "localhost-key.pem")


// Generate and use self-signed certificate only if needed
let httpsOptions = {}

if (useHTTPS) {
  // Check if certs already exist
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    // Use existing certs
    httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }
  } else {
    // Generate new certs with self-signed
    const selfsigned = require("selfsigned")
    const attrs = [
      { name: "commonName", value: "localhost" },
      { name: "subjectAltName", value: "DNS:localhost,IP:127.0.0.1,IP:0.0.0.0" },
    ]
    const pems = selfsigned.generate(attrs, {
      days: 365,
      keySize: 2048,
      extensions: [
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
            { type: 7, ip: "0.0.0.0" },
            { type: 2, value: "*.local" },
          ],
        },
      ],
    })

    // Write certs to disk for future use
    fs.writeFileSync(certPath, pems.cert)
    fs.writeFileSync(keyPath, pems.private)

    httpsOptions = {
      key: pems.private,
      cert: pems.cert,
    }
  }

  // Create HTTPS server with the generated or existing cert
  server = https.createServer(httpsOptions, app)
  console.log("🔒 HTTPS server enabled with enhanced certificate")
} else {
  // Create HTTP server if HTTPS is not enabled
  server = http.createServer(app)
  console.log("🔓 HTTP server enabled")
}

// Set up Socket.IO with mobile support, enhanced for HTTPS
const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins for local dev
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: false,
    allowedHeaders: ["*"],
  },
  allowEIO3: true,
  transports: ["polling", "websocket"],
  maxHttpBufferSize: 1e8,
  pingTimeout: 120000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  httpCompression: true,
  perMessageDeflate: true,
})

// Set up CORS middleware for Express app
app.use(
  cors({
    origin: "*", // Allow all origins for local dev
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["*"],
  })
)

// Handle preflight requests for CORS
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  res.header("Access-Control-Allow-Headers", "*")
  res.sendStatus(200)
})

// Example of a route to test
app.get("/", (req, res) => {
  res.send("Hello, world!")
})


// Client-side connection logic (for reference)
// const socket = io("https://localhost:3001", {
//   transports: ["websocket", "polling"],
//   secure: useHTTPS, // HTTPS connection when useHTTPS is true
//   rejectUnauthorized: false, // Trust self-signed certs for local dev
// })


// Enhanced middleware for mobile support
app.use(
  cors({
    origin: "*",
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["*"],
  }),
)

// Handle preflight requests
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  res.header("Access-Control-Allow-Headers", "*")
  res.sendStatus(200)
})

app.use(express.json({ limit: "50mb" }))
app.use(express.static("public"))

// Create recordings directory if it doesn't exist
const recordingsDir = path.join(__dirname, "recordings")
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true })
}

// In-memory storage for rooms and recordings
const rooms = new Map()
const userSockets = new Map()

// Room data structure - ENHANCED for separate user recordings
class Room {
  constructor(id) {
    this.id = id
    this.users = new Map() // Changed to Map for better user management
    this.isRecording = false
    this.recordingStartTime = null
    this.recordingSession = null // Will store session info
    this.userRecordings = new Map() // Separate recordings per user
    this.lastActivity = Date.now()
  }

  addUser(userId, socketId) {
    this.users.set(userId, { userId, socketId, joinedAt: Date.now() })
    this.lastActivity = Date.now()
    console.log(`👥 Room ${this.id}: Added user ${userId}. Total users: ${this.users.size}`)
  }

  removeUser(userId) {
    const removed = this.users.delete(userId)
    this.lastActivity = Date.now()
    if (removed) {
      console.log(`👥 Room ${this.id}: Removed user ${userId}. Total users: ${this.users.size}`)

      // Stop individual recording for this user if recording is active
      if (this.isRecording && this.userRecordings.has(userId)) {
        this.stopUserRecording(userId)
      }
    }
    return removed
  }

  getUserCount() {
    return this.users.size
  }

  getUsers() {
    return Array.from(this.users.values())
  }

  hasUser(userId) {
    return this.users.has(userId)
  }

  updateActivity() {
    this.lastActivity = Date.now()
  }

  getUserBySocketId(socketId) {
    for (const user of this.users.values()) {
      if (user.socketId === socketId) {
        return user
      }
    }
    return null
  }

  // Start recording session for all users
  startRecordingSession() {
    this.isRecording = true
    this.recordingStartTime = new Date()

    const timestamp = this.recordingStartTime.toISOString().replace(/[:.]/g, "-")
    this.recordingSession = {
      id: `session-${this.id}-${timestamp}`,
      startTime: this.recordingStartTime,
      timestamp: timestamp,
      users: Array.from(this.users.keys()),
    }

    // Initialize recording for each user currently in the room
    this.users.forEach((user, userId) => {
      this.startUserRecording(userId)
    })

    console.log(`🎙️ Started recording session: ${this.recordingSession.id}`)
    return this.recordingSession
  }

  // Start recording for a specific user
  startUserRecording(userId) {
    if (!this.isRecording || this.userRecordings.has(userId)) {
      return false
    }

    const userRecording = {
      userId: userId,
      chunks: [],
      startTime: Date.now(),
      filePath: path.join(recordingsDir, `${this.recordingSession.id}-user-${userId}.webm`),
      stream: null,
    }

    try {
      userRecording.stream = fs.createWriteStream(userRecording.filePath)
      this.userRecordings.set(userId, userRecording)
      console.log(`🎤 Started recording for user ${userId}: ${userRecording.filePath}`)
      return true
    } catch (error) {
      console.error(`❌ Error starting recording for user ${userId}:`, error)
      return false
    }
  }

  // Stop recording for a specific user
  stopUserRecording(userId) {
    const userRecording = this.userRecordings.get(userId)
    if (!userRecording) {
      return null
    }

    // Close the write stream
    if (userRecording.stream) {
      userRecording.stream.end()
      userRecording.stream = null
    }

    // Combine chunks and save final file
    if (userRecording.chunks.length > 0) {
      try {
        const sortedChunks = userRecording.chunks.sort((a, b) => (a.index || 0) - (b.index || 0))
        const combinedBuffer = Buffer.concat(sortedChunks.map((chunk) => chunk.data))

        // Write final file if stream didn't capture everything
        if (!fs.existsSync(userRecording.filePath) || fs.statSync(userRecording.filePath).size === 0) {
          fs.writeFileSync(userRecording.filePath, combinedBuffer)
        }

        console.log(
          `💾 Saved recording for user ${userId}: ${userRecording.filePath} (${combinedBuffer.length} bytes, ${userRecording.chunks.length} chunks)`,
        )

        const result = {
          userId: userId,
          filePath: userRecording.filePath,
          filename: path.basename(userRecording.filePath),
          size: combinedBuffer.length,
          chunks: userRecording.chunks.length,
          duration: Date.now() - userRecording.startTime,
          base64: combinedBuffer.toString("base64"),
        }

        this.userRecordings.delete(userId)
        return result
      } catch (error) {
        console.error(`❌ Error saving recording for user ${userId}:`, error)
        this.userRecordings.delete(userId)
        return null
      }
    } else {
      console.log(`⚠️ No audio chunks for user ${userId}`)
      this.userRecordings.delete(userId)
      return null
    }
  }

  // Stop entire recording session
  stopRecordingSession() {
    if (!this.isRecording) {
      return { success: false, error: "No recording in progress" }
    }

    this.isRecording = false
    const results = []

    // Stop recording for all users
    this.userRecordings.forEach((recording, userId) => {
      const result = this.stopUserRecording(userId)
      if (result) {
        results.push(result)
      }
    })

    // Create session summary
    const sessionSummary = {
      sessionId: this.recordingSession.id,
      roomId: this.id,
      startTime: this.recordingSession.startTime,
      endTime: new Date(),
      duration: Date.now() - this.recordingSession.startTime,
      userRecordings: results,
      totalFiles: results.length,
      totalSize: results.reduce((sum, r) => sum + r.size, 0),
    }

    // Save session summary
    const summaryPath = path.join(recordingsDir, `${this.recordingSession.id}-summary.json`)
    try {
      fs.writeFileSync(summaryPath, JSON.stringify(sessionSummary, null, 2))
      console.log(`📋 Saved session summary: ${summaryPath}`)
    } catch (error) {
      console.error(`❌ Error saving session summary:`, error)
    }

    console.log(`⏹️ Stopped recording session: ${this.recordingSession.id}`)
    console.log(`📊 Session results: ${results.length} user recordings, ${sessionSummary.totalSize} total bytes`)

    this.recordingSession = null
    return { success: true, session: sessionSummary, userRecordings: results }
  }

  // Add audio chunk for a specific user
  addUserAudioChunk(userId, audioData, chunkIndex) {
    const userRecording = this.userRecordings.get(userId)
    if (!userRecording) {
      // If user joined during recording, start their recording
      if (this.isRecording && this.users.has(userId)) {
        this.startUserRecording(userId)
        return this.addUserAudioChunk(userId, audioData, chunkIndex) // Retry
      }
      return false
    }

    try {
      const buffer = Buffer.from(audioData, "base64")

      // Store in memory
      userRecording.chunks.push({
        data: buffer,
        timestamp: Date.now(),
        index: chunkIndex || userRecording.chunks.length,
      })

      // Write to file stream
      if (userRecording.stream && userRecording.stream.writable) {
        userRecording.stream.write(buffer)
      }

      console.log(
        `🎵 Added audio chunk for user ${userId}: ${buffer.length} bytes (Total chunks: ${userRecording.chunks.length})`,
      )
      return true
    } catch (error) {
      console.error(`❌ Error adding audio chunk for user ${userId}:`, error)
      return false
    }
  }

  // Get current recording data for a user
  getUserRecordingData(userId) {
    const userRecording = this.userRecordings.get(userId)
    if (!userRecording || userRecording.chunks.length === 0) {
      return null
    }

    try {
      const sortedChunks = userRecording.chunks.sort((a, b) => (a.index || 0) - (b.index || 0))
      const combinedBuffer = Buffer.concat(sortedChunks.map((chunk) => chunk.data))

      return {
        userId: userId,
        audioData: combinedBuffer.toString("base64"),
        size: combinedBuffer.length,
        chunks: userRecording.chunks.length,
        mimeType: "audio/webm",
      }
    } catch (error) {
      console.error(`❌ Error getting recording data for user ${userId}:`, error)
      return null
    }
  }

  // Get recording status
  getRecordingStatus() {
    return {
      isRecording: this.isRecording,
      session: this.recordingSession,
      activeRecordings: Array.from(this.userRecordings.keys()),
      userRecordingStats: Array.from(this.userRecordings.entries()).map(([userId, recording]) => ({
        userId,
        chunks: recording.chunks.length,
        size: recording.chunks.reduce((sum, chunk) => sum + chunk.data.length, 0),
      })),
    }
  }
}

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id} from ${socket.handshake.address}`)

  // Enhanced connection handling
  socket.on("connect_error", (error) => {
    console.error("❌ Socket connection error:", error)
  })

  // Join room - FIXED VERSION
  socket.on("join-room", (data) => {
    const { roomId, userId } = data
    console.log(`🚪 User ${userId} attempting to join room ${roomId}`)

    // Validate input
    if (!roomId || !userId) {
      socket.emit("room-join-error", { error: "Missing roomId or userId" })
      return
    }

    // Check if user is already in a room
    const existingUserInfo = userSockets.get(socket.id)
    if (existingUserInfo) {
      console.log(`⚠️ User ${userId} already in room ${existingUserInfo.roomId}, leaving first`)
      // Leave existing room first
      socket.leave(existingUserInfo.roomId)
      if (rooms.has(existingUserInfo.roomId)) {
        rooms.get(existingUserInfo.roomId).removeUser(existingUserInfo.userId)
      }
    }

    // Create room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Room(roomId))
      console.log(`🆕 Created new room: ${roomId}`)
    }

    const room = rooms.get(roomId)

    // Add user to room
    room.addUser(userId, socket.id)
    userSockets.set(socket.id, { userId, roomId })

    // Join socket room
    socket.join(roomId)

    // Get other users in the room (excluding the joining user)
    const otherUsers = room.getUsers().filter((user) => user.userId !== userId)

    console.log(`📢 Notifying ${otherUsers.length} existing users about new user ${userId}`)

    // Notify OTHER users in the room about the new user
    socket.to(roomId).emit("user-joined", {
      userId,
      socketId: socket.id,
      timestamp: Date.now(),
    })

    // Send current room state to the JOINING user
    socket.emit("room-joined", {
      success: true,
      roomId,
      userId,
      users: otherUsers, // Send list of other users
      isRecording: room.isRecording,
      totalUsers: room.getUserCount(),
      timestamp: Date.now(),
    })

    console.log(`✅ User ${userId} joined room ${roomId}. Total users: ${room.getUserCount()}`)
    console.log(
      `📋 Room ${roomId} users:`,
      room.getUsers().map((u) => u.userId),
    )

    // Broadcast updated room info to all users
    io.to(roomId).emit("room-updated", {
      roomId,
      totalUsers: room.getUserCount(),
      users: room.getUsers(),
    })
  })

  // Leave room - IMPROVED VERSION
  socket.on("leave-room", (data) => {
    const { roomId, userId } = data
    console.log(`🚪 User ${userId} leaving room ${roomId}`)

    if (rooms.has(roomId)) {
      const room = rooms.get(roomId)
      const removed = room.removeUser(userId)

      if (removed) {
        // Notify other users
        socket.to(roomId).emit("user-left", {
          userId,
          timestamp: Date.now(),
          remainingUsers: room.getUserCount(),
        })

        // Broadcast updated room info
        io.to(roomId).emit("room-updated", {
          roomId,
          totalUsers: room.getUserCount(),
          users: room.getUsers(),
        })
      }

      // Clean up empty rooms
      if (room.getUserCount() === 0) {
        if (room.isRecording) {
          console.log(`⏹️ Stopping recording for empty room ${roomId}`)
          const recordingData = stopRoomRecording(roomId)
          if (recordingData.size > 0) {
            console.log(`💾 Final recording saved: ${recordingData.filename} (${recordingData.size} bytes)`)
          }
        }
        rooms.delete(roomId)
        console.log(`🗑️ Room ${roomId} deleted (empty)`)
      }
    }

    socket.leave(roomId)
    userSockets.delete(socket.id)
  })

  // Start recording - UPDATED
  socket.on("start-recording", (data) => {
    const { roomId } = data
    console.log(`🎙️ Start recording request for room ${roomId}`)

    if (rooms.has(roomId)) {
      const room = rooms.get(roomId)

      if (!room.isRecording) {
        const session = room.startRecordingSession()

        // Notify all users in the room
        io.to(roomId).emit("recording-started", {
          roomId,
          sessionId: session.id,
          timestamp: session.startTime,
        })

        socket.emit("recording-start-response", {
          success: true,
          sessionId: session.id,
          message: `Started recording session for ${room.getUserCount()} users`,
        })
        console.log(`✅ Recording started for room ${roomId}, session: ${session.id}`)
      } else {
        socket.emit("recording-start-response", {
          success: false,
          error: "Recording already in progress",
        })
      }
    } else {
      socket.emit("recording-start-response", {
        success: false,
        error: "Room not found",
      })
    }
  })

  // Stop recording - UPDATED
  socket.on("stop-recording", (data) => {
    const { roomId } = data
    console.log(`⏹️ Stop recording request for room ${roomId}`)

    if (rooms.has(roomId)) {
      const room = rooms.get(roomId)

      if (room.isRecording) {
        const result = room.stopRecordingSession()

        if (result.success) {
          // Notify all users in the room
          io.to(roomId).emit("recording-stopped", {
            roomId,
            sessionId: result.session.sessionId,
            userRecordings: result.userRecordings.map((r) => ({
              userId: r.userId,
              filename: r.filename,
              size: r.size,
              chunks: r.chunks,
            })),
            totalFiles: result.session.totalFiles,
            totalSize: result.session.totalSize,
          })

          socket.emit("recording-stop-response", {
            success: true,
            session: result.session,
            userRecordings: result.userRecordings,
            message: `Stopped recording session. Created ${result.userRecordings.length} individual recordings.`,
          })

          console.log(`✅ Recording stopped for room ${roomId}. Created ${result.userRecordings.length} files.`)
        } else {
          socket.emit("recording-stop-response", result)
        }
      } else {
        socket.emit("recording-stop-response", {
          success: false,
          error: "No recording in progress",
        })
      }
    } else {
      socket.emit("recording-stop-response", {
        success: false,
        error: "Room not found",
      })
    }
  })

  // Receive audio chunk - UPDATED for user-specific recording
  socket.on("audio-chunk", (data) => {
    const { roomId, audioData, chunkIndex } = data
    const userInfo = userSockets.get(socket.id)

    if (!userInfo) {
      socket.emit("audio-chunk-received", {
        success: false,
        error: "User not found in room",
      })
      return
    }

    const { userId } = userInfo

    if (rooms.has(roomId)) {
      const room = rooms.get(roomId)
      room.updateActivity()

      if (room.isRecording && audioData) {
        const success = room.addUserAudioChunk(userId, audioData, chunkIndex)

        if (success) {
          const userRecording = room.userRecordings.get(userId)
          socket.emit("audio-chunk-received", {
            success: true,
            chunkIndex: chunkIndex || (userRecording ? userRecording.chunks.length - 1 : 0),
            totalChunks: userRecording ? userRecording.chunks.length : 0,
            userId: userId,
          })

          // Broadcast to other users for real-time audio (unchanged)
          socket.to(roomId).emit("audio-data", {
            userId: userId,
            audioData,
          })
        } else {
          socket.emit("audio-chunk-received", {
            success: false,
            error: "Failed to add audio chunk",
            userId: userId,
          })
        }
      } else {
        if (!room.isRecording) {
          socket.emit("audio-chunk-received", {
            success: false,
            error: "Recording not active",
          })
        }
      }
    }
  })

  // Get current recording - UPDATED for user-specific data
  socket.on("get-recording", (data) => {
    const { roomId, userId: requestedUserId } = data
    const userInfo = userSockets.get(socket.id)

    if (!userInfo) {
      socket.emit("get-recording-response", { success: false, error: "User not found" })
      return
    }

    const { userId } = userInfo
    const targetUserId = requestedUserId || userId // Default to requesting user's own recording

    console.log(`📥 Get recording request for room ${roomId}, user ${targetUserId}`)

    if (rooms.has(roomId)) {
      const room = rooms.get(roomId)
      const recordingData = room.getUserRecordingData(targetUserId)

      if (recordingData) {
        socket.emit("get-recording-response", {
          success: true,
          ...recordingData,
          message: `Recording data for user ${targetUserId}`,
        })
        console.log(`📤 Sent recording data for user ${targetUserId} (${recordingData.size} bytes)`)
      } else {
        socket.emit("get-recording-response", {
          success: true,
          audioData: null,
          size: 0,
          chunks: 0,
          userId: targetUserId,
          mimeType: "audio/webm",
          message: `No recording data for user ${targetUserId}`,
        })
      }
    } else {
      socket.emit("get-recording-response", { success: false, error: "Room not found" })
    }
  })

  // New endpoint: Get recording status
  socket.on("get-recording-status", (data) => {
    const { roomId } = data

    if (rooms.has(roomId)) {
      const room = rooms.get(roomId)
      const status = room.getRecordingStatus()

      socket.emit("recording-status-response", {
        success: true,
        roomId,
        ...status,
      })
    } else {
      socket.emit("recording-status-response", {
        success: false,
        error: "Room not found",
      })
    }
  })

  // WebRTC signaling - IMPROVED LOGGING
  socket.on("webrtc-offer", (data) => {
    const { roomId, targetUserId, offer } = data
    const fromUserId = userSockets.get(socket.id)?.userId
    console.log(`🤝 WebRTC offer from ${fromUserId} to ${targetUserId} in room ${roomId}`)

    // Broadcast to specific user in room
    socket.to(roomId).emit("webrtc-offer", {
      fromUserId,
      targetUserId,
      offer,
    })
  })

  socket.on("webrtc-answer", (data) => {
    const { roomId, targetUserId, answer } = data
    const fromUserId = userSockets.get(socket.id)?.userId
    console.log(`🤝 WebRTC answer from ${fromUserId} to ${targetUserId} in room ${roomId}`)

    socket.to(roomId).emit("webrtc-answer", {
      fromUserId,
      targetUserId,
      answer,
    })
  })

  socket.on("webrtc-ice-candidate", (data) => {
    const { roomId, targetUserId, candidate } = data
    const fromUserId = userSockets.get(socket.id)?.userId
    console.log(`🧊 ICE candidate from ${fromUserId} to ${targetUserId} in room ${roomId}`)

    socket.to(roomId).emit("webrtc-ice-candidate", {
      fromUserId,
      targetUserId,
      candidate,
    })
  })

  // Handle disconnect - IMPROVED VERSION
  socket.on("disconnect", (reason) => {
    console.log(`❌ User disconnected: ${socket.id}, reason: ${reason}`)

    const userInfo = userSockets.get(socket.id)

    if (userInfo) {
      const { userId, roomId } = userInfo

      if (rooms.has(roomId)) {
        const room = rooms.get(roomId)
        const removed = room.removeUser(userId)

        if (removed) {
          // Notify other users
          socket.to(roomId).emit("user-left", {
            userId,
            reason: "disconnect",
            timestamp: Date.now(),
          })

          // Broadcast updated room info
          io.to(roomId).emit("room-updated", {
            roomId,
            totalUsers: room.getUserCount(),
            users: room.getUsers(),
          })
        }

        // Clean up empty rooms
        if (room.getUserCount() === 0) {
          if (room.isRecording) {
            console.log(`⏹️ Stopping recording for empty room ${roomId} after disconnect`)
            const recordingData = stopRoomRecording(roomId)
            if (recordingData.size > 0) {
              console.log(`💾 Final recording saved: ${recordingData.filename} (${recordingData.size} bytes)`)
            }
          }
          rooms.delete(roomId)
          console.log(`🗑️ Room ${roomId} deleted (empty after disconnect)`)
        }
      }

      userSockets.delete(socket.id)
    }
  })

  // Debug endpoint to get room info
  socket.on("get-room-info", (data) => {
    const { roomId } = data
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId)
      socket.emit("room-info-response", {
        roomId,
        users: room.getUsers(),
        totalUsers: room.getUserCount(),
        isRecording: room.isRecording,
      })
    } else {
      socket.emit("room-info-response", { error: "Room not found" })
    }
  })
})

// Helper function to stop room recording
function stopRoomRecording(roomId) {
  const room = rooms.get(roomId)

  if (room && room.isRecording) {
    room.isRecording = false

    // Close the write stream
    if (room.recordingStream) {
      room.recordingStream.end()
      room.recordingStream = null
    }

    console.log(`⏹️ Stopping recording for room ${roomId}. Total chunks: ${room.recordingChunks.length}`)

    if (room.recordingChunks.length > 0) {
      // Sort chunks by index and combine
      const sortedChunks = room.recordingChunks.sort((a, b) => (a.index || 0) - (b.index || 0))
      const combinedBuffer = Buffer.concat(sortedChunks.map((chunk) => chunk.data))

      // Save to file if not already saved via stream
      try {
        if (!fs.existsSync(room.recordingFilePath) || fs.statSync(room.recordingFilePath).size === 0) {
          fs.writeFileSync(room.recordingFilePath, combinedBuffer)
        }
        console.log(`💾 Recording saved: ${room.recordingFilePath} (${combinedBuffer.length} bytes)`)
      } catch (error) {
        console.error(`❌ Error saving recording file: ${error}`)
      }

      // Convert to base64 for client download
      const base64Audio = combinedBuffer.toString("base64")
      const filename = path.basename(room.recordingFilePath)

      return {
        base64: base64Audio,
        size: combinedBuffer.length,
        filename: filename,
        filePath: room.recordingFilePath,
      }
    } else {
      console.log(`⚠️ No audio chunks to save for room ${roomId}`)
    }
  }

  return {
    base64: null,
    size: 0,
    filename: null,
    filePath: null,
  }
}

// REST API endpoints
app.get("/api/rooms", (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    userCount: room.getUserCount(),
    users: room.getUsers(),
    isRecording: room.isRecording,
    recordingChunks: room.recordingChunks.length,
    lastActivity: room.lastActivity,
  }))

  res.json({ rooms: roomList })
})

// Get recordings by session
app.get("/api/recordings/session/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId

  try {
    const summaryPath = path.join(recordingsDir, `${sessionId}-summary.json`)

    if (fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"))

      // Check if all user recording files exist
      const userRecordings = summary.userRecordings.map((recording) => {
        const exists = fs.existsSync(recording.filePath)
        return {
          ...recording,
          exists,
          downloadUrl: exists ? `/api/recordings/${recording.filename}` : null,
        }
      })

      res.json({
        session: summary,
        userRecordings,
        totalFiles: userRecordings.filter((r) => r.exists).length,
      })
    } else {
      res.status(404).json({ error: "Session not found" })
    }
  } catch (error) {
    console.error("❌ Error getting session recordings:", error)
    res.status(500).json({ error: "Failed to get session recordings" })
  }
})

// Get all recording sessions
app.get("/api/recordings/sessions", (req, res) => {
  try {
    const files = fs.readdirSync(recordingsDir)
    const summaryFiles = files.filter((file) => file.endsWith("-summary.json"))

    const sessions = summaryFiles
      .map((file) => {
        try {
          const filePath = path.join(recordingsDir, file)
          const summary = JSON.parse(fs.readFileSync(filePath, "utf8"))
          const stats = fs.statSync(filePath)

          return {
            sessionId: summary.sessionId,
            roomId: summary.roomId,
            startTime: summary.startTime,
            endTime: summary.endTime,
            duration: summary.duration,
            totalFiles: summary.totalFiles,
            totalSize: summary.totalSize,
            userCount: summary.userRecordings.length,
            created: stats.birthtime,
            summaryFile: file,
          }
        } catch (error) {
          console.error(`Error reading summary file ${file}:`, error)
          return null
        }
      })
      .filter((session) => session !== null)
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))

    res.json({ sessions })
  } catch (error) {
    console.error("❌ Error listing recording sessions:", error)
    res.status(500).json({ error: "Failed to list recording sessions" })
  }
})

// Download all recordings from a session as ZIP
app.get("/api/recordings/session/:sessionId/download", (req, res) => {
  const sessionId = req.params.sessionId

  try {
    const summaryPath = path.join(recordingsDir, `${sessionId}-summary.json`)

    if (!fs.existsSync(summaryPath)) {
      return res.status(404).json({ error: "Session not found" })
    }

    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"))

    // For now, just return the summary. In a full implementation,
    // you'd want to create a ZIP file with all recordings
    res.json({
      message: "ZIP download would be implemented here",
      session: summary,
      files: summary.userRecordings.map((r) => r.filename),
    })
  } catch (error) {
    console.error("❌ Error creating session download:", error)
    res.status(500).json({ error: "Failed to create session download" })
  }
})

app.get("/api/recordings", (req, res) => {
  try {
    const files = fs
      .readdirSync(recordingsDir)
      .filter((file) => file.endsWith(".webm"))
      .map((file) => {
        const filePath = path.join(recordingsDir, file)
        const stats = fs.statSync(filePath)
        return {
          filename: file,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime,
        }
      })
      .sort((a, b) => b.created - a.created)

    res.json({ recordings: files })
  } catch (error) {
    console.error("❌ Error listing recordings:", error)
    res.status(500).json({ error: "Failed to list recordings" })
  }
})

app.get("/api/recordings/:filename", (req, res) => {
  const filename = req.params.filename
  const filePath = path.join(recordingsDir, filename)

  if (fs.existsSync(filePath)) {
    res.download(filePath)
  } else {
    res.status(404).json({ error: "Recording not found" })
  }
})

app.delete("/api/recordings/:filename", (req, res) => {
  const filename = req.params.filename
  const filePath = path.join(recordingsDir, filename)

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      res.json({ success: true, message: "Recording deleted" })
    } else {
      res.status(404).json({ error: "Recording not found" })
    }
  } catch (error) {
    console.error("❌ Error deleting recording:", error)
    res.status(500).json({ error: "Failed to delete recording" })
  }
})

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    totalConnections: userSockets.size,
    recordingsDirectory: recordingsDir,
    protocol: useHTTPS ? "https" : "http",
    rooms: Array.from(rooms.entries()).map(([id, room]) => ({
      id,
      users: room.getUserCount(),
      recording: room.isRecording,
    })),
  })
})

// Test endpoint
app.get("/test", (req, res) => {
  res.json({
    message: "Server is running!",
    timestamp: new Date().toISOString(),
    port: process.env.PORT || 3001,
    protocol: useHTTPS ? "https" : "http",
    userAgent: req.headers["user-agent"],
    ip: req.ip || req.connection.remoteAddress,
  })
})

// Get network interfaces for mobile connection info
function getNetworkInterfaces() {
  const os = require("os")
  const networkInt = os.networkInterfaces()
  const addresses = []

  for (const name of Object.keys(networkInt)) {
    for (const interface of networkInt[name]) {
      if (interface.family === "IPv4" && !interface.internal) {
        addresses.push({
          name,
          address: interface.address,
          url: `${useHTTPS ? "https" : "http"}://${interface.address}:${PORT}`,
        })
      }
    }
  }

  return addresses
}

const PORT = process.env.PORT || 3001

server.listen(PORT, "0.0.0.0", () => {
  const protocol = useHTTPS ? "https" : "http"
  console.log(`🚀 Voice chat server running on ${protocol}://localhost:${PORT}`)
  console.log(`📁 Recordings will be saved to: ${recordingsDir}`)
  console.log(`🏥 Health check available at: ${protocol}://localhost:${PORT}/health`)
  console.log(`🧪 Test endpoint available at: ${protocol}://localhost:${PORT}/test`)
  console.log(`📊 API endpoints available at: ${protocol}://localhost:${PORT}/api/rooms`)

  if (useHTTPS) {
    console.log(`🔒 HTTPS enabled with enhanced self-signed certificate`)
    console.log(`📱 Mobile devices can connect using these URLs:`)

    const networkInterfaces = getNetworkInterfaces()
    networkInterfaces.forEach((iface) => {
      console.log(`   📱 ${iface.name}: ${iface.url}`)
    })
  } else {
    console.log(`🔓 HTTP mode - for HTTPS, set USE_HTTPS=true`)
  }
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully")
  server.close(() => {
    console.log("Server closed")
    process.exit(0)
  })
})

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully")
  server.close(() => {
    console.log("Server closed")
    process.exit(0)
  })
})
