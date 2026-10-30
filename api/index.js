// Vercel function: every /api/* request (and /healthz) is rewritten here by
// vercel.json with the original path in ?__p=, and handed to the Express app.
import { app } from "../server/app.js";

export default function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const original = url.searchParams.get("__p");
  if (original !== null) {
    url.searchParams.delete("__p");
    const rest = url.searchParams.toString();
    req.url = `/${original}${rest ? `?${rest}` : ""}`;
  }
  return app(req, res);
}
