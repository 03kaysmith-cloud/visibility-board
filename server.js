require('dotenv').config();
const express = require('express');
const https = require('https');
const path = require('path');

const NOTION_KEY = process.env.NOTION_KEY || 'ntn_o72845711711ULdEW2UsgsYj8DGvEumAimeXyivdNEYe7X';
const DATABASE_ID = process.env.DATABASE_ID || '31c1b231bc238079a79decead097d0aa';
const SLACK_TOKEN    = process.env.SLACK_TOKEN    || '';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || '';

const AVATAR_COLORS = [
  '#6366f1','#ec4899','#14b8a6','#f59e0b','#3b82f6','#10b981','#8b5cf6','#ef4444',
  '#f43f5e','#a855f7','#06b6d4','#84cc16',
];

const DEPT_MAP = {
  'RevOps':  'revops',
  'Product': 'product',
  'GTM':     'gtm',
  'CSM':     'csm',
};

function notionRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.notion.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${NOTION_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Notion API ${res.statusCode}: ${parsed.message || data}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Notion response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const notionPost = (path, body) => notionRequest('POST', path, body);
const notionGet  = (path)       => notionRequest('GET',  path, null);

function slackGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function anthropicPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Cache: notionName (lowercase) -> avatarUrl
let slackAvatarCache = null;

async function refreshSlackAvatarCache(notionNames) {
  if (!SLACK_TOKEN) { slackAvatarCache = {}; return; }
  try {
    const data = await slackGet('/api/users.list?limit=200');
    if (!data.ok) { console.warn('[slack] users.list error:', data.error); slackAvatarCache = {}; return; }

    const slackUsers = (data.members || [])
      .filter(m => !m.deleted && !m.is_bot && !m.is_app_user)
      .map(m => ({
        real_name:    (m.real_name || '').trim(),
        display_name: (m.profile && m.profile.display_name || '').trim(),
        username:     (m.name || '').trim(),
        avatarUrl:    m.profile && (m.profile.image_192 || m.profile.image_72),
      }))
      .filter(u => u.avatarUrl && u.real_name);

    const avatarByName = {};
    for (const u of slackUsers) avatarByName[u.real_name.toLowerCase()] = u.avatarUrl;

    if (ANTHROPIC_KEY) {
      const slackList = slackUsers
        .map(u => `- "${u.real_name}" (display: "${u.display_name}", username: "${u.username}")`)
        .join('\n');
      const notionList = notionNames.map(n => `- ${n}`).join('\n');
      const prompt = `Match these Notion names to Slack users. Only match if you're confident they're the same person — consider nicknames, shortened names, or first-name-only Slack profiles.\n\nSlack users:\n${slackList}\n\nNotion names:\n${notionList}\n\nReturn ONLY a JSON object: {"Notion Name": "Slack real_name"}. Include only confident matches, omit the rest.`;

      const response = await anthropicPost({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = (response.content && response.content[0] && response.content[0].text) || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const mapping = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      const result = {};
      for (const [notionName, slackName] of Object.entries(mapping)) {
        const url = avatarByName[slackName.toLowerCase()];
        if (url) result[notionName.toLowerCase()] = url;
      }
      console.log(`[slack] AI matched ${Object.keys(result).length}/${notionNames.length} names`);
      slackAvatarCache = result;
    } else {
      // Fallback: exact + first-name matching
      const byFirst = {};
      for (const u of slackUsers) {
        const first = u.real_name.toLowerCase().split(' ')[0];
        if (first && !byFirst[first]) byFirst[first] = u.avatarUrl;
      }
      const result = {};
      for (const name of notionNames) {
        const lower = name.toLowerCase();
        result[lower] = avatarByName[lower] || byFirst[lower.split(' ')[0]] || null;
      }
      slackAvatarCache = result;
    }
  } catch (err) {
    console.warn('[slack] avatar refresh failed:', err.message);
    slackAvatarCache = {};
  }
}

function authorColor(name) {
  let hash = 0;
  for (const c of (name || '')) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatNotionTime(isoStr) {
  return new Date(isoStr).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

async function fetchPageComments(pageId) {
  try {
    const data = await notionGet(`/v1/comments?block_id=${pageId}`);
    return (data.results || [])
      .filter(c => (c.rich_text || []).length > 0)
      .map(c => ({
        author: c.created_by?.name || 'Unknown',
        color:  authorColor(c.created_by?.name),
        time:   formatNotionTime(c.created_time),
        ts:     new Date(c.created_time).getTime(),
        text:   c.rich_text.map(t => t.plain_text).join(''),
      }));
  } catch {
    return [];
  }
}

async function fetchAllPages() {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionPost(`/v1/databases/${DATABASE_ID}/query`, body);
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}


function parseLocalDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function getThisWeekBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + 6, 23, 59, 59, 999);
  return { start, end };
}

function isThisWeek(dateStr) {
  if (!dateStr) return false;
  const { start, end } = getThisWeekBounds();
  const d = parseLocalDate(dateStr);
  return d >= start && d <= end;
}

function mapInitialStatus(statusName) {
  if (!statusName) return 'planned';
  const lower = statusName.toLowerCase();
  if (lower === 'done') return 'done';
  if (lower === 'doing' || lower.includes('needs help')) return 'doing';
  // considering / planned / to do / etc. all map to planned
  return 'planned';
}

// ---- CACHE ----

let dataCache = null;
let cacheVersion = 0;
let cacheRefreshing = false;

async function buildTaskData() {
  const pages = await fetchAllPages();
  const peopleMap = new Map();
  let colorIdx = 0;

  for (const page of pages) {
    const props = page.properties;

    const titleArr = (props.Task || {}).title || [];
    const title = titleArr.map(t => t.plain_text).join('').trim();

    const statusSel = (props.Status || {}).select || null;
    const statusName = statusSel ? statusSel.name : null;

    const deptSel = (props.Department || {}).select || null;
    const deptName = deptSel ? deptSel.name : null;

    if (!title || !statusName || !deptName) continue;

    const deptKey = DEPT_MAP[deptName] || deptName.toLowerCase().replace(/\s+/g, '');

    const dateObj = (props['Week date'] || {}).date || null;
    const dateStr = dateObj ? dateObj.start : null;

    if (statusName === 'Done' && !isThisWeek(dateStr)) continue;

    const flagged = statusName.toLowerCase().includes('needs help');

    const notesArr = (props['Commit description'] || {}).rich_text || [];
    const notes = notesArr.map(t => t.plain_text).join('').trim();

    const due = dateStr
      ? parseLocalDate(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';

    const initialStatus = mapInitialStatus(statusName);

    const personSel = (props.Person || {}).select || null;
    const name = personSel ? personSel.name : null;
    if (!name) continue;

    if (!peopleMap.has(name)) {
      peopleMap.set(name, {
        id: name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
        name,
        role: deptName,
        avatarColor: AVATAR_COLORS[colorIdx++ % AVATAR_COLORS.length],
        tasks: [],
      });
    }

    peopleMap.get(name).tasks.push({
      id: page.id,
      name: title,
      dept: deptKey,
      flagged,
      notes,
      status: statusName,
      due,
      initialStatus,
    });
  }

  const notionNames = [...peopleMap.keys()];
  if (!slackAvatarCache) await refreshSlackAvatarCache(notionNames);
  for (const person of peopleMap.values()) {
    person.avatarUrl = slackAvatarCache[person.name.toLowerCase()] || null;
  }

  const includedIds = [...new Set(
    Array.from(peopleMap.values()).flatMap(p => p.tasks.map(t => t.id))
  )];
  const commentResults = await Promise.all(includedIds.map(id => fetchPageComments(id)));
  const comments = {};
  includedIds.forEach((id, i) => { if (commentResults[i].length) comments[id] = commentResults[i]; });

  return { people: Array.from(peopleMap.values()), comments };
}

let lastChecked = new Date(0).toISOString();

async function hasNotionChangedSince(since) {
  // Strip milliseconds — Notion filter is finicky with .000Z format
  const timestamp = since.replace(/\.\d{3}Z$/, 'Z');
  const data = await notionPost(`/v1/databases/${DATABASE_ID}/query`, {
    page_size: 1,
    filter: {
      timestamp: 'last_edited_time',
      last_edited_time: { after: timestamp },
    },
  });
  return data.results && data.results.length > 0;
}

async function refreshCache() {
  if (cacheRefreshing) return;
  cacheRefreshing = true;
  try {
    const data = await buildTaskData();
    dataCache = data;
    cacheVersion = Date.now();
    lastChecked = new Date().toISOString();
    console.log(`[cache] refreshed at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[cache] refresh failed:', err.message);
  } finally {
    cacheRefreshing = false;
  }
}

async function pollForChanges() {
  // Record time before the check so no changes fall through the gap
  const checkTime = new Date().toISOString();
  try {
    const changed = await hasNotionChangedSince(lastChecked);
    if (changed) {
      console.log('[cache] change detected — refreshing');
      await refreshCache(); // also updates lastChecked
    } else {
      lastChecked = checkTime;
    }
  } catch (err) {
    console.error('[cache] poll error:', err.message);
    // Don't advance lastChecked — retry next interval
  }
}

// Warm cache on startup, then check for changes every 60 seconds
refreshCache();
setInterval(pollForChanges, 10 * 1000);
// Refresh Slack avatar cache hourly so new team members get picked up
setInterval(() => { slackAvatarCache = null; }, 60 * 60 * 1000);

// ---- ROUTES ----

const app = express();

app.get('/api/version', (req, res) => {
  res.json({ version: cacheVersion });
});

app.get('/api/tasks', async (req, res) => {
  try {
    if (!dataCache) {
      // First boot — wait for cache to be ready
      await new Promise(resolve => {
        const check = setInterval(() => { if (dataCache) { clearInterval(check); resolve(); } }, 100);
      });
    }
    res.json({ ...dataCache, version: cacheVersion });
  } catch (err) {
    console.error('Error serving tasks:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Visibility board running at http://localhost:${PORT}`);
});
