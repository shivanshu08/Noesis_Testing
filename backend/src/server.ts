import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config';
import { testConnection } from './database/connection';
import { logger } from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import scriptRoutes from './routes/scripts';
import executionRoutes, { setSocketIO } from './routes/execution';
import suiteRoutes from './routes/suites';
import path from 'path';
import fs from 'fs';

const app = express();
const httpServer = createServer(app);

// Socket.IO for real-time log streaming
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: config.cors.origin,
    methods: ['GET', 'POST'],
  },
});

setSocketIO(io);

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.debug(`Socket connected: ${socket.id}`);

  socket.on('join-run', (runId: number) => {
    socket.join(`run-${runId}`);
    logger.debug(`Socket ${socket.id} joined run-${runId}`);
  });

  socket.on('leave-run', (runId: number) => {
    socket.leave(`run-${runId}`);
  });

  socket.on('disconnect', () => {
    logger.debug(`Socket disconnected: ${socket.id}`);
  });
});

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.cors.origin, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Auth rate limiting (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again later.' },
});
app.use('/api/auth/login', authLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/scripts', scriptRoutes);
app.use('/api/execution', executionRoutes);
app.use('/api/suites', suiteRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
async function start() {
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.warn('Database connection failed. Server will start but some features may not work.');
  }

  httpServer.listen(config.port, () => {
    logger.info(`Noesis Testing Platform API running on port ${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info(`ST Automation path: ${config.stAutomation.path}`);
    logger.info(`CORS origin: ${config.cors.origin}`);
  });
}

start().catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});

export { app, httpServer };
