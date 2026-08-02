/** Small display helpers shared by the screens. */

export function initials(nameOrEmail: string): string {
  const name = nameOrEmail.includes('@') ? nameOrEmail.split('@')[0] : nameOrEmail;
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

/** `4F2A9C71E308…` → `4F2A 9C71 E308 …` (safety-number layout from the design). */
export function groupFingerprint(fp: string): string[] {
  const clean = fp.replace(/\s+/g, '').toUpperCase();
  return clean.match(/.{1,4}/g) ?? [];
}

export function shortFingerprint(fp: string): string {
  return groupFingerprint(fp).slice(0, 3).join(' · ');
}

export function displayName(address: string, name?: string): string {
  if (name) return name;
  const local = address.split('@')[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function relativeTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Very small RFC 5322 address parser — enough for `Name <a@b.c>` headers. */
export function parseAddress(header: string): { name?: string; address: string } {
  const match = header.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (match) return { name: match[1]?.trim() || undefined, address: match[2].trim().toLowerCase() };
  return { address: header.trim().toLowerCase() };
}

export function formatAddress(address: string, name?: string): string {
  return name ? `${name} <${address}>` : address;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
