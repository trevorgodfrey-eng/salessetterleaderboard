import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 8080;
const HUBSPOT_TOKEN = process.env.HUBSPOT_MCP_TOKEN;

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

function getPeriodRange(period) {
  const now = new Date();
  const start = new Date();
  if (period === "week") {
    const day = now.getDay();
    const diffToMonday = (day === 0 ? -6 : 1 - day);
    start.setDate(now.getDate() + diffToMonday);
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }
  return { start: start.getTime(), end: now.getTime() };
}

async function hsGet(url) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`HubSpot error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

async function hsPost(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`HubSpot error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

async function getPipelines() {
  const data = await hsGet("https://api.hubapi.com/crm/v3/pipelines/deals");
  return data.results || [];
}

async function getClosedWonStageId(pipelines) {
  const pipeline = pipelines.find((p) =>
    p.label.toLowerCase().includes("closer call pipeline (academy)") ||
    p.label.toLowerCase().includes("closer call")
  );
  if (!pipeline) throw new Error("Could not find 'Closer Call Pipeline (Academy)' pipeline");
  const stage = pipeline.stages.find((s) =>
    s.label.toLowerCase().includes("closed won") ||
    s.metadata?.probability === "1.0" ||
    s.metadata?.isClosed === "true"
  );
  if (!stage) throw new Error("Could not find Closed Won stage in pipeline");
  return { pipelineId: pipeline.id, stageId: stage.id };
}

async function getOwnerMap() {
  const data = await hsGet("https://api.hubapi.com/crm/v3/owners?limit=100");
  const map = {};
  for (const owner of data.results || []) {
    map[String(owner.id)] = `${owner.firstName} ${owner.lastName}`.trim();
    if (owner.userId) map[String(owner.userId)] = `${owner.firstName} ${owner.lastName}`.trim();
    if (owner.email) map[owner.email] = `${owner.firstName} ${owner.lastName}`.trim();
  }
  return map;
}

async function fetchDealsForPeriod(period) {
  const { start, end } = getPeriodRange(period);
  const { pipelineId, stageId } = await getClosedWonStageId(await getPipelines());
  const ownerMap = await getOwnerMap();

  let all = [];
  let after = undefined;

  while (true) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: "pipeline", operator: "EQ", value: pipelineId },
          { propertyName: "dealstage", operator: "EQ", value: stageId },
          { propertyName: "closedate", operator: "GTE", value: String(start) },
          { propertyName: "closedate", operator: "LTE", value: String(end) },
        ],
      }],
      properties: ["dealname", "closedate", "up_front_cash_collected", "setter_owner"],
      limit: 100,
      ...(after ? { after } : {}),
    };

    const data = await hsPost("https://api.hubapi.com/crm/v3/objects/deals/search", body);
    all = all.concat(data.results || []);
    if (data.paging?.next?.after) {
      after = data.paging.next.after;
    } else {
      break;
    }
  }

  const grouped = {};
  for (const deal of all) {
    const rawOwner = deal.properties.setter_owner || "Unknown";
    const name = ownerMap[rawOwner] || rawOwner;
    const amount = parseFloat(deal.properties.up_front_cash_collected) || 0;
    if (!grouped[name]) grouped[name] = { name, total: 0, deals: 0 };
    grouped[name].total += amount;
    grouped[name].deals += 1;
  }

  return Object.values(grouped).sort((a, b) => b.total - a.total);
}

async function refreshCache() {
  if (isFetching) return;
  isFetching = true;
  console.log(`[${new Date().toISOString()}] Refreshing leaderboard...`);
  try {
    cache.week = await fetchDealsForPeriod("week");
    console.log(`[${new Date().toISOString()}] Week done.`);
    cache.month = await fetchDealsForPeriod("month");
    console.log(`[${new Date().toISOString()}] Month done.`);
    cache.updatedAt = new Date().toISOString();
    console.log(`[${new Date().toISOString()}] Cache updated successfully.`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Error:`, e.message);
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
      if (d.getMinutes() === 0 && isWithinSchedule()) refreshCache();
    };
    check();
    setInterval(check, 60000);
  }, msUntilNextMinute);
}

app.get("/api/debug", async (req, res) => {
  try {
    const pipelines = await getPipelines();
    const { pipelineId, stageId } = await getClosedWonStageId(pipelines);
    const data = await hsPost("https://api.hubapi.com/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [
        { propertyName: "pipeline", operator: "EQ", value: pipelineId },
        { propertyName: "dealstage", operator: "EQ", value: stageId },
      ]}],
      properties: ["dealname", "setter_owner", "up_front_cash_collected"],
      limit: 10,
    });
    const owners = await hsGet("https://api.hubapi.com/crm/v3/owners?limit=100");
    res.json({
      sample_deals: data.results.map(d => ({
        name: d.properties.dealname,
        setter_owner_raw: d.properties.setter_owner,
      })),
      owners: owners.results.map(o => ({
        id: o.id,
        userId: o.userId,
        email: o.email,
        name: `${o.firstName} ${o.lastName}`,
      })),
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

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
