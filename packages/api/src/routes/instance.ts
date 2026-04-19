/**
 * Public instance metadata — whoever operates this Quillra instance.
 *
 * These values are set via the setup wizard or /admin and are used for:
 *  - the public /impressum page (required in DE/AT for commercial sites)
 *  - the footer of every outbound email
 *  - the branded client login page (instance name under "Powered by")
 *
 * No authentication required — the whole point is that it's public
 * contact info for the operator.
 */
import { Hono } from "hono";
import { getOrganizationInfo } from "../services/instance-settings.js";

export const instanceRouter = new Hono().get("/organization", async (c) => {
  return c.json(getOrganizationInfo());
});
