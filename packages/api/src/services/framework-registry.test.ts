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
      expect(detectFromManifest({ packageJson: null })).toBeNull();
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

    it("uses package dependencies as the detection source", () => {
      const def = detectFromManifest({
        packageJson: { dependencies: { next: "^14" } },
      });
      expect(def?.id).toBe("next");
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

  it("keeps every managed preview server on the loopback interface", () => {
    for (const framework of FRAMEWORK_REGISTRY) {
      expect(framework.devCommand.args.join(" ")).not.toContain("0.0.0.0");
    }
  });

  it("prevents direct Vite preview commands from silently changing ports", () => {
    for (const id of ["sveltekit", "vite", "vitepress"] as const) {
      expect(getFrameworkById(id)?.devCommand.args).toContain("--strictPort");
    }
  });
});
