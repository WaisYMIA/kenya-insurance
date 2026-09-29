import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { SqliteRepository } from "./repositories/sqlite-repository.ts";
import { OwnerNotifier } from "./adapters/notification-adapter.ts";
import { createHandler } from "./router.ts";
import { hashPassword, usingEphemeralSecret } from "./auth.ts";

const repo = new SqliteRepository(config.dbPath);

// Bootstrap the first admin. Never hard-code a password: use ADMIN_PASSWORD or a generated one shown once.
if ((await repo.countStaff()) === 0) {
  const generated = !config.adminPassword;
  const password = config.adminPassword || randomBytes(9).toString("base64url");
  await repo.createStaff({ email: config.adminEmail, name: "Administrator", role: "ADMIN", password_hash: hashPassword(password) });
  console.log(`\n=== INITIAL ADMIN CREATED ===\nemail: ${config.adminEmail}\n${generated ? `password: ${password}   (shown once — change/replace via POST /v1/admin/users)` : "password: taken from ADMIN_PASSWORD"}\n=============================\n`);
}
if (usingEphemeralSecret) console.warn("WARNING: AUTH_SECRET not set — login tokens are invalidated on every restart. Set AUTH_SECRET in production.");
if (config.corsOrigin === "*") console.warn("WARNING: CORS_ORIGIN is '*'. Set it to your site's origin in production.");

const server = createServer(createHandler(repo, new OwnerNotifier()));
server.listen(config.port, () => console.log(`kenya-insurance-api listening on http://localhost:${config.port} (owner alerts -> ${config.ownerWhatsApp})`));
