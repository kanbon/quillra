import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_E2B_NODE_VERSION,
  E2B_COREPACK_VERSION,
  SECONDARY_E2B_NODE_VERSION,
  createE2BNodeRuntimePlan,
  resolveE2BNodeRuntimeRequest,
  resolveProjectE2BNodeRuntime,
} from "./e2b-node-runtime.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "quillra-node-runtime-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("E2B project Node runtime resolution", () => {
  it("uses the explicit sources in priority order and normalizes a Volta v-prefix", () => {
    expect(
      resolveE2BNodeRuntimeRequest({
        packageJson: JSON.stringify({
          volta: { node: "v22.18.0" },
          devEngines: { runtime: { name: "node", version: "24.1.0" } },
          engines: { node: ">=20" },
        }),
        nvmrc: "20.19.5",
        nodeVersion: "24.1.0",
        toolVersions: "nodejs 22.17.1",
      }),
    ).toEqual({
      source: "volta",
      selector: "22.18.0",
    });
  });

  it("normalizes current and named nvm LTS aliases to supported channels", () => {
    for (const [alias, selector] of [
      ["lts/*", SECONDARY_E2B_NODE_VERSION],
      ["lts/krypton", SECONDARY_E2B_NODE_VERSION],
      ["lts/jod", DEFAULT_E2B_NODE_VERSION],
      ["lts/iron", "20"],
    ]) {
      expect(resolveE2BNodeRuntimeRequest({ packageJson: "{}", nvmrc: `${alias}\n` })).toEqual({
        source: ".nvmrc",
        selector,
      });
    }
  });

  it("supports major and wildcard selectors from version files", () => {
    expect(resolveE2BNodeRuntimeRequest({ nvmrc: "# project runtime\nv22.23.1 # LTS" })).toEqual({
      source: ".nvmrc",
      selector: "22.23.1",
    });
    expect(resolveE2BNodeRuntimeRequest({ nodeVersion: "22.x" })).toEqual({
      source: ".node-version",
      selector: "22.x",
    });
    expect(resolveE2BNodeRuntimeRequest({ toolVersions: "python 3.13.0\nnodejs 22\n" })).toEqual({
      source: ".tool-versions",
      selector: "22",
    });
  });

  it("uses npm devEngines.runtime before advisory engines.node", () => {
    expect(
      resolveE2BNodeRuntimeRequest({
        packageJson: JSON.stringify({
          devEngines: {
            runtime: { name: "node", version: "24.4.0", onFail: "error" },
          },
          engines: { node: ">=20" },
        }),
      }),
    ).toEqual({
      source: "devEngines.runtime",
      selector: "24.4.0",
    });
  });

  it("accepts devEngines runtime arrays and semantic version ranges", () => {
    expect(
      resolveE2BNodeRuntimeRequest({
        packageJson: JSON.stringify({
          devEngines: {
            runtime: [{ name: "bun" }, { name: "node", version: "^22.11.0", onFail: "error" }],
          },
          engines: { node: ">=20" },
        }),
      }),
    ).toEqual({
      source: "devEngines.runtime",
      selector: "^22.11.0",
      preferredSelectors: [
        `^22.11.0 ${DEFAULT_E2B_NODE_VERSION}`,
        `^22.11.0 ${SECONDARY_E2B_NODE_VERSION}`,
      ],
    });
  });

  it("skips an invalid runtime range when another Node alternative is valid", () => {
    expect(
      resolveE2BNodeRuntimeRequest({
        packageJson: JSON.stringify({
          devEngines: {
            runtime: [
              { name: "node", version: "bogus10" },
              { name: "node", version: "22", onFail: "error" },
            ],
          },
        }),
      }),
    ).toEqual({
      source: "devEngines.runtime",
      selector: "22",
      preferredSelectors: [`22 ${DEFAULT_E2B_NODE_VERSION}`, `22 ${SECONDARY_E2B_NODE_VERSION}`],
    });
  });

  it.each(["warn", "ignore"] as const)(
    "falls through an unsupported advisory devEngines runtime with onFail=%s",
    (onFail) => {
      expect(
        resolveE2BNodeRuntimeRequest({
          packageJson: JSON.stringify({
            devEngines: { runtime: [{ name: "bun", onFail }] },
            engines: { node: ">=22.11 <23" },
          }),
        }),
      ).toMatchObject({
        source: "engines",
        selector: ">=22.11 <23",
      });
    },
  );

  it("fails when every required devEngines runtime alternative is unsupported", () => {
    expect(() =>
      resolveE2BNodeRuntimeRequest({
        packageJson: JSON.stringify({
          devEngines: {
            runtime: [{ name: "bun" }, { name: "deno", onFail: "error" }],
          },
        }),
      }),
    ).toThrow('Unsupported runtime "bun"');
  });

  it("keeps supported devEngines runtime alternatives together", () => {
    expect(
      resolveE2BNodeRuntimeRequest({
        packageJson: JSON.stringify({
          devEngines: {
            runtime: [
              { name: "node", version: "16" },
              { name: "node", version: "22", onFail: "error" },
            ],
          },
        }),
      }),
    ).toEqual({
      source: "devEngines.runtime",
      selector: "16 || 22",
      preferredSelectors: [
        `16 ${DEFAULT_E2B_NODE_VERSION} || 22 ${DEFAULT_E2B_NODE_VERSION}`,
        `16 ${SECONDARY_E2B_NODE_VERSION} || 22 ${SECONDARY_E2B_NODE_VERSION}`,
      ],
    });
  });

  it("falls back from an unsupported advisory Node runtime", () => {
    const request = resolveE2BNodeRuntimeRequest({
      packageJson: JSON.stringify({
        devEngines: {
          runtime: { name: "node", version: "16", onFail: "warn" },
        },
      }),
    });

    expect(request).toEqual({
      source: "devEngines.runtime",
      selector: "16",
      preferredSelectors: [`16 ${DEFAULT_E2B_NODE_VERSION}`, `16 ${SECONDARY_E2B_NODE_VERSION}`],
      fallbackOnUnsupported: true,
    });
    expect(
      createE2BNodeRuntimePlan(request as NonNullable<typeof request>).bootstrapCommand,
    ).toContain(`fallback_node='${DEFAULT_E2B_NODE_VERSION}'`);
  });

  it("prefers the exact Node 22 fallback when it satisfies an engines range", () => {
    expect(
      resolveE2BNodeRuntimeRequest({
        packageJson: JSON.stringify({
          engines: { node: "^20.19.0 || >=22.12.0" },
        }),
      }),
    ).toEqual({
      source: "engines",
      selector: "^20.19.0 || >=22.12.0",
      preferredSelectors: [
        `^20.19.0 ${DEFAULT_E2B_NODE_VERSION} || >=22.12.0 ${DEFAULT_E2B_NODE_VERSION}`,
        `^20.19.0 ${SECONDARY_E2B_NODE_VERSION} || >=22.12.0 ${SECONDARY_E2B_NODE_VERSION}`,
      ],
    });
  });

  it("falls back only JavaScript projects to the pinned Node 22 version", () => {
    expect(resolveE2BNodeRuntimeRequest({ packageJson: "{}" })).toEqual({
      source: "package-default",
      selector: DEFAULT_E2B_NODE_VERSION,
    });
    expect(resolveE2BNodeRuntimeRequest({})).toBeNull();
    expect(
      resolveE2BNodeRuntimeRequest({
        packageJson: JSON.stringify({ engines: { node: "*" } }),
      }),
    ).toMatchObject({
      source: "engines",
      selector: DEFAULT_E2B_NODE_VERSION,
    });
  });

  it("fails closed for URL and git selectors", () => {
    expect(() =>
      resolveE2BNodeRuntimeRequest({
        packageJson: "{}",
        nvmrc: "https://example.test/node.tar.xz",
      }),
    ).toThrow("Unsupported Node.js version selector");
    expect(() =>
      resolveE2BNodeRuntimeRequest({
        packageJson: JSON.stringify({ volta: { node: "git main" } }),
      }),
    ).toThrow("Unsupported Node.js version selector");
  });

  it("fails closed for moving current/default aliases", () => {
    for (const alias of ["node", "stable", "default"]) {
      expect(() =>
        resolveE2BNodeRuntimeRequest({
          packageJson: "{}",
          nvmrc: alias,
        }),
      ).toThrow("Unsupported Node.js version selector");
    }
  });

  it("does not follow a repository symlink while reading runtime metadata", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(path.join(root, "package.json"), "{}");
    await writeFile(path.join(outside, "version"), "24.4.0");
    await symlink(path.join(outside, "version"), path.join(root, ".nvmrc"));

    await expect(resolveProjectE2BNodeRuntime(root)).resolves.toMatchObject({
      source: "package-default",
      selector: DEFAULT_E2B_NODE_VERSION,
    });
  });

  it("reads the runtime metadata from the supplied local project root", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "nested"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ engines: { node: ">=22.11 <23" } }),
    );

    await expect(resolveProjectE2BNodeRuntime(root)).resolves.toMatchObject({
      source: "engines",
      selector: ">=22.11 <23",
      pathPrefix: expect.stringMatching(
        /^\/home\/quillra-project\/\.quillra\/node-runtimes\/[0-9a-f]{32}\/bin$/,
      ),
    });
  });

  it("can apply the pinned preview runtime to static projects without package.json", async () => {
    const root = await temporaryRoot();

    await expect(
      resolveProjectE2BNodeRuntime(root, { defaultWhenMissing: true }),
    ).resolves.toMatchObject({
      source: "preview-default",
      selector: DEFAULT_E2B_NODE_VERSION,
    });
  });
});

describe("E2B project Node runtime bootstrap", () => {
  it("builds a deterministic idempotent bootstrap from the official checked archive", () => {
    const request = {
      source: "package-default" as const,
      selector: DEFAULT_E2B_NODE_VERSION,
    };
    const first = createE2BNodeRuntimePlan(request);
    const second = createE2BNodeRuntimePlan(request);

    expect(first.runtimeId).toBe(second.runtimeId);
    expect(first.runtimeRoot).toBe(
      `/home/quillra-project/.quillra/node-runtimes/${first.runtimeId}`,
    );
    expect(first.pathPrefix).toBe(`${first.runtimeRoot}/bin`);
    expect(first.environment).toEqual({
      COREPACK_DEFAULT_TO_LATEST: "0",
      COREPACK_ENABLE_AUTO_PIN: "0",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      COREPACK_ENV_FILE: "0",
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      COREPACK_HOME: `${first.runtimeRoot}/corepack-cache`,
    });
    expect(first.bootstrapCommand).toContain(
      'distribution_url="https://nodejs.org/dist/v${resolved}"',
    );
    expect(first.bootstrapCommand).toContain(
      "/usr/bin/curl --fail --silent --show-error --location",
    );
    expect(first.bootstrapCommand).toContain("SHASUMS256.txt");
    expect(first.bootstrapCommand).toContain('/usr/bin/sha256sum "$staging/$archive_name"');
    expect(first.bootstrapCommand).toContain('/usr/bin/tar -xJf "$staging/$archive_name"');
    expect(first.bootstrapCommand).toContain(`corepack_version='${E2B_COREPACK_VERSION}'`);
    expect(first.bootstrapCommand).toContain("fallback_node=''");
    expect(first.bootstrapCommand).toContain('"corepack@$corepack_version"');
    expect(first.bootstrapCommand).toContain('[ -f "$marker" ]');
    expect(first.bootstrapCommand).toContain("exit 0");
    expect(first.bootstrapCommand).not.toContain(process.cwd());
  });

  it("versions runtime directories when the requested project runtime changes", () => {
    const node22 = createE2BNodeRuntimePlan({
      source: ".nvmrc",
      selector: "22.23.1",
    });
    const node24 = createE2BNodeRuntimePlan({
      source: ".nvmrc",
      selector: "24.4.0",
    });

    expect(node22.runtimeId).not.toBe(node24.runtimeId);
    expect(node22.pathPrefix).not.toBe(node24.pathPrefix);
  });
});
