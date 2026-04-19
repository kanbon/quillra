/**
 * Single source of truth for every framework Quillra knows how to edit
 * + live-preview. Anything not in this registry is unsupported and the
 * connect flow refuses it with a friendly message.
 *
 * Both the API (detection, dev-command resolution, image upload routing)
 * AND the web client (connect modal, framework badge) read from here. The
 * web client gets it via GET /api/frameworks so we never duplicate the list.
 */

export type FrameworkId =
  | "astro"
  | "next"
  | "nuxt"
  | "gatsby"
  | "sveltekit"
  | "remix"
  | "eleventy"
  | "vite"
  | "cra"
  | "docusaurus"
  | "vitepress"
  | "qwik"
  | "solidstart"
  | "hugo"
  | "jekyll";

export type FrameworkDef = {
  id: FrameworkId;
  /** Display name shown in the UI ("Astro", "Next.js", etc.) */
  label: string;
  /** simple-icons.org slug, used for the CDN logo at https://cdn.simpleicons.org/{slug} */
  iconSlug: string;
  /** Brand hex (matches the framework's primary brand color) */
  color: string;
  /** Where new image/asset uploads should be written, relative to repo root */
  assetsDir: string;
  /** True if the framework optimises images at build time (Astro, Next, Nuxt, Gatsby) */
  optimizes: boolean;
  /** A short blurb shown under the framework name on the connect modal */
  blurb: string;
  /** How to detect this framework from a package.json, match if ANY listed dep is present */
  packageDeps?: string[];
  /** Or detect by config file at the repo root (for non-Node frameworks) */
  configFiles?: string[];
  /** Per-framework dev command. {port} is replaced at spawn time. */
  devCommand: { binary: string; args: string[] };
};

const FRAMEWORKS: FrameworkDef[] = [
  {
    id: "astro",
    label: "Astro",
    iconSlug: "astro",
    color: "#FF5D01",
    assetsDir: "src/assets",
    optimizes: true,
    blurb: "Modern static + SSR sites with islands and content collections.",
    packageDeps: ["astro"],
    devCommand: { binary: "npx", args: ["astro", "dev", "--host", "0.0.0.0", "--port", "{port}"] },
  },
  {
    id: "next",
    label: "Next.js",
    iconSlug: "nextdotjs",
    color: "#000000",
    assetsDir: "public/images",
    optimizes: true,
    blurb: "React framework for full-stack apps and websites.",
    packageDeps: ["next"],
    devCommand: { binary: "npx", args: ["next", "dev", "-H", "0.0.0.0", "-p", "{port}"] },
  },
  {
    id: "nuxt",
    label: "Nuxt",
    iconSlug: "nuxt",
    color: "#00DC82",
    assetsDir: "public/images",
    optimizes: true,
    blurb: "Vue framework for full-stack apps and websites.",
    packageDeps: ["nuxt", "nuxt3"],
    devCommand: { binary: "npx", args: ["nuxt", "dev", "--host", "0.0.0.0", "--port", "{port}"] },
  },
  {
    id: "gatsby",
    label: "Gatsby",
    iconSlug: "gatsby",
    color: "#663399",
    assetsDir: "src/images",
    optimizes: true,
    blurb: "React-based static site generator with rich data layer.",
    packageDeps: ["gatsby"],
    devCommand: {
      binary: "npx",
      args: ["gatsby", "develop", "--host", "0.0.0.0", "--port", "{port}"],
    },
  },
  {
    id: "sveltekit",
    label: "SvelteKit",
    iconSlug: "svelte",
    color: "#FF3E00",
    assetsDir: "static/images",
    optimizes: false,
    blurb: "Svelte framework for building fast, modern web apps.",
    packageDeps: ["@sveltejs/kit"],
    devCommand: { binary: "npx", args: ["vite", "dev", "--host", "0.0.0.0", "--port", "{port}"] },
  },
  {
    id: "remix",
    label: "Remix",
    iconSlug: "remix",
    color: "#000000",
    assetsDir: "public/images",
    optimizes: false,
    blurb: "React-based full-stack framework focused on web standards.",
    packageDeps: ["remix", "@remix-run/react", "@remix-run/dev"],
    devCommand: { binary: "npx", args: ["remix", "dev"] },
  },
  {
    id: "eleventy",
    label: "Eleventy",
    iconSlug: "eleventy",
    color: "#0E0E0E",
    assetsDir: "src/images",
    optimizes: false,
    blurb: "Simpler static site generator. Pure Node, no JS framework lock-in.",
    packageDeps: ["@11ty/eleventy"],
    devCommand: { binary: "npx", args: ["@11ty/eleventy", "--serve", "--port={port}"] },
  },
  {
    id: "vite",
    label: "Vite",
    iconSlug: "vite",
    color: "#646CFF",
    assetsDir: "public/images",
    optimizes: false,
    blurb: "Frontend tooling for React, Vue, Svelte, Solid, Lit, Preact and more.",
    packageDeps: ["vite", "@vitejs/plugin-react", "@vitejs/plugin-vue", "@vitejs/plugin-svelte"],
    devCommand: { binary: "npx", args: ["vite", "--host", "0.0.0.0", "--port", "{port}"] },
  },
  {
    id: "cra",
    label: "React (CRA)",
    iconSlug: "react",
    color: "#61DAFB",
    assetsDir: "public/images",
    optimizes: false,
    blurb: "Create React App project. Classic react-scripts dev server.",
    packageDeps: ["react-scripts"],
    devCommand: {
      // CRA reads PORT from env; pass it inline via sh -c so it binds to our port
      binary: "sh",
      args: ["-c", "HOST=0.0.0.0 PORT={port} BROWSER=none npx react-scripts start"],
    },
  },
  {
    id: "docusaurus",
    label: "Docusaurus",
    iconSlug: "docusaurus",
    color: "#3ECC5F",
    assetsDir: "static/img",
    optimizes: false,
    blurb: "React documentation sites with built-in versioning and i18n.",
    packageDeps: ["@docusaurus/core", "@docusaurus/preset-classic"],
    devCommand: {
      binary: "npx",
      args: ["docusaurus", "start", "--host", "0.0.0.0", "--port", "{port}"],
    },
  },
  {
    id: "vitepress",
    label: "VitePress",
    iconSlug: "vite",
    color: "#646CFF",
    assetsDir: "docs/public",
    optimizes: false,
    blurb: "Vite-powered static documentation site generator.",
    packageDeps: ["vitepress"],
    devCommand: {
      binary: "npx",
      args: ["vitepress", "dev", "--host", "0.0.0.0", "--port", "{port}"],
    },
  },
  {
    id: "qwik",
    label: "Qwik",
    iconSlug: "qwik",
    color: "#AC7EF4",
    assetsDir: "public/images",
    optimizes: false,
    blurb: "Resumable, instant-loading framework, zero hydration.",
    packageDeps: ["@builder.io/qwik", "@builder.io/qwik-city"],
    devCommand: { binary: "npx", args: ["qwik", "dev", "--host", "0.0.0.0", "--port", "{port}"] },
  },
  {
    id: "solidstart",
    label: "SolidStart",
    iconSlug: "solid",
    color: "#2C4F7C",
    assetsDir: "public/images",
    optimizes: false,
    blurb: "Solid.js full-stack framework with file-based routing.",
    packageDeps: ["@solidjs/start", "solid-start"],
    devCommand: { binary: "npx", args: ["vinxi", "dev", "--host", "0.0.0.0", "--port", "{port}"] },
  },
  {
    id: "hugo",
    label: "Hugo",
    iconSlug: "hugo",
    color: "#FF4088",
    assetsDir: "static/images",
    optimizes: false,
    blurb: "The world's fastest framework for building static websites. Go-based.",
    configFiles: ["hugo.toml", "hugo.yaml", "config.toml", "config.yaml"],
    devCommand: { binary: "hugo", args: ["server", "--bind", "0.0.0.0", "--port", "{port}"] },
  },
  {
    id: "jekyll",
    label: "Jekyll",
    iconSlug: "jekyll",
    color: "#CC0000",
    assetsDir: "assets/images",
    optimizes: false,
    blurb: "Ruby-based static site generator. The original GitHub Pages engine.",
    configFiles: ["_config.yml", "_config.yaml"],
    devCommand: {
      binary: "bundle",
      args: ["exec", "jekyll", "serve", "--host", "0.0.0.0", "--port", "{port}"],
    },
  },
];

export const FRAMEWORK_REGISTRY: ReadonlyArray<FrameworkDef> = FRAMEWORKS;

export function getFrameworkById(id: string): FrameworkDef | null {
  return FRAMEWORKS.find((f) => f.id === id) ?? null;
}

/** Detect a framework from a parsed package.json + the list of files at the repo root */
export function detectFromManifest(opts: {
  packageJson?: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null;
  rootFiles?: string[];
}): FrameworkDef | null {
  const pkg = opts.packageJson;
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : null;

  // 1) Try Node-based frameworks first (package.json deps)
  if (deps) {
    for (const f of FRAMEWORKS) {
      if (!f.packageDeps) continue;
      if (f.packageDeps.some((d) => d in deps)) return f;
    }
  }

  // 2) Try config-file-based frameworks (Hugo, Jekyll, etc.)
  const files = new Set((opts.rootFiles ?? []).map((s) => s.toLowerCase()));
  for (const f of FRAMEWORKS) {
    if (!f.configFiles) continue;
    if (f.configFiles.some((c) => files.has(c.toLowerCase()))) return f;
  }

  return null;
}

/** Public projection, what we expose to the web client via /api/frameworks */
export function publicFrameworkList() {
  return FRAMEWORKS.map((f) => ({
    id: f.id,
    label: f.label,
    iconSlug: f.iconSlug,
    color: f.color,
    blurb: f.blurb,
    optimizes: f.optimizes,
  }));
}
