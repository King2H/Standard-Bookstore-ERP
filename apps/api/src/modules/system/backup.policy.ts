/**
 * Backup rules (#244, owner decisions 1a, 3a): when the backup service runs,
 * which backup files it keeps, and when Admin and Super_Admin are warned.
 * Pure functions.
 */

const HOUR = 3_600_000;
/** bookstore-YYYYMMDD-HHMMSS.bmsbak: the files the service writes, and the only ones it ever deletes. */
const NAME = /^bookstore-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.bmsbak$/;

export function backupFileName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `bookstore-${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}.bmsbak`;
}

/** Monday of the ISO week of a UTC day, as YYYY-MM-DD: the week a backup counts in. */
function weekOf(at: Date): string {
  const monday = new Date(at.getTime() - ((at.getUTCDay() + 6) % 7) * 24 * HOUR);
  return monday.toISOString().slice(0, 10);
}

/**
 * Of the files in the backup folder, those to delete: the service's own
 * backups beyond the newest `daily`, except the newest of each of the
 * newest `weekly` weeks. Any other file is left alone.
 */
export function backupsToDelete(names: string[], keep: { daily: number; weekly: number }): string[] {
  const backups = names
    .map((name) => ({ name, m: NAME.exec(name) }))
    .filter((b): b is { name: string; m: RegExpExecArray } => b.m !== null)
    .map(({ name, m }) => ({ name, at: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) }))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const kept = new Set(backups.slice(0, keep.daily).map((b) => b.name));
  const weeks = new Set<string>();
  for (const b of backups) {
    const week = weekOf(b.at);
    if (weeks.has(week)) continue;
    if (weeks.size >= keep.weekly) break;
    weeks.add(week);
    kept.add(b.name);
  }
  return backups.filter((b) => !kept.has(b.name)).map((b) => b.name);
}

/** The offset of a time zone from UTC at an instant, in milliseconds. */
function zoneOffset(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The next time it is `hhmm` (HH:MM) in the shop's time zone, after `now`. */
export function nextRunAt(now: Date, hhmm: string, timeZone: string): Date {
  const [hour, minute] = hhmm.split(':').map(Number);
  const local = new Date(now.getTime() + zoneOffset(now, timeZone));
  for (let days = 0; days < 3; days++) {
    const wallClock = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour, minute);
    const at = new Date(wallClock - zoneOffset(new Date(wallClock), timeZone));
    if (at.getTime() > now.getTime()) return at;
  }
  throw new Error(`No next run for ${hhmm} in ${timeZone}`);
}

/** At start, a backup runs if the last good one is older than a day: a PC off at night still gets one a day. */
export function shouldRunAtStart(lastSuccessAt: Date | null, now: Date): boolean {
  return lastSuccessAt === null || now.getTime() - lastSuccessAt.getTime() > 24 * HOUR;
}

/** Admin and Super_Admin are warned when there has been no good backup for 26 hours (3a). */
export function isStale(lastSuccessAt: Date | null, now: Date): boolean {
  return lastSuccessAt === null || now.getTime() - lastSuccessAt.getTime() > 26 * HOUR;
}
