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

    it("detects a plain Vite project", () => {
      const def = detectFromManifest({
        packageJson: { devDependencies: { vite: "^7" } },
      });
      expect(def?.id).toBe("vite");
    });

    it("prefers Qwik over its generic Vite dependency", () => {
      const def = detectFromManifest({
        packageJson: {
          devDependencies: {
            "@builder.io/qwik": "^1.15",
            vite: "^7",
          },
        },
      });
      expect(def?.id).toBe("qwik");
    });

    it("prefers SolidStart over its generic Vite dependency", () => {
      const def = detectFromManifest({
        packageJson: {
          dependencies: { "@solidjs/start": "^1" },
          devDependencies: { vite: "^7" },
        },
      });
      expect(def?.id).toBe("solidstart");
    });

    it("prefers every specific Vite-based registry match over generic Vite", () => {
      for (const [dependency, expected] of [
        ["@sveltejs/kit", "sveltekit"],
        ["@remix-run/dev", "remix"],
        ["vitepress", "vitepress"],
      ] as const) {
        const def = detectFromManifest({
          packageJson: { devDependencies: { [dependency]: "latest", vite: "^7" } },
        });
        expect(def?.id).toBe(expected);
      }
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

  it("uses Eleventy's installed binary name across package managers", () => {
    expect(getFrameworkById("eleventy")?.devCommand.args[0]).toBe("eleventy");
  });
});
