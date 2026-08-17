export function formatDuration(milliseconds: number): string {
  const safe = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'] as const;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatDate(value: string | number): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function compactShortcut(shortcut: string | undefined): string {
  if (!shortcut) return 'UNBOUND';
  return shortcut
    .replaceAll('MacCtrl', '⌃')
    .replaceAll('Command', '⌘')
    .replaceAll('Shift', '⇧')
    .replaceAll('Alt', '⌥')
    .replaceAll('Ctrl', '⌃')
    .replaceAll('+', '');
}
