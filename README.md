# Noesis Testing Platform

A full-stack platform for managing and executing ST (System Testing) automation scripts.

## Architecture

- **Frontend**: Angular 21 + PrimeNG (Aura theme)
- **Backend**: Node.js + Express + TypeScript + Socket.IO
- **Database**: MySQL 8+
- **Test Engine**: Maven + TestNG (executes ST Automation scripts at `D:\ST Automation`)

## Prerequisites

- Node.js 18+
- MySQL 8.0+
- Angular CLI (`npm install -g @angular/cli`)
- Java 17+ & Maven (for test execution)

## Setup

### 1. Database

```sql
-- Create the database and run the schema
mysql -u root -p < database/schema.sql
```

This creates the `noesis_testing` database with all tables and seed data for 40+ scripts.

### 2. Backend

```bash
cd backend
npm install

# Configure environment (edit .env if needed)
# Default: PORT=3000, DB=noesis_testing, ST_AUTOMATION_PATH=D:\ST Automation

# Initialize database (creates admin user if not exists)
npx ts-node src/database/init.ts

# Start development server
npm run dev
```

Backend runs at `http://localhost:3000`

### 3. Frontend

```bash
cd frontend
npm install

# Start development server
ng serve
```

Frontend runs at `http://localhost:4200`

## Default Credentials

| Username | Password | Role  |
|----------|----------|-------|
| admin    | admin123 | admin |

## Features

- **Dashboard** - Stats overview, category distribution, recent executions
- **Scripts** - Browse, search, filter, enable/disable all ST scripts
- **Run Scripts** - Select scripts, click run, live log streaming via Socket.IO
- **Test Suites** - Create custom script groupings for batch execution
- **History** - Paginated execution history with status filters
- **Run Detail** - Per-run results, pass/fail per script, full log output

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/login | Login |
| POST | /api/auth/register | Register |
| GET | /api/auth/me | Current user |
| GET | /api/scripts | List scripts (with filters) |
| GET | /api/scripts/categories | List categories |
| POST | /api/scripts/sync | Sync from project |
| POST | /api/execution/run | Execute selected scripts |
| POST | /api/execution/stop/:id | Stop a running execution |
| GET | /api/execution/runs | Execution history |
| GET | /api/execution/stats | Dashboard statistics |
| GET | /api/suites | List test suites |
| POST | /api/suites | Create suite |

## Project Structure

```
Noesis_Testing/
├── database/
│   └── schema.sql          # MySQL schema + seed data
├── backend/
│   ├── src/
│   │   ├── config/         # Environment config
│   │   ├── database/       # MySQL connection & init
│   │   ├── middleware/      # Auth (JWT) & error handling
│   │   ├── routes/         # API route handlers
│   │   ├── utils/          # Logger (Winston)
│   │   └── server.ts       # Express + Socket.IO entry
│   ├── .env                # Environment variables
│   └── package.json
├── frontend/
│   └── src/app/
│       ├── layout/         # Main sidebar layout
│       ├── pages/          # Login, Dashboard, Scripts, Runner, Suites, History, RunDetail
│       ├── services/       # Auth, Script, Execution, Suite services
│       ├── guards/         # Auth & guest route guards
│       ├── interceptors/   # JWT token interceptor
│       └── models/         # TypeScript interfaces
└── README.md
```
