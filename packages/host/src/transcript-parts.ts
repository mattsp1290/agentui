export function messageParts(text: string): string[] {
  const parts: string[] = [];
  let start = 0, offset = 0, bytes = 0;
  for (const character of text) {
    const cost = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + cost > 24_000) {
      parts.push(text.slice(start, offset));
      start = offset; bytes = 0;
    }
    bytes += cost; offset += character.length;
  }
  parts.push(text.slice(start));
  return parts;
}
