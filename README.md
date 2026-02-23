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
- Platform-specific dependencies (see [Tauri prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites))

### Setup

```bash
cd novaic-app

# Install dependencies
npm install

# Development mode
npm run tauri:dev

# Build for production
export NOVAIC_MCP_VMUSE_REPO=../novaic-mcp-vmuse
npm run tauri:build
```

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
│   │   ├── app_config.rs     # App configuration
│   │   ├── error.rs          # Error handling
│   │   ├── http_client.rs    # HTTP utilities
│   │   ├── commands/         # Tauri commands
│   │   │   ├── mod.rs
│   │   │   ├── agent_commands.rs
│   │   │   ├── vm_commands.rs
│   │   │   ├── file_commands.rs
│   │   │   └── config_commands.rs
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

## API Integration

The app communicates with:

| Service | Default URL | Purpose |
|---------|-------------|---------|
| NovAIC Agent | `http://localhost:8080` | Chat API |
| VNC Server | `ws://localhost:5900` | VM display |

## License

MIT
