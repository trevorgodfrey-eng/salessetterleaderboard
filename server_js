import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HUBSPOT_MCP_URL = "https://mcp.hubspot.com/anthropic";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));

let cache = { week: null, month: null, updatedAt: null };
let isFetching = false;

function isWithinSchedule() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 19;
}

async function fetchPeriod(period) {
  const periodMap = { week: "this week (last 7 days)", month: "this month" };
  const prompt = `Using the HubSpot CRM, search for deals that meet ALL of these criteria:
- Pipeline: "Closer Call Pipeline (Academy)"
- Deal stage: "Closed Won"
- Period filter: ${periodMap[period]} (filter by close date)

For each matching deal, retrieve:
1. The custom property "Up Front Cash Collected"
2. The custom property "Setter Owner"

Aggregate "Up Front Cash Collected" grouped by "Setter Owner".

Return ONLY a JSON object, no markdown, no extra text:
{
  "leaderboard": [
    { "name": "Setter Owner Full Name", "total": 123456, "deals": 5 }
  ]
}

Sort by total descending. Include all setter owners with at least one qualifying deal. Treat null/empty as 0.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-04-04",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
      mcp_servers: [{ type: "url", url: HUBSPOT_MCP_URL, name: "hubspot" }],
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || JSON.stringify(data));

  const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response: " + raw.slice(0, 200));
  return JSON.parse(match[0]);
}

async function refreshCache() {
  if (isFetching) return;
  isFetching = true;
  console.log(`[${new Date().toISOString()}] Fetching week data...`);
  try {
    const week = await fetchPeriod("week");
    cache.week = week.leaderboard || [];
    console.log(`[${new Date().toISOString()}] Week done. Waiting 10s before month...`);
    await new Promise((r) => setTimeout(r, 10000));
    console.log(`[${new Date().toISOString()}] Fetching month data...`);
    const month = await fetchPeriod("month");
    cache.month = month.leaderboard || [];
    cache.updatedAt = new Date().toISOString();
    console.log(`[${new Date().toISOString()}] Cache updated.`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Fetch error:`, e.message);
  } finally {
    isFetching = false;
  }
}

function scheduleHourlyCheck() {
  const now = new Date();
  const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  setTimeout(() => {
    const check = () => {
      const d = new Date();
      if (d.getMinutes() === 0 && isWithinSchedule()) {
        refreshCache();
      }
    };
    check();
    setInterval(check, 60000);
  }, msUntilNextMinute);
}

app.get("/api/leaderboard", (req, res) => {
  res.json({ ...cache, schedule: isWithinSchedule() });
});

app.post("/api/refresh", async (req, res) => {
  res.json({ ok: true, message: "Refresh started" });
  refreshCache();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  refreshCache();
  scheduleHourlyCheck();
});
