# PTY Wrapper

A Node.js-based PTY wrapper for terminal emulation in environments like Bun that don't natively support PTY.

## Overview

This project provides a simple wrapper around `node-pty` to enable terminal emulation capabilities when invoked from Bun or other runtimes that don't support PTY natively.

## Features

- Terminal emulation with proper colors and formatting
- Support for terminal resizing
- Seamless integration with existing code

## Installation

```bash
npm install
npm run build
```

## Usage

The PTY wrapper can be invoked directly:

```bash
node dist/index.js --cols=80 --rows=24 <command> [args...]
```

Or from your Bun application:

```typescript
const childProcess = spawn('node', [
  'path/to/pty-wrapper/dist/index.js',
  `--cols=${cols}`,
  `--rows=${rows}`,
  command,
  ...args
], {
  cwd: workingDir,
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env
});
```

## Terminal Resizing

To resize the terminal, send a message to the child process:

```typescript
if (childProcess.send) {
  childProcess.send({
    type: 'resize',
    cols: newCols,
    rows: newRows
  });
}
```

## License

ISC 
