const allowed = (process.env.ALLOWED_USER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (allowed.length === 0) {
  console.error(
    "[auth] ALLOWED_USER_IDS is empty. Bot will ignore every message until this is set.",
  );
}

export function isAllowed(userId: string | undefined): boolean {
  if (!userId) return false;
  return allowed.includes(userId);
}

export function allowedList(): readonly string[] {
  return allowed;
}
