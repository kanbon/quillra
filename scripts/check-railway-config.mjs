import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../railway.json", import.meta.url), "utf8"));

assert.equal(config.build?.builder, "DOCKERFILE");
assert.equal(typeof config.build?.dockerfilePath, "string");
assert.ok(existsSync(new URL(`../${config.build.dockerfilePath}`, import.meta.url)));

assert.equal(typeof config.deploy?.healthcheckPath, "string");
assert.ok(config.deploy.healthcheckPath.startsWith("/"));
assert.ok(Number.isInteger(config.deploy?.healthcheckTimeout));
assert.ok(config.deploy.healthcheckTimeout > 0);
assert.equal(config.deploy?.restartPolicyType, "ON_FAILURE");
assert.ok(Number.isInteger(config.deploy?.restartPolicyMaxRetries));
assert.ok(config.deploy.restartPolicyMaxRetries >= 0);
assert.ok(Number.isInteger(config.deploy?.drainingSeconds));
assert.ok(config.deploy.drainingSeconds >= 0);

console.info("railway.json has valid Quillra deployment types");
