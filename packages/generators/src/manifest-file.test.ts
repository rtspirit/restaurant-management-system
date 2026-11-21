import { describe, expect, it } from "vitest";
import { renderManifestFile } from "./index.js";

describe("the manifest file the platform writes", () => {
  it("holds the parsed manifest as data and imports only the SDK", () => {
    const text = renderManifestFile({ name: "Vendors", models: [{ use: "vendor", access: "write" }, { use: "parent.locations", access: "read" }] });
    expect(text).toContain('import { defineApp } from "@rms/sdk";');
    expect(text).toContain('"use": "vendor"');
    expect(text.match(/^import /gm)).toHaveLength(1);
  });

  it("refuses a manifest that does not parse, so nothing hostile is ever written into code", () => {
    expect(() => renderManifestFile({ name: "X", models: [{ use: "parent.staff", access: "write" }] })).toThrow();
    expect(() => renderManifestFile({ name: "X", models: [{ use: "vendor; drop table x", access: "read" }] } as never)).toThrow();
    expect(() => renderManifestFile({ name: "X", evil: "`${process.env.SECRET}`" } as never)).toThrow();
  });

  it("writes text values as quoted data", () => {
    const text = renderManifestFile({ name: 'A"); import("fs"); ("' });
    expect(text).toContain(String.raw`"name": "A\"); import(\"fs\"); (\""`);
  });
});
