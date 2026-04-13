import dotenv from 'dotenv';
import path from 'path';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'noesis_testing',
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'fallback-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },

  stAutomation: {
    source: (process.env.ST_AUTOMATION_SOURCE || 'git').toLowerCase() === 'git' ? 'git' : 'local',
    path: process.env.ST_AUTOMATION_PATH || 'D:\\ST Automation',
    importPath: process.env.ST_AUTOMATION_IMPORT_PATH || path.join(process.cwd(), 'scripts'),
    gitRepoUrl: process.env.ST_AUTOMATION_GIT_REPO_URL || 'https://github.com/prashantguleria/AutomationTesting.git',
    gitCachePath: process.env.ST_AUTOMATION_GIT_CACHE_PATH || path.join(process.env.ST_AUTOMATION_PATH || 'D:\\ST Automation', '.cache', 'automation-testing-repo'),
    gitBranch: process.env.ST_AUTOMATION_GIT_BRANCH || '',
    mavenHome: process.env.MAVEN_HOME || '',
    reportsPath: process.env.ST_AUTOMATION_REPORTS_PATH || path.join(process.env.ST_AUTOMATION_PATH || 'D:\\ST Automation', 'noesis-reports'),
  },

  cors: {
    origin: process.env.CORS_ORIGIN || ['http://localhost:4200', 'http://localhost:4201'],
  },
};
