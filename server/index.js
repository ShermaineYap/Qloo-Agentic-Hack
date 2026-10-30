// Local / container entry point. On Vercel, api/index.js serves the same app.
import { app } from "./app.js";
import { startQloo } from "./qloo.js";
import { llmInfo } from "./llm.js";

const PORT = Number(process.env.PORT || 3000);
const s = await startQloo();
console.log(`[qloo] mode=${s.mode} transport=${s.transport} tools=${s.tools.length}${s.error ? ` error=${s.error}` : ""}`);
console.log(`[llm] ${JSON.stringify(llmInfo())}`);
app.listen(PORT, () => console.log(`TourSmith on http://localhost:${PORT}`));
