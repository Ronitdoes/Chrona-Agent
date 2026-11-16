import { describe, expect, it } from "vitest";
import { encryptKey, decryptKey } from "./credentials";
describe("credential encryption", () => {
  const secret = "ab".repeat(32);
  it("uses fresh nonces and binds ciphertext to the owner and provider", () => {
    const first = encryptKey("private-key", "alice", "exa", secret);
    expect(first).not.toBe(encryptKey("private-key", "alice", "exa", secret));
    expect(first).not.toContain("private-key");
    expect(decryptKey(first, "alice", "exa", secret)).toBe("private-key");
    expect(() => decryptKey(first, "bob", "exa", secret)).toThrow();
    expect(() => decryptKey(first, "alice", "tavily", secret)).toThrow();
    expect(() => decryptKey(first, "alice", "exa", "cd".repeat(32))).toThrow();
    const tampered = Buffer.from(first, "base64");
    tampered[tampered.length - 1] ^= 1;
    expect(() =>
      decryptKey(tampered.toString("base64"), "alice", "exa", secret),
    ).toThrow();
  });
});
