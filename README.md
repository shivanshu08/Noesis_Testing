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
- **Live log updates** — execution output is polled from the Java API while a run is active
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
│                     Backend (Plain Java 17 HTTP Server)      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Auth API │ │Script API│ │Exec API  │ │ Scheduler     │  │
│  │  (JWT)   │ │          │ │+Polling  │ │   (Java)      │  │
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
| **Backend**   | Java 17, JDK HttpServer, JDBC                        |
| **Database**  | PostgreSQL 14+                                       |
| **Auth**      | JWT (JSON Web Tokens), bcrypt password hashing       |
| **Execution** | Maven, TestNG, dynamic XML generation                |
| **Scheduler** | Java-backed scheduled run persistence                 |
| **Logging**   | Plain Java logging, centralized app_logs table        |
| **Security**  | CORS, JWT, role-based access control                  |
| **Reporting** | jsPDF, jspdf-autotable, CSV export                   |
| **Live updates** | REST polling while executions are running         |

---

## Prerequisites

Before setting up the project, ensure the following software is installed:

| Software          | Version    | Purpose                            |
|:------------------|:-----------|:-----------------------------------|
| **Node.js**       | 18+        | Frontend tooling only              |
| **npm**           | 10+        | Package management                 |
| **PostgreSQL**    | 14+        | Primary database                   |
| **Angular CLI**   | 21+        | Frontend build & serve             |
| **Java JDK**      | 17         | Backend runtime and TestNG execution |
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
mvn -v
```

Create a `.env` file based on the provided `.env.example` template. Update all placeholder values with your actual configuration:

```bash
cp .env.example .env
# Edit .env with your database credentials and configuration
```

Initialize the database (creates initial admin user if not already present):

```bash
mvn -Dexec.mainClass=com.noesis.NoesisTestingApplication exec:java
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
│   ├── src/main/java/com/noesis/
│   │   ├── config/                 # CORS and .env bootstrap
│   │   ├── NoesisTestingApplication.java # Plain Java API server
│   │   ├── db/                     # JDBC helpers
│   │   ├── security/               # JWT auth interceptor
│   │   ├── service/                # Schema and execution services
│   │   └── web/                    # API helpers and exception handling
│   ├── src/main/resources/
│   │   └── noesis.properties       # Plain Java backend marker
│   ├── .env.example                # Environment variable template
│   ├── pom.xml                     # Java dependencies & build
│   └── package.json                # Optional Maven command aliases
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
│       │   ├── execution.service.ts# Execution API & polling client
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
4. Live log output is polled from the Java API while the run is active
5. Results (pass/fail/error/skipped) are parsed and persisted per-script
6. Notifications are generated upon completion
7. Dashboard statistics are updated

### Scheduling System
- **Recurring runs** — define cron expressions for automated periodic execution
- **One-time runs** — schedule a specific date/time for a single execution
- Managed by the Java backend with database persistence for state tracking

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
- **HTTP/API Security** — CORS, JWT validation, and role checks in plain Java
- **CORS** — Configurable origin allowlist
- **Role-Based Access** — Three-tier permission model (Admin > Tester > Viewer)
- **Request Auditing** — Full HTTP lifecycle logging for compliance and debugging
- **Input Validation** — Payload size limits and parameter sanitization

---

## Environment Configuration

The backend is configured via `backend/.env` (copy from `backend/.env.example`). Common settings:

| Feature                     | Env var(s)                                                                 | Example value (default)                                           |
|:----------------------------|:---------------------------------------------------------------------------|:------------------------------------------------------------------|
| **Backend port**            | `PORT`                                                                     | `3000`                                                            |
| **Postgres host/port**      | `DB_HOST`, `DB_PORT`                                                       | `localhost`, `5432`                                               |
| **Postgres credentials**    | `DB_USER`, `DB_PASSWORD`                                                   | `postgres`, `your_postgres_password`                              |
| **Postgres database**       | `DB_NAME`                                                                  | `noesis_testing`                                                  |
| **DB pool size**            | `DB_CONNECTION_LIMIT`                                                      | `10`                                                              |
| **JWT secret**              | `JWT_SECRET`                                                               | `noesis-testing-jwt-secret-change-in-production`                  |
| **JWT expiry**              | `JWT_EXPIRES_IN`                                                           | `24h`                                                             |
| **Automation source**       | `ST_AUTOMATION_SOURCE`                                                     | `git` (or `local`)                                                |
| **Automation workspace**    | `ST_AUTOMATION_PATH`                                                       | `D:\\ST Automation`                                               |
| **Automation repo (git)**   | `ST_AUTOMATION_GIT_REPO_URL`, `ST_AUTOMATION_GIT_BRANCH`                   | `https://github.com/prashantguleria/AutomationTesting.git`, `main` |
| **Automation cache (git)**  | `ST_AUTOMATION_GIT_CACHE_PATH`                                              | `D:\\ST Automation\\.cache\\automation-testing-repo`               |
| **Reports output**          | `ST_AUTOMATION_REPORTS_PATH`                                                | `D:\\ST Automation\\noesis-reports`                               |
| **Maven home**              | `MAVEN_HOME`                                                               | `C:\\Program Files\\Apache\\maven`                                |
| **Frontend origin (CORS)**  | `CORS_ORIGIN`                                                              | `http://localhost:4200`                                           |

**Backend base URL:** `http://localhost:<PORT>` (default: `http://localhost:3000`)

**Script runner URL (UI):** `http://localhost:4200/runner`

**Script execution URL (API):** `POST http://localhost:<PORT>/api/execution/run`

> ⚠️ **Important**: Never commit the `.env` file to version control. It is already included in `.gitignore`.

---

## Scripts

### Backend

| Command          | Description                              |
|:-----------------|:-----------------------------------------|
| `mvn -Dexec.mainClass=com.noesis.NoesisTestingApplication exec:java` | Start the Java backend on the configured port |
| `mvn -DskipTests package` | Build the Java backend jar             |
| `npm run dev`    | Alias for the Maven exec Java command     |
| `npm run build`  | Alias for `mvn -DskipTests package`       |
| `npm start`      | Run the packaged Java jar                 |

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
