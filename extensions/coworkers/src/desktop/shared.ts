import { createContext } from 'react';

/** The coworker of the conversation the workspace shows, so the workspace transcript can name it. */
export const CoworkerContext = createContext<{ readonly name: string } | null>(null);
export function initials(label: string): string {
  const words = label.split(/[\s·._-]+/u).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}
