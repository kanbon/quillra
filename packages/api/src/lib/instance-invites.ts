import { and, gt, isNull } from "drizzle-orm";
import { instanceInvites } from "../db/app-schema.js";
import { db } from "../db/index.js";
import { emailEquals } from "./email.js";

/** Resolve only an unaccepted, unexpired invite, including legacy mixed-case rows. */
export async function findValidPendingInstanceInvite(email: string) {
  const [invite] = await db
    .select()
    .from(instanceInvites)
    .where(
      and(
        emailEquals(instanceInvites.email, email),
        isNull(instanceInvites.acceptedAt),
        gt(instanceInvites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invite ?? null;
}
