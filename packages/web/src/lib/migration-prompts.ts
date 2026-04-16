/**
 * Mirror of the kickoff prompt defined in
 * packages/api/src/services/astro-migration-skill.ts. Duplicated here
 * because the web bundle can't reach into the api package directly,
 * and a one-paragraph string is trivial to keep in sync. If you
 * update one, update the other — there's a comment in the server
 * file pointing here.
 */
export const ASTRO_MIGRATION_KICKOFF_PROMPT =
  "Migrate this repository to Astro. Replace the existing framework wholesale — delete the old build config, dependencies, and source layout. Preserve all user-visible content (text, images, routes, metadata). Use Astro content collections for anything collection-shaped. Keep existing React components as islands only where interactivity is actually needed. When you're done, ensure `npm install && npx astro build` succeeds, and reply with a short summary of what changed so the human knows what to review.";
