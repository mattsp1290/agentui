/** Two letters for an avatar, from the first two words of a label. */
export function initials(label: string): string {
  const words = label.split(/[\s·._-]+/u).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}
