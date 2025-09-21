const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.IO
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:3001"], // Add your frontend URLs
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Store active meetings and their participants
const activeMeetings = new Map();
const userSessions = new Map();

// Meeting data structure
class Meeting {
  constructor(meetingId, title = '') {
    this.meetingId = meetingId;
    this.title = title;
    this.participants = new Map(); // socketId -> user info
    this.messages = [];
    this.createdAt = new Date();
  }

  addParticipant(socketId, userInfo) {
    this.participants.set(socketId, userInfo);
  }

  removeParticipant(socketId) {
    this.participants.delete(socketId);
  }

  addMessage(message) {
    this.messages.push(message);
    // Keep only last 100 messages to prevent memory issues
    if (this.messages.length > 100) {
      this.messages = this.messages.slice(-100);
    }
  }

  getParticipants() {
    return Array.from(this.participants.values());
  }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Handle joining a meeting
  socket.on('join_meeting', (data) => {
    try {
      const { meetingId, userInfo } = data;

      // Validate required fields
      if (!meetingId || !userInfo || !userInfo.role || !userInfo.name) {
        socket.emit('error', { message: 'Missing required meeting or user information' });
        return;
      }

      // Store user session info
      userSessions.set(socket.id, { ...userInfo, meetingId, socketId: socket.id });

      // Create meeting if it doesn't exist
      if (!activeMeetings.has(meetingId)) {
        activeMeetings.set(meetingId, new Meeting(meetingId, data.meetingTitle || ''));
      }

      const meeting = activeMeetings.get(meetingId);

      // Add participant to meeting
      meeting.addParticipant(socket.id, { ...userInfo, socketId: socket.id });

      // Join the meeting room
      socket.join(meetingId);

      // Send meeting history to the new participant
      socket.emit('meeting_joined', {
        meetingId,
        participants: meeting.getParticipants(),
        messages: meeting.messages,
        joinedAt: new Date()
      });

      // Notify other participants about the new join
      socket.to(meetingId).emit('participant_joined', {
        participant: { ...userInfo, socketId: socket.id },
        timestamp: new Date()
      });

      console.log(`User ${userInfo.name} (${userInfo.role}) joined meeting ${meetingId}`);

    } catch (error) {
      console.error('Error handling join_meeting:', error);
      socket.emit('error', { message: 'Failed to join meeting' });
    }
  });

  // Handle sending messages
  socket.on('send_message', (data) => {
    try {
      const userSession = userSessions.get(socket.id);

      if (!userSession) {
        socket.emit('error', { message: 'User session not found' });
        return;
      }

      const { meetingId } = userSession;
      const meeting = activeMeetings.get(meetingId);

      if (!meeting) {
        socket.emit('error', { message: 'Meeting not found' });
        return;
      }

      // Create message object
      const message = {
        id: uuidv4(),
        senderId: userSession.userId || socket.id,
        senderRole: userSession.role,
        senderName: userSession.name,
        content: data.content,
        timestamp: new Date().toISOString(),
        meetingId: meetingId
      };

      // Add message to meeting history
      meeting.addMessage(message);

      // Broadcast message to all participants in the meeting
      io.to(meetingId).emit('new_message', message);

      console.log(`Message from ${userSession.name} in meeting ${meetingId}: ${data.content}`);

    } catch (error) {
      console.error('Error handling send_message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Handle typing indicators
  socket.on('typing_start', () => {
    try {
      const userSession = userSessions.get(socket.id);
      if (userSession) {
        socket.to(userSession.meetingId).emit('user_typing', {
          userId: userSession.userId || socket.id,
          name: userSession.name,
          role: userSession.role
        });
      }
    } catch (error) {
      console.error('Error handling typing_start:', error);
    }
  });

  socket.on('typing_stop', () => {
    try {
      const userSession = userSessions.get(socket.id);
      if (userSession) {
        socket.to(userSession.meetingId).emit('user_stopped_typing', {
          userId: userSession.userId || socket.id
        });
      }
    } catch (error) {
      console.error('Error handling typing_stop:', error);
    }
  });

  // Handle getting meeting info
  socket.on('get_meeting_info', (meetingId) => {
    try {
      const meeting = activeMeetings.get(meetingId);
      if (meeting) {
        socket.emit('meeting_info', {
          meetingId,
          participants: meeting.getParticipants(),
          messageCount: meeting.messages.length,
          createdAt: meeting.createdAt
        });
      } else {
        socket.emit('meeting_info', null);
      }
    } catch (error) {
      console.error('Error handling get_meeting_info:', error);
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    try {
      const userSession = userSessions.get(socket.id);

      if (userSession) {
        const { meetingId } = userSession;
        const meeting = activeMeetings.get(meetingId);

        if (meeting) {
          // Remove participant from meeting
          meeting.removeParticipant(socket.id);

          // Notify other participants about the disconnect
          socket.to(meetingId).emit('participant_left', {
            participant: userSession,
            timestamp: new Date()
          });

          // If no participants left, clean up meeting after 5 minutes
          if (meeting.participants.size === 0) {
            setTimeout(() => {
              if (meeting.participants.size === 0) {
                activeMeetings.delete(meetingId);
                console.log(`Cleaned up empty meeting: ${meetingId}`);
              }
            }, 5 * 60 * 1000); // 5 minutes
          }
        }

        // Remove user session
        userSessions.delete(socket.id);

        console.log(`User ${userSession.name} disconnected from meeting ${meetingId}`);
      }

      console.log(`Client disconnected: ${socket.id}`);

    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });

  // Handle reconnection
  socket.on('reconnect_to_meeting', (data) => {
    try {
      const { meetingId, userInfo } = data;

      // Handle reconnection logic (similar to join_meeting)
      socket.emit('join_meeting', { meetingId, userInfo });

    } catch (error) {
      console.error('Error handling reconnect_to_meeting:', error);
    }
  });
});

// API Routes

// Get meeting info
app.get('/api/meetings/:meetingId', (req, res) => {
  try {
    const { meetingId } = req.params;
    const meeting = activeMeetings.get(meetingId);

    if (meeting) {
      res.json({
        meetingId,
        participants: meeting.getParticipants(),
        messageCount: meeting.messages.length,
        createdAt: meeting.createdAt
      });
    } else {
      res.status(404).json({ error: 'Meeting not found' });
    }
  } catch (error) {
    console.error('Error getting meeting info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new meeting
app.post('/api/meetings', (req, res) => {
  try {
    const { meetingId, title } = req.body;

    if (!meetingId) {
      return res.status(400).json({ error: 'Meeting ID is required' });
    }

    if (activeMeetings.has(meetingId)) {
      return res.status(409).json({ error: 'Meeting already exists' });
    }

    const meeting = new Meeting(meetingId, title);
    activeMeetings.set(meetingId, meeting);

    res.status(201).json({
      meetingId,
      title,
      createdAt: meeting.createdAt
    });

  } catch (error) {
    console.error('Error creating meeting:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all active meetings
app.get('/api/meetings', (req, res) => {
  try {
    const meetings = Array.from(activeMeetings.entries()).map(([id, meeting]) => ({
      meetingId: id,
      title: meeting.title,
      participantCount: meeting.participants.size,
      messageCount: meeting.messages.length,
      createdAt: meeting.createdAt
    }));

    res.json(meetings);
  } catch (error) {
    console.error('Error getting meetings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date(),
    activeMeetings: activeMeetings.size,
    activeConnections: userSessions.size
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Teaching Chat Server running on port ${PORT}`);
  console.log(`Socket.IO enabled with CORS`);
  console.log(`API endpoints available at http://localhost:${PORT}/api`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server, io };
