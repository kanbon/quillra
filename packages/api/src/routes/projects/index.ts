import { Hono } from "hono";
import { chatRouter } from "./chat.js";
import { crudRouter } from "./crud.js";
import { filesRouter } from "./files.js";
import { presenceRouter } from "./presence.js";
import { previewRouter } from "./preview.js";
import { publishRouter } from "./publish.js";
import type { Variables } from "./shared.js";

export const projectsRouter = new Hono<{ Variables: Variables }>()
  .route("/", crudRouter)
  .route("/", publishRouter)
  .route("/", previewRouter)
  .route("/", chatRouter)
  .route("/", filesRouter)
  .route("/", presenceRouter);
