import * as pty from 'node-pty';
import { spawn } from 'child_process';

/**
 * A simple wrapper around node-pty to provide terminal emulation capabilities
 * when invoked from Bun or other runtimes that don't support PTY.
 *
 * Arguments:
 * - First arg: command to run
 * - Remaining args: arguments to the command
 * - Special argument --cols=N: set terminal columns
 * - Special argument --rows=N: set terminal rows
 */

// Extract cols and rows from arguments
let cols = 80;
let rows = 24;
const args = process.argv.slice(2);
const filteredArgs: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg.startsWith('--cols=')) {
    cols = parseInt(arg.substring(7), 10);
  } else if (arg.startsWith('--rows=')) {
    rows = parseInt(arg.substring(7), 10);
  } else {
    filteredArgs.push(arg);
  }
}

// First argument is the command to run
const command = filteredArgs[0];

// Remaining arguments are passed to the command
const commandArgs = filteredArgs.slice(1);

if (!command) {
  process.exit(1);
}

// Create PTY instance
const ptyProcess = pty.spawn(command, commandArgs, {
  name: 'xterm-color',
  cols,
  rows,
  cwd: process.cwd(),
  env: process.env as { [key: string]: string }
});

// Forward data from PTY to stdout
ptyProcess.onData(data => {
  process.stdout.write(data);
});

// Forward data from stdin to PTY
process.stdin.on('data', (data) => {
  ptyProcess.write(data.toString());
});

// Forward resize events
process.on('message', (message: any) => {
  if (message && message.type === 'resize' && message.cols && message.rows) {
    ptyProcess.resize(message.cols, message.rows);
  }
});

// Handle exit
ptyProcess.onExit(({ exitCode }) => {
  process.exit(exitCode);
});

// Handle signals
process.on('SIGTERM', () => {
  ptyProcess.kill();
});

process.on('SIGINT', () => {
  ptyProcess.kill();
});
