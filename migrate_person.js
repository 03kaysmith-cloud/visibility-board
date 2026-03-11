const https = require('https');

const KEY = process.env.NOTION_KEY;
const DB_ID = process.env.DATABASE_ID;

// All team members for the select options
const ALL_NAMES = [
  'Kay Smith', 'Joe Dowd', 'Alastair Llewellen Palmer', 'Ceren Cosar', 'Dan Edgar',
  'Ali Cooper', 'Max van Steen', 'Sakshi Rasam', 'Bernard van Niekerk', 'Simon Butler',
  'Amit Rawat', 'Dovydas Zulkus', 'Maciej Kazimierek', 'Yash Junghare',
  'Saul Lew', 'Laura Keith', 'George Holton', 'Hinal Kothari', 'Mustufa Kazi',
];

// Tasks we just created - person name by task title (for those without people IDs)
const TASK_PERSON_MAP = {
  'HubSpot integration scoping': 'Bernard van Niekerk',
  'Fix Sunlife HCM sync issue': 'Bernard van Niekerk',
  'Delete Albato CRM data': 'Bernard van Niekerk',
  'Fix high priority bugs': 'Simon Butler',
  'Continue creating MCP tools': 'Simon Butler',
  'Complete testing the development ticket': 'Amit Rawat',
  'Work on setting up API automation': 'Amit Rawat',
  'Add FAQs links to HP app': 'Maciej Kazimierek',
  'Stop daily sales leader email in prod': 'Maciej Kazimierek',
  'Work on serverless to Terraform migration': 'Yash Junghare',
  'Investigate Sunlife HCM failure': 'Yash Junghare',
  'Month end completion and finalization': 'Mustufa Kazi',
  'Chasing Essex County for PO (18k)': 'Mustufa Kazi',
  'US Paycheck 1 submission': 'Mustufa Kazi',
  'Supporting Sam and Hinal with queries': 'Mustufa Kazi',
};

function notionReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.notion.com',
      path,
      method,
      headers: {
        'Authorization': 'Bearer ' + KEY,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (res.statusCode >= 400) {
          reject(new Error('Notion ' + res.statusCode + ': ' + (parsed.message || data)));
        } else {
          resolve(parsed);
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
    const data = await notionReq('POST', '/v1/databases/' + DB_ID + '/query', body);
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function main() {
  // Step 1: Fetch all pages and record current Person (people) assignments
  console.log('Fetching all pages...');
  const pages = await fetchAllPages();
  console.log('Total pages:', pages.length);

  // Build map of pageId -> personName
  const pagePersonMap = {};
  for (const page of pages) {
    const titleArr = (page.properties.Task || {}).title || [];
    const title = titleArr.map(t => t.plain_text).join('').trim();
    const people = (page.properties.Person || {}).people || [];

    let personName = null;
    if (people.length > 0) {
      personName = people[0].name;
      // Normalise "Joe" -> "Joe Dowd"
      if (personName === 'Joe') personName = 'Joe Dowd';
    } else {
      // Fall back to task title map
      personName = TASK_PERSON_MAP[title] || null;
    }
    pagePersonMap[page.id] = { title, personName };
  }

  const unassigned = Object.values(pagePersonMap).filter(p => !p.personName);
  if (unassigned.length > 0) {
    console.log('\nPages with no person resolved:');
    unassigned.forEach(p => console.log('  - ' + p.title));
  }

  // Step 2: Update database schema — change Person from people to select
  console.log('\nUpdating database schema...');
  await notionReq('PATCH', '/v1/databases/' + DB_ID, {
    properties: {
      Person: {
        name: 'Person',
        select: {
          options: ALL_NAMES.map(name => ({ name }))
        }
      }
    }
  });
  console.log('Schema updated.');

  // Step 3: Update each page with the select value
  console.log('\nUpdating pages...');
  let updated = 0;
  let skipped = 0;

  for (const [pageId, info] of Object.entries(pagePersonMap)) {
    if (!info.personName) {
      console.log('SKIP (no name): ' + info.title);
      skipped++;
      continue;
    }
    try {
      await notionReq('PATCH', '/v1/pages/' + pageId, {
        properties: {
          Person: {
            select: { name: info.personName }
          }
        }
      });
      console.log('OK: ' + info.personName + ' - ' + info.title);
      updated++;
    } catch (err) {
      console.error('FAIL: ' + info.title + ' => ' + err.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('\nDone. Updated: ' + updated + ', Skipped: ' + skipped);
}

main().catch(console.error);
