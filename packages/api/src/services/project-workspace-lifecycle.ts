type ProjectWriter = {
  cancel: () => void;
  cancelRequested: boolean;
  done: Promise<void>;
  release: () => void;
  userId: string | null;
};

const activeWriters = new Map<string, Set<ProjectWriter>>();
const deletingProjects = new Set<string>();
const resetCounts = new Map<string, number>();
const userAuthorizationStates = new Map<
  string,
  Map<string, { epoch: number; blockingChanges: number }>
>();
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

function authorizationState(
  projectId: string,
  userId: string,
): { epoch: number; blockingChanges: number } {
  const projectStates =
    userAuthorizationStates.get(projectId) ??
    new Map<string, { epoch: number; blockingChanges: number }>();
  userAuthorizationStates.set(projectId, projectStates);
  const state = projectStates.get(userId) ?? { epoch: 0, blockingChanges: 0 };
  projectStates.set(userId, state);
  return state;
}

/** Capture this before reading project membership/role from the database. */
export function projectWriterAuthorizationEpoch(projectId: string, userId: string): number {
  return authorizationState(projectId, userId).epoch;
}

export type ProjectWriterAuthorization = {
  userId: string;
  expectedEpoch: number;
};

/**
 * Register a long-running process that may write inside a project's managed
 * repository. Deletion and repository resets cancel these leases and wait for
 * their consumers to finish before removing files.
 */
export function registerProjectWriter(
  projectId: string,
  cancel: () => void,
  authorization?: ProjectWriterAuthorization,
): () => void {
  if (isBlocked(projectId)) throw new Error(blockedMessage(projectId));
  if (authorization) {
    const state = authorizationState(projectId, authorization.userId);
    if (state.blockingChanges > 0 || state.epoch !== authorization.expectedEpoch) {
      throw new Error("Project authorization changed");
    }
  }

  let released = false;
  let resolveDone: (() => void) | undefined;
  const writer: ProjectWriter = {
    cancel,
    cancelRequested: false,
    userId: authorization?.userId ?? null,
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
  if (authorization) {
    const state = authorizationState(projectId, authorization.userId);
    if (state.blockingChanges > 0 || state.epoch !== authorization.expectedEpoch) {
      requestWriterCancellation(projectId, writer);
      writer.release();
      throw new Error("Project authorization changed");
    }
  }
  return writer.release;
}

/**
 * Invalidate an authorization decision and cancel every active writer for the
 * affected project member. Keep the returned guard open around the database
 * role/delete mutation so a new writer cannot register in the middle.
 *
 * The monotonically increasing epoch is deliberately not rolled back: a chat
 * request that read the old membership must re-check it even when the admin
 * mutation itself later fails.
 */
export function beginProjectWriterAuthorizationChange(
  projectId: string,
  userId: string,
): () => void {
  const state = authorizationState(projectId, userId);
  state.epoch += 1;
  state.blockingChanges += 1;

  for (const writer of activeWriters.get(projectId) ?? []) {
    if (writer.userId === userId) requestWriterCancellation(projectId, writer);
  }

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    state.blockingChanges = Math.max(0, state.blockingChanges - 1);
    // Invalidate snapshots captured while the database mutation was in
    // progress. Without this second bump, a chat request could observe the
    // new epoch and the old membership row, then register after the guard
    // closed with stale permissions.
    state.epoch += 1;
  };
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
