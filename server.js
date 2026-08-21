import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 8080;
const HUBSPOT_TOKEN = process.env.HUBSPOT_MCP_TOKEN;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));

let cache = { setterWeek: null, setterMonth: null, closerWeek: null, closerMonth: null, setterWeekTotals: null, setterMonthTotals: null, closerWeekTotals: null, closerMonthTotals: null, updatedAt: null };
let isFetching = false;

const HIDDEN_OWNERS = ["90398715", "84870321", "92723181", "93371701"];

function isWithinSchedule() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 20;
}

function getPeriodRange(period) {
  const now = new Date();
  const start = new Date();
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  if (period === "week") {
    const day = now.getDay();
    const diffToMonday = (day === 0 ? -6 : 1 - day);
    start.setDate(now.getDate() + diffToMonday);
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }
  return { start: start.getTime(), end: end.getTime() };
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

async function getClosedWonStageIds(pipelines) {
  const pipeline = pipelines.find((p) =>
    p.label.toLowerCase().includes("closer call pipeline (academy)") ||
    p.label.toLowerCase().includes("closer call")
  );
  if (!pipeline) throw new Error("Could not find 'Closer Call Pipeline (Academy)' pipeline");
  const stages = pipeline.stages.filter((s) =>
    s.label.toLowerCase().includes("closed won")
  );
  if (!stages.length) throw new Error("Could not find any Closed Won stages in pipeline");
  console.log("Matched stages:", stages.map(s => `'${s.label} (${s.id})'`));
  return { pipelineId: pipeline.id, stageIds: new Set(stages.map(s => s.id)) };
}

async function getOwnerMap() {
  const data = await hsGet("https://api.hubapi.com/crm/v3/owners?limit=100");
  const map = {};
  for (const owner of data.results || []) {
    const name = `${owner.firstName} ${owner.lastName}`.trim();
    map[String(owner.id)] = name;
    if (owner.userId) map[String(owner.userId)] = name;
    if (owner.email) map[owner.email] = name;
  }
  return map;
}

async function fetchDealsForPeriod(period, groupBy) {
  const { start, end } = getPeriodRange(period);
  const { pipelineId, stageIds } = await getClosedWonStageIds(await getPipelines());
  const ownerMap = await getOwnerMap();

  let allDeals = [];
  let after = undefined;

  while (true) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: "pipeline", operator: "EQ", value: pipelineId },
          { propertyName: "closedate", operator: "GTE", value: String(start) },
          { propertyName: "closedate", operator: "LTE", value: String(end) },
        ],
      }],
      properties: ["dealname", "closedate", "up_front_cash_collected", "setter_owner", "dealstage", "hubspot_owner_id"],
      limit: 100,
      ...(after ? { after } : {}),
    };

    const data = await hsPost("https://api.hubapi.com/crm/v3/objects/deals/search", body);
    allDeals = allDeals.concat(data.results || []);
    if (data.paging?.next?.after) {
      after = data.paging.next.after;
    } else {
      break;
    }
  }

  if (allDeals.length === 0) return { leaderboard: [], hiddenTotal: 0, hiddenDeals: 0 };

  const BATCH_SIZE = 100;
  const allBatchResults = [];
  for (let i = 0; i < allDeals.length; i += BATCH_SIZE) {
    const chunk = allDeals.slice(i, i + BATCH_SIZE);
    if (i > 0) await new Promise(r => setTimeout(r, 500));
    const batchData = await hsPost("https://api.hubapi.com/crm/v3/objects/deals/batch/read", {
      inputs: chunk.map(d => ({ id: d.id })),
      properties: ["dealname", "closedate", "up_front_cash_collected", "setter_owner", "dealstage", "hubspot_owner_id"],
    });
    allBatchResults.push(...(batchData.results || []));
  }

  const grouped = {};
  let hiddenTotal = 0;
  let hiddenDeals = 0;

  for (const deal of allBatchResults) {
    if (!stageIds.has(deal.properties.dealstage)) continue;
    const rawOwner = groupBy === "closer"
      ? deal.properties.hubspot_owner_id
      : deal.properties.setter_owner;
    const amount = parseFloat(deal.properties.up_front_cash_collected) || 0;
    if (HIDDEN_OWNERS.includes(rawOwner)) {
      hiddenTotal += amount;
      hiddenDeals += 1;
      continue;
    }
    const name = ownerMap[rawOwner] || rawOwner || "Unknown";
    if (!grouped[name]) grouped[name] = { name, total: 0, deals: 0 };
    grouped[name].total += amount;
    grouped[name].deals += 1;
  }

  const leaderboard = Object.values(grouped).sort((a, b) => b.total - a.total);
  console.log(`[${new Date().toISOString()}] fetchDealsForPeriod(${period}, ${groupBy}) — ${allDeals.length} raw deals, ${leaderboard.length} reps`);
  return { leaderboard, hiddenTotal, hiddenDeals };
}

async function refreshCache() {
  if (isFetching) return;
  isFetching = true;
  console.log(`[${new Date().toISOString()}] Refreshing leaderboard...`);
  try {
    const [swR, smR] = await Promise.allSettled([
      fetchDealsForPeriod("week", "setter"),
      fetchDealsForPeriod("month", "setter"),
    ]);
    await new Promise(r => setTimeout(r, 1000));
    const [cwR, cmR] = await Promise.allSettled([
      fetchDealsForPeriod("week", "closer"),
      fetchDealsForPeriod("month", "closer"),
    ]);

    const toCache = (r, label) => {
      if (r.status === "fulfilled" && r.value && r.value.leaderboard) {
        console.log(`[${new Date().toISOString()}] ${label} done: ${r.value.leaderboard.length} reps`);
        return {
          leaderboard: r.value.leaderboard,
          totals: {
            total: r.value.leaderboard.reduce((s,x) => s + x.total, 0) + (r.value.hiddenTotal || 0),
            deals: r.value.leaderboard.reduce((s,x) => s + x.deals, 0) + (r.value.hiddenDeals || 0)
          }
        };
      }
      console.error(`[${new Date().toISOString()}] ${label} error:`, r.reason?.message || "Empty result");
      return { leaderboard: [], totals: { total: 0, deals: 0 } };
    };

    const sw = toCache(swR, "Setter week");
    const sm = toCache(smR, "Setter month");
    const cw = toCache(cwR, "Closer week");
    const cm = toCache(cmR, "Closer month");

    cache.setterWeek        = sw.leaderboard;
    cache.setterWeekTotals  = sw.totals;
    cache.setterMonth       = sm.leaderboard;
    cache.setterMonthTotals = sm.totals;
    cache.closerWeek        = cw.leaderboard;
    cache.closerWeekTotals  = cw.totals;
    cache.closerMonth       = cm.leaderboard;
    cache.closerMonthTotals = cm.totals;
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
      if (d.getMinutes() % 15 === 0 && isWithinSchedule()) refreshCache();
    };
    check();
    setInterval(check, 60000);
  }, msUntilNextMinute);
}

app.get("/api/debug", async (req, res) => {
  try {
    const pipelines = await getPipelines();
    const { pipelineId, stageIds } = await getClosedWonStageIds(pipelines);
    const data = await hsPost("https://api.hubapi.com/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [
        { propertyName: "pipeline", operator: "EQ", value: pipelineId },
      ]}],
      properties: ["dealname", "setter_owner", "up_front_cash_collected", "dealstage", "hubspot_owner_id"],
      limit: 5,
    });
    const owners = await hsGet("https://api.hubapi.com/crm/v3/owners?limit=100");
    res.json({
      stageIds: [...stageIds],
      sample_deals: data.results.map(d => ({
        name: d.properties.dealname,
        setter_owner_raw: d.properties.setter_owner,
        deal_owner_raw: d.properties.hubspot_owner_id,
        dealstage: d.properties.dealstage,
        amount: d.properties.up_front_cash_collected,
      })),
      owners: owners.results.map(o => ({
        id: o.id,
        name: `${o.firstName} ${o.lastName}`.trim(),
      })),
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/api/deal/:id", async (req, res) => {
  try {
    const data = await hsGet(`https://api.hubapi.com/crm/v3/objects/deals/${req.params.id}?properties=dealname,setter_owner,up_front_cash_collected,hubspot_owner_id,dealstage`);
    res.json({ deal: data.properties });
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
