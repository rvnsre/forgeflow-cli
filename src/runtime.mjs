import { EOL } from 'node:os';
import { delimiter } from 'node:path';
import { arch, platform, versions } from 'node:process';
import { ConfigurationError } from './errors.mjs';

export const MIN_NODE_MAJOR = 20;
export const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);

export function runtimeInfo() {
  return {
    node: versions.node,
    nodeMajor: Number(versions.node.split('.')[0]),
    platform,
    arch,
    pathDelimiter: delimiter,
    lineEnding: EOL === '\r\n' ? 'CRLF' : 'LF',
    fetchAvailable: typeof fetch === 'function',
    abortSignalAvailable: typeof AbortController === 'function',
    structuredCloneAvailable: typeof structuredClone === 'function',
    shell: platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh'),
  };
}

export function assertSupportedRuntime(info = runtimeInfo()) {
  if (info.nodeMajor < MIN_NODE_MAJOR) {
    throw new ConfigurationError(`Node.js ${MIN_NODE_MAJOR} or newer is required; detected ${info.node}.`);
  }
  if (!SUPPORTED_PLATFORMS.includes(info.platform)) {
    throw new ConfigurationError(`Unsupported operating system: ${info.platform}. Use Windows, macOS, or Linux.`);
  }
  if (!info.fetchAvailable) throw new ConfigurationError('Native fetch is unavailable. Upgrade to Node.js 20 or newer.');
  return info;
}

export function formatDuration(milliseconds) {
  const ms = Math.max(0, Math.floor(Number(milliseconds) || 0));
  if (ms < 1_000) return `${ms} ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = 0;
  while (amount >= 1_024 && index < units.length - 1) { amount /= 1_024; index += 1; }
  return `${index === 0 ? amount : amount.toFixed(1)} ${units[index]}`;
}

export function isWindows(info = runtimeInfo()) { return info.platform === 'win32'; }
export function isMacOS(info = runtimeInfo()) { return info.platform === 'darwin'; }
export function isLinux(info = runtimeInfo()) { return info.platform === 'linux'; }

export function normalizeEnvironmentKey(key, info = runtimeInfo()) {
  return isWindows(info) ? String(key).toUpperCase() : String(key);
}

export function mergeEnvironment(base, overlay, info = runtimeInfo()) {
  const merged = new Map();
  for (const [key, value] of Object.entries(base ?? {})) merged.set(normalizeEnvironmentKey(key, info), [key, value]);
  for (const [key, value] of Object.entries(overlay ?? {})) merged.set(normalizeEnvironmentKey(key, info), [key, value]);
  return Object.fromEntries([...merged.values()]);
}
