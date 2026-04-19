import { describe, expect, it } from "vitest";
import {
  FRAMEWORK_REGISTRY,
  detectFromManifest,
  getFrameworkById,
  publicFrameworkList,
} from "./framework-registry.js";

describe("framework-registry", () => {
  describe("detectFromManifest", () => {
    it("returns null for an empty manifest", () => {
      expect(detectFromManifest({})).toBeNull();
      expect(detectFromManifest({ packageJson: null, rootFiles: [] })).toBeNull();
    });

    it("detects Astro from a dependency", () => {
      const def = detectFromManifest({
        packageJson: { dependencies: { astro: "^4.0.0" } },
      });
      expect(def?.id).toBe("astro");
    });

    it("detects Next.js from a devDependency", () => {
      const def = detectFromManifest({
        packageJson: { devDependencies: { next: "^14" } },
      });
      expect(def?.id).toBe("next");
    });

    it("prefers package.json deps over config files", () => {
      // A repo with both next in deps AND hugo.toml at the root should pick Next.
      const def = detectFromManifest({
        packageJson: { dependencies: { next: "^14" } },
        rootFiles: ["hugo.toml"],
      });
      expect(def?.id).toBe("next");
    });

    it("falls back to config-file detection when package.json is absent", () => {
      const def = detectFromManifest({ rootFiles: ["hugo.toml"] });
      expect(def?.id).toBe("hugo");
    });

    it("detects Jekyll from its config file, case-insensitively", () => {
      expect(detectFromManifest({ rootFiles: ["_config.yml"] })?.id).toBe("jekyll");
      expect(detectFromManifest({ rootFiles: ["_CONFIG.YML"] })?.id).toBe("jekyll");
    });

    it("returns null for an unknown Node project", () => {
      const def = detectFromManifest({
        packageJson: { dependencies: { express: "^4" } },
      });
      expect(def).toBeNull();
    });
  });

  describe("getFrameworkById", () => {
    it("returns the definition for a known id", () => {
      expect(getFrameworkById("astro")?.label).toBe("Astro");
    });

    it("returns null for an unknown id", () => {
      expect(getFrameworkById("made-up")).toBeNull();
    });
  });

  describe("publicFrameworkList", () => {
    it("exposes every entry in the registry", () => {
      expect(publicFrameworkList()).toHaveLength(FRAMEWORK_REGISTRY.length);
    });

    it("does not leak the dev command shape into public output", () => {
      const first = publicFrameworkList()[0];
      expect(first).not.toHaveProperty("devCommand");
      expect(first).not.toHaveProperty("packageDeps");
    });
  });
});
