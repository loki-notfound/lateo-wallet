import { describe, expect, it } from "vitest";
import { validateNodeUrl } from "./node-url.js";

describe("node URL validation", () => {
  it("accepts remote HTTPS URLs and normalizes trailing slashes", () => {
    const res = validateNodeUrl("https://node.lateo.dev/");
    expect(res).toEqual({
      url: "https://node.lateo.dev",
      originPattern: "https://node.lateo.dev/*",
      host: "node.lateo.dev",
      isLocal: false
    });

    const withPath = validateNodeUrl("https://example.org:17767/rpc/");
    expect(withPath.url).toBe("https://example.org:17767/rpc");
    expect(withPath.originPattern).toBe("https://example.org/*");
    expect(withPath.isLocal).toBe(false);
  });

  it("allows plain HTTP only for localhost and 127.0.0.1", () => {
    const localIp = validateNodeUrl("http://127.0.0.1:17767");
    expect(localIp.isLocal).toBe(true);
    expect(localIp.originPattern).toBe("http://127.0.0.1/*");

    const localName = validateNodeUrl("http://localhost:17767/");
    expect(localName.isLocal).toBe(true);
    expect(localName.url).toBe("http://localhost:17767");
  });

  it("rejects remote plain HTTP, embedded credentials, query strings, and fragments", () => {
    expect(() => validateNodeUrl("http://node.lateo.dev")).toThrow(/HTTPS/i);
    expect(() => validateNodeUrl("http://192.168.1.50:17767")).toThrow(/HTTPS/i);
    expect(() => validateNodeUrl("https://user:pass@node.lateo.dev")).toThrow(/credentials/i);
    expect(() => validateNodeUrl("https://node.lateo.dev?x=1")).toThrow(/query/i);
    expect(() => validateNodeUrl("https://node.lateo.dev#frag")).toThrow(/fragment/i);
    expect(() => validateNodeUrl("ftp://node.lateo.dev")).toThrow(/https/i);
  });
});
