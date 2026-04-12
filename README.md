<![CDATA[# 🧪 Noesis Testing Platform

> **Enterprise-grade test automation management platform** for orchestrating, executing, and monitoring System Testing (ST) automation scripts — built for QA teams that demand visibility, control, and speed.

---

## 📖 Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Application Modules](#application-modules)
- [API Reference](#api-reference)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

**Noesis Testing Platform** is a full-stack web application designed to centralize and streamline the management of automated system tests. It provides a unified interface for browsing test scripts, organizing them into reusable test suites, triggering executions (on-demand or scheduled), and reviewing results — all with real-time feedback through live log streaming.

The platform bridges the gap between test automation frameworks (Maven + TestNG) and QA teams by providing an intuitive web dashboard that surfaces execution trends, failure analysis, system health metrics, and notification-based alerting.

---

## Key Features

### 📊 Dashboard & Analytics
- **Execution overview** with total runs, pass/fail rates, and script counts
- **Execution Trend Graph** — 30-day rolling timeline of test results
- **Failure Analysis Heatmap** — visual hot-spots for frequently failing scripts
- **System Health Monitor** — real-time API, database, and memory status
- **Last Run Summary** — quick-glance status of the most recent execution

### 📝 Script Management
- Browse, search, and filter all registered ST automation scripts
- Organize scripts by **categories** (Configuration, Feature, Manual, Sanity, API, etc.)
- Enable/disable individual scripts
- **Sync from source** — automatically discover and register scripts from the automation project (supports both local filesystem and Git repository sources)
- Tag-based metadata for flexible organization

### 🧩 Test Suites
- Create custom groupings of scripts for batch execution
- Configure parallel execution with adjustable thread counts
- Suite-level metadata and descriptions
- Reusable across scheduled and on-demand runs

### ▶️ Execution Engine
- **On-demand execution** — select scripts or suites and run instantly
- **Scheduled execution** — cron-based recurring runs and one-time scheduled runs via date picker
- **Live log streaming** — real-time execution output via WebSocket (Socket.IO)
- **Stop running executions** — graceful termination of active runs
- Maven + TestNG integration with dynamic `testng.xml` generation

### 📜 History & Reporting
- Paginated execution history with status-based filtering
- **Run Detail View** — per-script pass/fail breakdown with full log output
- **CSV Export** — download execution history as spreadsheets
- **PDF Reports** — generate detailed per-run reports with jsPDF

### 🔔 Notifications
- Real-time toast notifications for execution completions
- Persistent notification center with read/unread tracking
- Database-backed notification history with polling sync
- Severity-based categorization (success, warning, error)

### 📋 Application Logs
- Centralized logging of all API requests, system events, and audit trails
- Filterable by date, severity, module, and action
- Request audit middleware for complete HTTP lifecycle tracking

### 🎨 Theming & UX
- **Light/Dark mode** with seamless toggle and persistent preference
- Premium UI with PrimeNG Aura theme
- Responsive sidebar navigation with collapsible mode
- Profile management with avatar upload
- Keyboard shortcuts (Ctrl+K command palette)
- Session timeout detection with themed alert banners

### 👥 User Management
- Role-based access control (**Admin**, **Tester**, **Viewer**)
- Admins: full platform access including user management
- Testers: script execution and suite creation
- Viewers: read-only dashboard and history access
- Profile settings with password change capability

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (Angular 21)                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │Dashboard │ │ Scripts  │ │  Runner  │ │   History     │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬────────┘  │
│       │             │            │               │           │
│       └─────────────┴────────────┴───────────────┘           │
│                          │  HTTP + WebSocket                 │
└──────────────────────────┼───────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────┐
│                     Backend (Node.js + Express)              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Auth API │ │Script API│ │Exec API  │ │ Scheduler     │  │
│  │  (JWT)   │ │          │ │+Socket.IO│ │  (node-cron)  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬────────┘  │
│       │             │            │               │           │
│       └─────────────┴────────────┴───────────────┘           │
│                          │                                   │
│  ┌───────────────────────┼────────────────────────────────┐  │
│  │              PostgreSQL Database                       │  │
│  │  Users │ Scripts │ Suites │ Runs │ Results │ Logs      │  │
│  └────────────────────────────────────────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────┼────────────────────────────────┐  │
│  │          Test Execution Engine (Maven + TestNG)        │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer         | Technology                                           |
|:--------------|:-----------------------------------------------------|
| **Frontend**  | Angular 21, PrimeNG (Aura theme), Chart.js, SCSS     |
| **Backend**   | Node.js, Express, TypeScript, Socket.IO              |
| **Database**  | PostgreSQL 14+                                       |
| **Auth**      | JWT (JSON Web Tokens), bcrypt password hashing       |
| **Execution** | Maven, TestNG, dynamic XML generation                |
| **Scheduler** | node-cron for recurring and one-time scheduled runs   |
| **Logging**   | Winston (server-side), centralized app_logs table     |
| **Security**  | Helmet, CORS, rate limiting, role-based access control|
| **Reporting** | jsPDF, jspdf-autotable, CSV export                   |
| **Real-time** | Socket.IO (WebSocket with fallback)                  |

---

## Prerequisites

Before setting up the project, ensure the following software is installed:

| Software          | Version    | Purpose                            |
|:------------------|:-----------|:-----------------------------------|
| **Node.js**       | 18+        | Backend runtime & frontend tooling |
| **npm**           | 10+        | Package management                 |
| **PostgreSQL**    | 14+        | Primary database                   |
| **Angular CLI**   | 21+        | Frontend build & serve             |
| **Java JDK**      | 17+        | TestNG test execution              |
| **Apache Maven**  | 3.8+       | Test project build tool            |

---

## Getting Started

### 1. Clone the Repository

```bash
git clone <repository-url>
cd Noesis_Testing
```

### 2. Database Setup

Create a PostgreSQL database and apply the schema:

```bash
psql -U <your_db_user> -f database/schema.sql
```

This will create all required tables, indexes, triggers, enum types, and seed data including default script categories and sample test suites.

### 3. Backend Setup

```bash
cd backend
npm install
```

Create a `.env` file based on the provided `.env.example` template. Update all placeholder values with your actual configuration:

```bash
cp .env.example .env
# Edit .env with your database credentials and configuration
```

Initialize the database (creates initial admin user if not already present):

```bash
npx ts-node src/database/init.ts
```

Start the development server:

```bash
npm run dev
```

The API server will start and display the configured port in the console.

### 4. Frontend Setup

```bash
cd frontend
npm install
ng serve
```

The Angular development server will be available at `http://localhost:4200` by default.

---

## Project Structure

```
Noesis_Testing/
│
├── database/
│   └── schema.sql                  # PostgreSQL schema, enums, triggers & seed data
│
├── backend/
│   ├── src/
│   │   ├── config/                 # Environment configuration loader
│   │   ├── database/               # PostgreSQL connection pool & initialization
│   │   ├── middleware/
│   │   │   ├── auth.ts             # JWT authentication middleware
│   │   │   ├── errorHandler.ts     # Global error & 404 handlers
│   │   │   └── requestAudit.ts     # HTTP request lifecycle auditing
│   │   ├── routes/
│   │   │   ├── auth.ts             # Authentication (login, register, profile)
│   │   │   ├── scripts.ts          # Script CRUD, sync, categories
│   │   │   ├── execution.ts        # Run management, live streaming, stats
│   │   │   ├── suites.ts           # Test suite CRUD & script mapping
│   │   │   ├── users.ts            # User management (admin)
│   │   │   ├── notifications.ts    # Notification CRUD & read status
│   │   │   └── logs.ts             # Application log querying
│   │   ├── services/
│   │   │   ├── appLogService.ts    # Centralized application logging
│   │   │   └── schedulerService.ts # Cron-based job scheduling
│   │   ├── utils/
│   │   │   └── logger.ts           # Winston logger configuration
│   │   └── server.ts               # Express + Socket.IO entry point
│   ├── .env.example                # Environment variable template
│   ├── tsconfig.json               # TypeScript configuration
│   └── package.json                # Dependencies & scripts
│
├── frontend/
│   └── src/app/
│       ├── components/             # Shared/reusable UI components
│       ├── guards/                 # Route guards (auth, guest, admin, edit)
│       ├── interceptors/           # HTTP interceptors (JWT token injection)
│       ├── layout/
│       │   └── main-layout/        # Sidebar navigation, profile, theme toggle
│       ├── models/                 # TypeScript interfaces & types
│       ├── pages/
│       │   ├── login/              # Authentication & user management screens
│       │   ├── dashboard/          # Analytics dashboard with charts & widgets
│       │   ├── scripts/            # Script browsing, filtering & management
│       │   ├── runner/             # Script/suite execution with live logs
│       │   ├── suites/             # Test suite creation & management
│       │   ├── history/            # Execution history with export options
│       │   ├── run-detail/         # Per-run detailed results & logs
│       │   ├── logs/               # Application log viewer
│       │   └── notifications/      # Notification center
│       ├── services/
│       │   ├── auth.service.ts     # Authentication state & API
│       │   ├── script.service.ts   # Script data API
│       │   ├── execution.service.ts# Execution API & Socket.IO client
│       │   ├── suite.service.ts    # Test suite API
│       │   ├── log.service.ts      # Application log API
│       │   ├── theme.service.ts    # Dark/light mode management
│       │   ├── session.service.ts  # Session timeout detection
│       │   ├── notification.service.ts      # Notification state & API
│       │   └── notification-toast.service.ts# Toast notification helper
│       ├── app.routes.ts           # Application routing configuration
│       ├── app.config.ts           # Angular providers & configuration
│       └── app.scss                # Global styles & theme variables
│
├── .gitignore
└── README.md
```

---

## Application Modules

### Authentication & Authorization
- JWT-based stateless authentication
- Password hashing with bcrypt
- Role-based route protection via Angular guards (`authGuard`, `adminGuard`, `editGuard`, `guestGuard`)
- Session timeout detection with automatic redirect
- Profile management (name, email, avatar upload with client-side compression)

### Script Sync Engine
The platform supports two modes for discovering and registering ST Automation scripts:
- **Local filesystem** — scans a configured directory for TestNG test classes
- **Git repository** — clones/pulls from a remote Git repository and parses the test source tree

Discovered scripts are automatically categorized based on naming conventions and registered in the database.

### Execution Pipeline
1. User selects scripts or a test suite
2. Backend generates a dynamic `testng.xml` configuration
3. Maven process is spawned with the generated configuration
4. Real-time log output is streamed to the frontend via Socket.IO
5. Results (pass/fail/error/skipped) are parsed and persisted per-script
6. Notifications are generated upon completion
7. Dashboard statistics are updated

### Scheduling System
- **Recurring runs** — define cron expressions for automated periodic execution
- **One-time runs** — schedule a specific date/time for a single execution
- Managed by `node-cron` with database persistence for state tracking

---

## API Reference

### Authentication
| Method | Endpoint                  | Description               | Access   |
|:-------|:--------------------------|:--------------------------|:---------|
| POST   | `/api/auth/login`         | User login                | Public   |
| POST   | `/api/auth/register`      | User registration         | Public   |
| GET    | `/api/auth/me`            | Get current user profile  | Auth     |
| PUT    | `/api/auth/profile`       | Update user profile       | Auth     |
| PUT    | `/api/auth/change-password`| Change password          | Auth     |

### Scripts
| Method | Endpoint                  | Description               | Access   |
|:-------|:--------------------------|:--------------------------|:---------|
| GET    | `/api/scripts`            | List scripts (filterable) | Auth     |
| GET    | `/api/scripts/categories` | List script categories    | Auth     |
| POST   | `/api/scripts/sync`       | Sync scripts from source  | Admin    |

### Execution
| Method | Endpoint                   | Description                  | Access   |
|:-------|:---------------------------|:-----------------------------|:---------|
| POST   | `/api/execution/run`       | Execute selected scripts     | Tester+  |
| POST   | `/api/execution/stop/:id`  | Stop a running execution     | Tester+  |
| GET    | `/api/execution/runs`      | Execution history (paginated)| Auth     |
| GET    | `/api/execution/stats`     | Dashboard statistics         | Auth     |

### Test Suites
| Method | Endpoint                  | Description               | Access   |
|:-------|:--------------------------|:--------------------------|:---------|
| GET    | `/api/suites`             | List all test suites      | Auth     |
| POST   | `/api/suites`             | Create a new test suite   | Tester+  |

### Notifications
| Method | Endpoint                       | Description               | Access |
|:-------|:-------------------------------|:--------------------------|:-------|
| GET    | `/api/notifications`           | List user notifications   | Auth   |
| PUT    | `/api/notifications/:id/read`  | Mark as read              | Auth   |
| DELETE | `/api/notifications`           | Clear all notifications   | Auth   |

### System
| Method | Endpoint                  | Description               | Access   |
|:-------|:--------------------------|:--------------------------|:---------|
| GET    | `/api/health`             | System health check       | Public   |
| GET    | `/api/logs`               | Query application logs    | Auth     |
| GET    | `/api/users`              | List all users            | Admin    |

---

## Security

The platform implements multiple layers of security:

- **Authentication** — Stateless JWT tokens with configurable expiration
- **Password Security** — bcrypt hashing with salt rounds
- **Rate Limiting** — General API rate limiting (500 requests/15 min) and stricter auth endpoint limiting (20 requests/15 min)
- **HTTP Security Headers** — Helmet middleware for XSS, MIME-type, and other protections
- **CORS** — Configurable origin allowlist
- **Role-Based Access** — Three-tier permission model (Admin > Tester > Viewer)
- **Request Auditing** — Full HTTP lifecycle logging for compliance and debugging
- **Input Validation** — Payload size limits and parameter sanitization

---

## Environment Configuration

The backend uses a `.env` file for all environment-specific configuration. A `.env.example` template is provided with the following configurable sections:

| Category      | Variables                              | Description                          |
|:--------------|:---------------------------------------|:-------------------------------------|
| **Server**    | `PORT`, `NODE_ENV`                     | Server port and environment mode     |
| **Database**  | `DB_HOST`, `DB_PORT`, `DB_NAME`, etc.  | PostgreSQL connection parameters     |
| **Auth**      | `JWT_SECRET`, `JWT_EXPIRES_IN`         | Token signing and expiration config  |
| **Automation**| `ST_AUTOMATION_PATH`, `MAVEN_HOME`     | Test automation project paths        |
| **CORS**      | `CORS_ORIGIN`                          | Allowed frontend origin              |

> ⚠️ **Important**: Never commit the `.env` file to version control. It is already included in `.gitignore`.

---

## Scripts

### Backend

| Command          | Description                              |
|:-----------------|:-----------------------------------------|
| `npm run dev`    | Start development server with hot-reload |
| `npm run build`  | Compile TypeScript to JavaScript         |
| `npm start`      | Run compiled production build            |
| `npm run db:init`| Initialize database with seed data       |

### Frontend

| Command          | Description                              |
|:-----------------|:-----------------------------------------|
| `ng serve`       | Start Angular dev server                 |
| `ng build`       | Build production bundle                  |
| `ng test`        | Run unit tests                           |

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -m 'Add your feature'`)
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a Pull Request

Please ensure all code follows the existing patterns and conventions established in the codebase.

---

## License

This project is proprietary software developed by **Drogevate Solutions Private Limited**. All rights reserved.
]]>
