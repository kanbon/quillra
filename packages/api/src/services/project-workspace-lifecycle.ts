type ProjectWriter = {
  cancel: () => void;
  cancelRequested: boolean;
  done: Promise<void>;
  release: () => void;
};

const activeWriters = new Map<string, Set<ProjectWriter>>();
const deletingProjects = new Set<string>();
const resetCounts = new Map<string, number>();
const PROJECT_WRITER_CANCEL_TIMEOUT_MS = 10_000;

function isBlocked(projectId: string): boolean {
  return deletingProjects.has(projectId) || (resetCounts.get(projectId) ?? 0) > 0;
}

function blockedMessage(projectId: string): string {
  return deletingProjects.has(projectId)
    ? "Project is being deleted"
    : "Project workspace is being reset";
}

function requestWriterCancellation(projectId: string, writer: ProjectWriter): void {
  if (writer.cancelRequested) return;
  writer.cancelRequested = true;
  try {
    writer.cancel();
  } catch (error) {
    console.warn(`[workspace] failed to cancel writer for ${projectId}:`, error);
  }
}

function cancelActiveWriters(projectId: string): void {
  for (const writer of activeWriters.get(projectId) ?? []) {
    requestWriterCancellation(projectId, writer);
  }
}

/**
 * Register a long-running process that may write inside a project's managed
 * repository. Deletion and repository resets cancel these leases and wait for
 * their consumers to finish before removing files.
 */
export function registerProjectWriter(projectId: string, cancel: () => void): () => void {
  if (isBlocked(projectId)) throw new Error(blockedMessage(projectId));

  let released = false;
  let resolveDone: (() => void) | undefined;
  const writer: ProjectWriter = {
    cancel,
    cancelRequested: false,
    done: new Promise<void>((resolve) => {
      resolveDone = resolve;
    }),
    release: () => {
      if (released) return;
      released = true;
      const writers = activeWriters.get(projectId);
      writers?.delete(writer);
      if (writers?.size === 0) activeWriters.delete(projectId);
      resolveDone?.();
    },
  };
  const writers = activeWriters.get(projectId) ?? new Set<ProjectWriter>();
  writers.add(writer);
  activeWriters.set(projectId, writers);

  // Close the tiny race where a delete/reset starts after the initial check
  // but before the writer enters the set.
  if (isBlocked(projectId)) {
    requestWriterCancellation(projectId, writer);
  }
  return writer.release;
}

export function blockProjectWritersForDeletion(projectId: string): void {
  deletingProjects.add(projectId);
  cancelActiveWriters(projectId);
}

export function unblockProjectWritersAfterFailedDeletion(projectId: string): void {
  deletingProjects.delete(projectId);
}

export function beginProjectWriterReset(projectId: string): void {
  resetCounts.set(projectId, (resetCounts.get(projectId) ?? 0) + 1);
  cancelActiveWriters(projectId);
}

export function endProjectWriterReset(projectId: string): void {
  const remaining = (resetCounts.get(projectId) ?? 1) - 1;
  if (remaining > 0) resetCounts.set(projectId, remaining);
  else resetCounts.delete(projectId);
}

/**
 * Request cancellation and report whether every captured writer released its
 * lease before the deadline. Callers decide whether a timed-out writer makes
 * their operation unsafe or whether deletion should proceed and be retried.
 */
export async function cancelAndWaitForProjectWriters(
  projectId: string,
  timeoutMs = PROJECT_WRITER_CANCEL_TIMEOUT_MS,
): Promise<boolean> {
  const writers = [...(activeWriters.get(projectId) ?? [])];
  if (writers.length === 0) return true;

  for (const writer of writers) {
    requestWriterCancellation(projectId, writer);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all(writers.map((writer) => writer.done)).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
