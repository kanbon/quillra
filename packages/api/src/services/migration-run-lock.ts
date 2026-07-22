const activeProjects = new Set<string>();

/** Claim one in-process migration run for a project until the returned release is called. */
export function claimMigrationRun(projectId: string): (() => void) | null {
  if (activeProjects.has(projectId)) return null;
  activeProjects.add(projectId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeProjects.delete(projectId);
  };
}
