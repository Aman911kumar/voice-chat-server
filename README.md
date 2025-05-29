# Voice Chat Server

A real-time voice chat server with recording capabilities built with Node.js, Socket.io, and WebRTC.

## Features

- Real-time voice communication using WebRTC
- Server-side audio recording
- Room-based chat system
- File management for recordings
- RESTful API for room and recording management
- Docker support for easy deployment

## Installation

### Prerequisites

- Node.js 16 or higher
- npm or yarn

### Local Development

1. Install dependencies:
\`\`\`bash
npm install
\`\`\`

2. Start the development server:
\`\`\`bash
npm run dev
\`\`\`

3. The server will start on port 3001 by default.

### Docker Deployment

1. Build and run with Docker Compose:
\`\`\`bash
docker-compose up -d
\`\`\`

2. The server will be available at http://localhost

## API Endpoints

### Rooms
- `GET /api/rooms` - List all active rooms
- `GET /health` - Server health check

### Recordings
- `GET /api/recordings` - List all recordings
- `GET /api/recordings/:filename` - Download a specific recording
- `DELETE /api/recordings/:filename` - Delete a recording

## Socket.io Events

### Client to Server
- `join-room` - Join a voice chat room
- `leave-room` - Leave a voice chat room
- `start-recording` - Start recording the room
- `stop-recording` - Stop recording the room
- `audio-chunk` - Send audio data chunk
- `get-recording` - Get current recording data
- `webrtc-offer` - WebRTC offer for peer connection
- `webrtc-answer` - WebRTC answer for peer connection
- `webrtc-ice-candidate` - WebRTC ICE candidate

### Server to Client
- `room-joined` - Confirmation of room join
- `user-joined` - Another user joined the room
- `user-left` - A user left the room
- `recording-started` - Recording started notification
- `recording-stopped` - Recording stopped notification
- `audio-data` - Real-time audio data from other users
- `webrtc-offer` - WebRTC offer from another user
- `webrtc-answer` - WebRTC answer from another user
- `webrtc-ice-candidate` - WebRTC ICE candidate from another user

## Configuration

Environment variables:
- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment (development/production)

## File Structure

\`\`\`
server/
├── server.js          # Main server file
├── package.json       # Dependencies and scripts
├── Dockerfile         # Docker configuration
├── docker-compose.yml # Docker Compose setup
├── nginx.conf         # Nginx configuration
├── start.sh          # Startup script
├── recordings/        # Directory for saved recordings
└── README.md         # This file
\`\`\`

## Usage

1. Start the server
2. Connect clients using Socket.io
3. Join rooms and start voice chat
4. Record conversations as needed
5. Download recordings via API

## Security Considerations

- Implement authentication for production use
- Add rate limiting for API endpoints
- Secure file upload/download endpoints
- Use HTTPS in production
- Implement proper CORS policies

## License

MIT License
