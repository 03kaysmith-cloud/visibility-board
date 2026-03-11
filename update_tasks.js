// update_tasks.js - One-time script: fix department tags, set status to Considering
const https = require('https');

const NOTION_KEY = process.env.NOTION_KEY;
const DATABASE_ID = process.env.DATABASE_ID;

// Keywords used to infer department from task title.
// Listed in order of specificity — first match wins.
const DEPT_KEYWORDS = {
  RevOps: [
    'crm', 'salesforce', 'hubspot', 'pipeline', 'forecast', 'revenue ops',
    'quota', 'commission', 'contract', 'billing', 'invoice', 'kpi',
    'revops', 'attribution', 'territory', 'lead routing', 'automation',
    'workflow', 'data cleanup', 'data hygiene', 'enrichment', 'sync field',
    'sequence', 'apollo', 'zoominfo', 'gong', 'clari', 'chili piper',
    'sales ops', 'tool stack', 'tech stack', 'process improvement',
    'reporting cadence', 'data quality', 'data mapping', 'field mapping',
  ],
  Product: [
    'product roadmap', 'product feature', 'product spec', 'product design',
    'product requirement', 'figma', 'wireframe', 'prototype', 'mvp', 'ux', ' ui ',
    'user story', 'acceptance criteria', 'backlog', 'sprint', 'jira',
    'engineering', 'development', 'backend', 'frontend', 'mobile app', 'web app',
    'api ', 'deploy', 'infrastructure', 'architecture', 'database schema',
    'bug fix', 'qa test', 'release notes', 'feature flag', 'a/b test',
  ],
  GTM: [
    'marketing campaign', 'email campaign', 'content calendar', 'demand gen',
    'lead gen', 'seo', 'sem', 'paid media', 'paid ads', 'social media',
    'newsletter', 'press release', 'pr strategy', 'analyst brief', 'brand refresh',
    'positioning', 'go-to-market', 'enablement', 'sales deck', 'case study',
    'blog post', 'landing page', 'linkedin', 'youtube video', 'podcast',
    'webinar', 'trade show', 'tradeshow', 'conference', 'event sponsorship',
    'partner program', 'partnership', 'alliance', 'outbound sequence',
    'product launch', 'competitive analysis', 'messaging framework',
  ],
  CSM: [
    'customer success', 'onboarding', 'qbr', 'business review', 'renewal',
    'churn risk', 'nps', 'health score', 'success plan', 'implementation plan',
    'customer training', 'adoption', 'escalation', 'support ticket', 'csm',
    'upsell', 'expansion opportunity', 'account review', 'kickoff call',
    'playbook', 'check-in call', 'customer satisfaction', 'retention',
  ],
};

// Statuses that indicate a task hasn't truly started — safe to set to Considering
const UNSTARTED_STATUSES = new Set([
  'to do', 'todo', 'not started', 'backlog', 'planned', '', null,
]);

function inferDept(taskName, currentDept) {
  // Pad with spaces so partial-word boundaries work
  const lower = ' ' + taskName.toLowerCase() + ' ';
  for (const [dept, keywords] of Object.entries(DEPT_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return dept;
  }
  return currentDept; // keep existing if no keyword matched
}

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
            reject(new Error(`Notion ${res.statusCode}: ${parsed.message || data}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchAllPages() {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest('POST', `/v1/databases/${DATABASE_ID}/query`, body);
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function updatePage(pageId, properties) {
  return notionRequest('PATCH', `/v1/pages/${pageId}`, { properties });
}

async function main() {
  console.log('Fetching tasks from Notion...');
  const pages = await fetchAllPages();
  console.log(`Found ${pages.length} pages\n`);

  let deptUpdated = 0;
  let statusUpdated = 0;
  let unchanged = 0;
  let errors = 0;

  for (const page of pages) {
    const props = page.properties;

    const titleArr = (props.Task || {}).title || [];
    const title = titleArr.map(t => t.plain_text).join('').trim();
    if (!title) continue;

    const currentDept   = props.Department?.select?.name   || null;
    const currentStatus = props.Status?.select?.name       || null;

    const newDept = inferDept(title, currentDept);
    const shouldSetConsidering = currentStatus !== 'Considering';

    const updates = {};

    if (newDept && newDept !== currentDept) {
      updates.Department = { select: { name: newDept } };
    }

    if (shouldSetConsidering) {
      updates.Status = { select: { name: 'Considering' } };
    }

    if (Object.keys(updates).length === 0) {
      unchanged++;
      continue;
    }

    const changes = [];
    if (updates.Department) changes.push(`dept: "${currentDept}" -> "${newDept}"`);
    if (updates.Status)     changes.push(`status: "${currentStatus}" -> "Considering"`);

    try {
      await updatePage(page.id, updates);
      console.log(`[OK] "${title.slice(0, 65)}" — ${changes.join(', ')}`);
      if (updates.Department) deptUpdated++;
      if (updates.Status)     statusUpdated++;
    } catch (err) {
      console.error(`[ERR] "${title.slice(0, 65)}" — ${err.message}`);
      errors++;
    }

    // Avoid Notion rate limiting (3 req/s limit)
    await new Promise(r => setTimeout(r, 350));
  }

  console.log(`\nDone.`);
  console.log(`  Dept updated:   ${deptUpdated}`);
  console.log(`  Status updated: ${statusUpdated}`);
  console.log(`  Unchanged:      ${unchanged}`);
  console.log(`  Errors:         ${errors}`);
}

main().catch(console.error);
