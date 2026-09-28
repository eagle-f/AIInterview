import { createServer } from "vite";
import { launchMockInterview } from "./helpers/mockInterview";

// Local UI verification only. Uses deterministic fixture responses, not production data.
const app = await launchMockInterview({ failFirstReport: true, failFirstReply: true, replyDelayMs: 3000 });
const vite = await createServer({ server: {
  host: "127.0.0.1", port: 4400, strictPort: true,
  proxy: { "/api": { target: app.baseUrl, ws: true, rewrite: (path) => path.replace(/^\/api/, "") } },
} });
await vite.listen();
console.log("Feedback fixture preview: http://127.0.0.1:4400 (first reply and report requests intentionally fail)");
const cleanup = async () => { await vite.close(); await app.close(); process.exit(0); };
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
