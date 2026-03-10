# NovAIC App

> Desktop Client — AI chat interface with live VM visualization

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-blue.svg)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-blue.svg)](https://react.dev/)

## Overview

NovAIC App is a cross-platform desktop application that provides:

- **Chat Interface** — Natural language interaction with AI
- **Live VM View** — Real-time VNC display of AI operations
- **File Transfer** — Upload/download files to/from VM
- **Execution Logs** — Live tool execution visibility
- **User Takeover** — Direct VM control when needed

## Architecture

NovAIC App is the unified entry point for the entire NovAIC platform. It bundles and orchestrates multiple backend services:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        NovAIC App (Tauri)                           │
├─────────────────────────────────────────────────────────────────────┤
│  Frontend (React)                                                   │
│  ├── Chat Interface                                                 │
│  ├── VNC Viewer (noVNC)                                             │
│  └── Settings Panel                                                 │
├─────────────────────────────────────────────────────────────────────┤
│  Backend Services (auto-started)                                    │
│  ├── Gateway            :19999  — API gateway & WebSocket           │
│  ├── Runtime Orchestrator:19993 — Agent & subagent lifecycle        │
│  ├── Tools Server       :19998  — Tool execution                    │
│  ├── Queue Service      :19997  — Task queue                        │
│  ├── File Service       :19995  — File upload/download              │
│  ├── Tool Result Service:19994  — Tool results storage              │
│  ├── VMControl          :19996  — VM management                     │
│  └── Workers (watchdog, task, saga, scheduler, health)              │
└─────────────────────────────────────────────────────────────────────┘
```

## Screenshots

```
┌─────────────────────────────────────────────────────────────────────┐
│  NovAIC                                    [User ▼] [⚙️] [─][□][×]  │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────┬───────────────────────────────────────┐│
│  │                         │   🖥️ VM Desktop (VNC)                  ││
│  │   💬 Chat               │   ┌───────────────────────────────┐   ││
│  │                         │   │                               │   ││
│  │  ┌─────────────────────┐│   │    [Live desktop view]        │   ││
│  │  │ 👤 Analyze sales.csv││   │                               │   ││
│  │  └─────────────────────┘│   │                               │   ││
│  │                         │   └───────────────────────────────┘   ││
│  │  ┌─────────────────────┐│   [Fullscreen]  [Take Control]        ││
│  │  │ 🤖 Processing...    │├───────────────────────────────────────┤│
│  │  │    ████████░░ 80%   ││   📋 Execution Log                    ││
│  │  └─────────────────────┘│   ┌───────────────────────────────┐   ││
│  │                         │   │ > Tool: run_python            │   ││
│  │                         │   │ > Processing row 4000/5000    │   ││
│  │                         │   └───────────────────────────────┘   ││
│  ├─────────────────────────┴───────────────────────────────────────┤│
│  │  [📎 Upload]  │ Type your message...                   [Send ⏎] ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Framework** | [Tauri 2.0](https://tauri.app/) |
| **Frontend** | React 18, TypeScript |
| **Styling** | Tailwind CSS |
| **State** | Zustand |
| **VNC** | noVNC |
| **Backend** | Rust |

## Installation

### Prerequisites

- Node.js 20+
- Rust 1.70+
- Python 3.11+
- Platform-specific dependencies (see [Tauri prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites))

### Clone All Repositories

NovAIC uses a split architecture. Clone all required repositories:

```bash
mkdir ~/novaic-split && cd ~/novaic-split

# Core app
git clone https://github.com/chriswangcq/novaic-app

# Backend services
git clone https://github.com/chriswangcq/novaic-gateway
git clone https://github.com/chriswangcq/novaic-runtime-orchestrator
git clone https://github.com/chriswangcq/novaic-tools-server
git clone https://github.com/chriswangcq/novaic-agent-runtime
git clone https://github.com/chriswangcq/novaic-storage-a
git clone https://github.com/chriswangcq/novaic-storage-b

# MCP tools
git clone https://github.com/chriswangcq/novaic-mcp-vmuse
```

### Setup

```bash
cd novaic-app

# Install frontend dependencies
npm install

# Development mode (auto-detects sibling repos)
npm run tauri:dev

# Build for production (creates .app/.dmg)
npm run tauri:build

# Or use the DMG build script
bash scripts/build-dmg.sh
```

### Mobile (Android / iOS)

**First-time init** (run once before first mobile build):
```bash
tauri android init   # Android: generates gen/android, configures signing
tauri ios init       # iOS: generates gen/ios; set developmentTeam in tauri.ios.conf.json
```

**Build & dev**:
```bash
npm run tauri:build:android   # or tauri:dev:android
npm run tauri:build:ios       # or tauri:dev:ios
```

**Prerequisites**: Android Studio + NDK for Android; Xcode for iOS. See [Tauri mobile docs](https://v2.tauri.app/develop/cross-platform/).

### Development vs Production

| Mode | Backend Location | Config |
|------|-----------------|--------|
| **Development** | Sibling repos (`../novaic-*`) | Auto-detected |
| **Production** | Bundled in app resources | Built-in |

In development mode, the app automatically discovers sibling repositories and starts services from source. In production, all backends are pre-built binaries bundled inside the `.app`.

## Project Structure

```
novaic-app/
├── src/                      # React frontend
│   ├── components/
│   │   ├── Chat/             # Chat interface
│   │   │   ├── ChatPanel.tsx
│   │   │   ├── ChatInput.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── UserMessage.tsx
│   │   │   ├── AssistantMessage.tsx
│   │   │   ├── ToolCallCard.tsx
│   │   │   ├── ThinkingBlock.tsx
│   │   │   └── StreamingText.tsx
│   │   ├── Visual/           # VM visualization
│   │   │   ├── VisualPanel.tsx
│   │   │   ├── VNCView.tsx
│   │   │   └── ExecutionLog.tsx
│   │   ├── Layout/           # App layout
│   │   │   ├── Header.tsx
│   │   │   ├── Resizer.tsx
│   │   │   └── LayoutToggle.tsx
│   │   └── Settings/
│   │       └── SettingsModal.tsx
│   ├── hooks/
│   │   └── useVm.ts          # VM management hook
│   ├── services/
│   │   └── vm.ts             # VM API client
│   ├── store/
│   │   └── index.ts          # Zustand store
│   ├── types/
│   │   ├── index.ts
│   │   └── novnc.d.ts        # noVNC types
│   ├── styles/
│   │   └── index.css         # Tailwind styles
│   ├── App.tsx
│   └── main.tsx
│
├── src-tauri/                # Rust backend
│   ├── src/
│   │   ├── main.rs           # Entry point
│   │   ├── error.rs          # Error handling
│   │   ├── http_client.rs    # HTTP utilities
│   │   ├── commands/         # Tauri commands
│   │   │   ├── mod.rs
│   │   │   ├── gateway.rs
│   │   │   ├── auth.rs
│   │   │   ├── config.rs
│   │   │   ├── file.rs
│   │   │   └── desktop/
│   │   │       └── urls.rs
│   │   ├── vm/               # VM management
│   │   │   ├── mod.rs
│   │   │   └── manager.rs
│   │   └── files/
│   │       └── mod.rs
│   ├── capabilities/
│   │   └── main.json         # Tauri capabilities
│   ├── icons/                # App icons
│   ├── Cargo.toml
│   └── tauri.conf.json       # Tauri config
│
├── public/
│   ├── icon.svg
│   ├── novnc/                # noVNC library
│   └── vnc.html              # VNC test page
│
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## Features

### Chat Interface

- Streaming responses with typing animation
- Tool call visualization with status indicators
- Thinking block display (for reasoning models)
- File attachment support
- Conversation history

### VM Visualization

- Real-time VNC display via noVNC
- Fullscreen mode
- User takeover (direct VM control)
- Connection status indicator

### Execution Logs

- Live tool execution updates
- Progress indicators
- Error display
- Expandable log details

### Settings

- API configuration
- Model selection
- Theme preferences
- VM connection settings

## Development

```bash
# Start development server (frontend only)
npm run dev

# Start Tauri development (full app)
npm run tauri:dev

# Type checking
npx tsc --noEmit

# Linting
npm run lint

# Format code
npm run format
```

## Build

```bash
# Build for current platform
npm run tauri:build

# Output in src-tauri/target/release/bundle/
```

### Platform-Specific Builds

| Platform | Output |
|----------|--------|
| macOS | `.app`, `.dmg` |
| Windows | `.exe`, `.msi` |
| Linux | `.AppImage`, `.deb` |

## Configuration

### Frontend (Vite)

See `vite.config.ts` for build configuration.

### Tauri

See `src-tauri/tauri.conf.json` for:
- Window settings
- Security permissions
- Build targets
- App metadata

### Tailwind

See `tailwind.config.js` for styling configuration.

## Service Ports

All backend services use standardized ports (configured via CLI arguments, no environment variables):

| Service | Port | Description |
|---------|------|-------------|
| Gateway | 19999 | API gateway, WebSocket |
| Runtime Orchestrator | 19993 | Agent lifecycle |
| Tools Server | 19998 | Tool execution |
| Queue Service | 19997 | Task queue |
| VMControl | 19996 | VM management |
| File Service | 19995 | File operations |
| Tool Result Service | 19994 | Tool results |

### CLI Arguments

All services are configured via command-line arguments (no environment variables):

```bash
# Example: Starting Gateway manually
python main_gateway.py \
  --host 127.0.0.1 \
  --port 19999 \
  --data-dir ~/Library/Application\ Support/com.novaic.app \
  --runtime-orchestrator-url http://127.0.0.1:19993 \
  --tools-server-url http://127.0.0.1:19998 \
  --queue-service-url http://127.0.0.1:19997 \
  --file-service-url http://127.0.0.1:19995 \
  --tool-result-service-url http://127.0.0.1:19994
```

## Data Directory

Application data is stored in:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/com.novaic.app` |
| Windows | `%APPDATA%\com.novaic.app` |
| Linux | `~/.local/share/com.novaic.app` |

Contents:
- `gateway.db` — Gateway database
- `runtime_orchestrator.db` — Agent & subagent data
- `queue.db` — Task queue
- `files/` — Uploaded files
- `tool_results/` — Tool execution results
- `vms/` — VM disk images

## Bundled Resources

Production builds include:

- **QEMU** — VM hypervisor (macOS ARM64)
- **MCP VMuse** — VM automation tools
- **Backend binaries** — Pre-built Python services (via PyInstaller)

## License

MIT
