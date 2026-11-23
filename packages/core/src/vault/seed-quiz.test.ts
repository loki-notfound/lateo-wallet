import { describe, expect, it } from "vitest";
import { evaluatePasswordStrength } from "./password.js";
import {
  normalizeSeedInput,
  pickSeedQuizIndices,
  splitMnemonicWords,
  validateMnemonicWordCount,
  verifySeedQuizAnswers
} from "./seed-quiz.js";

describe("password strength evaluation", () => {
  it("enforces minimum length and rejects weak passwords while scoring fair and strong tiers", () => {
    expect(evaluatePasswordStrength("short").valid).toBe(false);
    expect(evaluatePasswordStrength("short").level).toBe("too-short");
    expect(evaluatePasswordStrength("abcdefgh").level).toBe("too-short");
    expect(evaluatePasswordStrength("abcdefghij").level).toBe("weak");
    expect(evaluatePasswordStrength("abcdefghij").valid).toBe(false);
    expect(evaluatePasswordStrength("Abcdef1234").level).toBe("fair");
    expect(evaluatePasswordStrength("Abcdef1234").valid).toBe(true);
    expect(evaluatePasswordStrength("Correct-Horse-42!").level).toBe("strong");
    expect(evaluatePasswordStrength("Correct-Horse-42!").valid).toBe(true);
  });
});

describe("25-word mnemonic helpers and 3-word verification quiz", () => {
  const sampleWords = Array.from({ length: 25 }, (_, i) => `word${String(i + 1).padStart(2, "0")}`);
  const sampleSeed = sampleWords.join(" ");

  it("splits, normalizes, and checks 25-word counts", () => {
    expect(splitMnemonicWords(`  ${sampleSeed}  `).length).toBe(25);
    expect(validateMnemonicWordCount(sampleSeed)).toEqual({ valid: true, count: 25 });
    expect(validateMnemonicWordCount("one two three")).toEqual({ valid: false, count: 3 });
    expect(normalizeSeedInput("  Word01   WORD02\nword03  ")).toBe("word01 word02 word03");
  });

  it("picks 3 distinct sorted 1-based positions and verifies answers case-insensitively", () => {
    const draws = [24, 0, 24, 11]; // includes collision to test deduplication
    let cursor = 0;
    const indices = pickSeedQuizIndices(25, 3, () => draws[cursor++] ?? 5);
    expect(indices).toEqual([1, 12, 25]);

    const good = verifySeedQuizAnswers(sampleWords, indices, {
      1: " WORD01 ",
      12: "word12",
      25: "Word25"
    });
    expect(good).toEqual({ passed: true, wrongIndices: [] });

    const bad = verifySeedQuizAnswers(sampleWords, indices, {
      1: "word01",
      12: "wrong",
      25: ""
    });
    expect(bad).toEqual({ passed: false, wrongIndices: [12, 25] });
  });
});
