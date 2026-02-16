/**
 * Formats a date string into a human-readable format.
 * @param value - ISO date string to format
 * @returns Formatted date string or "Invalid Date" if parsing fails
 */
export function formatDateTime(value: string): string {
  if (typeof value !== 'string') return "Invalid Date";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "Invalid Date";
  
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * Formats a date string into a relative time format (e.g., "2 hours ago").
 * @param value - ISO date string to format
 * @returns Relative time string or "Invalid Date" if parsing fails
 */
export function formatRelativeTime(value: string): string {
  if (typeof value !== 'string') return "Invalid Date";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "Invalid Date";
  
  const diff = date.getTime() - Date.now();
  const seconds = Math.round(diff / 1000);
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

  const divisions: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, "seconds"],
    [60, "minutes"],
    [24, "hours"],
    [7, "days"],
    [4.34524, "weeks"],
    [12, "months"],
    [Number.POSITIVE_INFINITY, "years"],
  ];

  let duration = seconds;
  for (const [amount, unit] of divisions) {
    if (Math.abs(duration) < amount) {
      return rtf.format(duration, unit);
    }
    duration = Math.round(duration / amount);
  }
  return rtf.format(duration, "years");
}
