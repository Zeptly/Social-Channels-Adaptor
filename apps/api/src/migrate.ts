// Railway pre-deploy entrypoint: `node dist/migrate.js` (idempotent, advisory-locked).
import "@zeptly-gateway/database/migrate";
