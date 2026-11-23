/**
 * Helpers for the 25-word mnemonic display and 3-word backup verification quiz.
 */
export function splitMnemonicWords(seed: string): readonly string[] {
  return seed
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export function normalizeSeedInput(seed: string): string {
  return splitMnemonicWords(seed).join(" ").toLowerCase();
}

export function validateMnemonicWordCount(seed: string): {
  readonly valid: boolean;
  readonly count: number;
} {
  const words = splitMnemonicWords(seed);
  return { valid: words.length === 25, count: words.length };
}

/**
 * Pick `count` distinct 1-based word positions in `1..wordCount`, sorted ascending.
 */
export function pickSeedQuizIndices(
  wordCount = 25,
  count = 3,
  nextUint32?: () => number
): readonly number[] {
  if (count <= 0 || count > wordCount) {
    throw new RangeError("Invalid quiz index count");
  }
  const draw =
    nextUint32 ??
    (() => {
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      return buf[0]!;
    });

  const limit = Math.floor(0x1_0000_0000 / wordCount) * wordCount;
  const picked = new Set<number>();
  while (picked.size < count) {
    const sample = draw() >>> 0;
    if (sample >= limit) continue;
    picked.add((sample % wordCount) + 1);
  }
  return Array.from(picked).sort((a, b) => a - b);
}

/**
 * Verify user-entered quiz answers against 1-based word positions.
 */
export function verifySeedQuizAnswers(
  words: readonly string[],
  indices: readonly number[],
  answers: Readonly<Record<number, string>>
): { readonly passed: boolean; readonly wrongIndices: readonly number[] } {
  const wrongIndices: number[] = [];
  for (const pos of indices) {
    const expected = words[pos - 1]?.trim().toLowerCase() ?? "";
    const actual = (answers[pos] ?? "").trim().toLowerCase();
    if (!expected || actual !== expected) {
      wrongIndices.push(pos);
    }
  }
  return { passed: wrongIndices.length === 0, wrongIndices };
}
