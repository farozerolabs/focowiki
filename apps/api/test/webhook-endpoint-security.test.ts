import { describe, expect, it } from "vitest";
import {
  isPublicWebhookAddress,
  normalizePublicWebhookUrl
} from "../src/storage-vnext/webhook/endpoint-security.js";

describe("webhook endpoint security", () => {
  it.each([
    "https://127.0.0.1/hook",
    "https://10.0.0.8/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/hook",
    "https://service.local/hook",
    "https://user:password@hooks.example.com/hook"
  ])("rejects an endpoint that can directly address private services: %s", (value) => {
    expect(() => normalizePublicWebhookUrl(value)).toThrow();
  });

  it("normalizes a public HTTPS endpoint without changing its request target", () => {
    expect(normalizePublicWebhookUrl("https://hooks.example.com/events?source=docs"))
      .toBe("https://hooks.example.com/events?source=docs");
  });

  it.each([
    ["8.8.8.8", true],
    ["127.0.0.1", false],
    ["192.168.1.2", false],
    ["169.254.169.254", false],
    ["2001:4860:4860::8888", true],
    ["::1", false],
    ["fc00::1", false],
    ["fe80::1", false],
    ["2001:db8::1", false]
  ])("classifies resolved address %s", (address, expected) => {
    expect(isPublicWebhookAddress(address)).toBe(expected);
  });
});
