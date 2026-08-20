const express = require('express');
const session = require('express-session');
const path = require('path');

const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH = 'main',
  GITHUB_PATH = 'entries',
  LOML_PATH = 'loml',
  APP_PASSWORD,
  SESSION_SECRET = 'please-set-a-real-session-secret',
  PORT = 3000
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error('Missing required env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO. The app will not be able to read or write entries until these are set.');
}

const SECTIONS = {
  diary: { folder: GITHUB_PATH, prefix: 'diary' },
  loml: { folder: LOML_PATH, prefix: 'loml' }
};

const app = express();
app.use(express.json());
app.set('trust proxy', 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));

const GH_API = 'https://api.github.com';

function ghHeaders() {
  return {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function entryPath(section, date) {
  return `${section.folder}/${section.prefix}-${date}.txt`;
}

function fileNamePattern(section) {
  return new RegExp(`^${section.prefix}-(\\d{4}-\\d{2}-\\d{2})\\.txt$`);
}

async function ghGetFile(section, date) {
  const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${entryPath(section, date)}?ref=${GITHUB_BRANCH}`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub error ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return {
    sha: data.sha,
    content: Buffer.from(data.content, 'base64').toString('utf-8')
  };
}

async function ghListDir(section) {
  const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${section.folder}?ref=${GITHUB_BRANCH}`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`GitHub error ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const pattern = fileNamePattern(section);
  return data.filter(f => f.type === 'file' && pattern.test(f.name));
}

async function ghSaveFile(section, date, content, existingSha) {
  const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${entryPath(section, date)}`;
  const body = {
    message: existingSha ? `Update ${section.prefix} entry ${date}` : `Add ${section.prefix} entry ${date}`,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: GITHUB_BRANCH
  };
  if (existingSha) body.sha = existingSha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GitHub error ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ghDeleteFile(section, date, sha) {
  const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${entryPath(section, date)}`;
  const body = { message: `Delete ${section.prefix} entry ${date}`, sha, branch: GITHUB_BRANCH };
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GitHub error ${r.status}: ${await r.text()}`);
}

function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.session.authed) return next();
  return res.status(401).json({ error: 'not authenticated' });
}

function requireSection(req, res, next) {
  const section = SECTIONS[req.params.section];
  if (!section) return res.status(404).json({ error: 'unknown section' });
  req.section = section;
  next();
}

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!APP_PASSWORD || password === APP_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({
    authed: !APP_PASSWORD || !!req.session.authed,
    passwordRequired: !!APP_PASSWORD
  });
});

app.get('/api/:section/entries', requireAuth, requireSection, async (req, res) => {
  try {
    const files = await ghListDir(req.section);
    const pattern = fileNamePattern(req.section);
    const results = await Promise.all(files.map(async f => {
      const date = f.name.match(pattern)[1];
      let snippet = '';
      try {
        const file = await ghGetFile(req.section, date);
        snippet = (file.content || '').trim().split('\n')[0].slice(0, 60);
      } catch (e) {}
      return { date, snippet };
    }));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/:section/entries/:date', requireAuth, requireSection, async (req, res) => {
  try {
    const file = await ghGetFile(req.section, req.params.date);
    if (!file) return res.json({ exists: false, content: '' });
    res.json({ exists: true, content: file.content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/:section/entries/:date', requireAuth, requireSection, async (req, res) => {
  try {
    const { content } = req.body || {};
    const existing = await ghGetFile(req.section, req.params.date);
    await ghSaveFile(req.section, req.params.date, content || '', existing ? existing.sha : null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/:section/entries/:date', requireAuth, requireSection, async (req, res) => {
  try {
    const existing = await ghGetFile(req.section, req.params.date);
    if (!existing) return res.json({ ok: true });
    await ghDeleteFile(req.section, req.params.date, existing.sha);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Diary server listening on port ${PORT}`));
