import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// STORE
// ============================================================
const DATA_FILE = path.join(os.tmpdir(), 'roblox-clone-store.json');

const DEFAULT_STATE = {
  paused: false,
  sitePassword: '',
  keys: [],
};

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) };
    }
  } catch {}
  return { ...DEFAULT_STATE };
}

function save(state) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function generateCode() {
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X');
  return `${part()}-${part()}-${part()}-${part()}`;
}

const Store = {
  get: () => load(),
  setPaused(paused) {
    const s = load();
    s.paused = paused;
    save(s);
  },
  createKey(durationMs) {
    const s = load();
    const key = {
      code: generateCode(),
      createdAt: Date.now(),
      expiresAt: Date.now() + durationMs,
      paused: false,
    };
    s.keys.unshift(key);
    save(s);
    return key;
  },
  deleteKey(code) {
    const s = load();
    s.keys = s.keys.filter((k) => k.code !== code);
    save(s);
  },
  setKeyPaused(code, paused) {
    const s = load();
    const key = s.keys.find((k) => k.code.toLowerCase() === code.toLowerCase());
    if (key) {
      key.paused = paused;
      save(s);
    }
    return { ok: !!key };
  },
  claimKey(code, ip, discord) {
    const s = load();
    const key = s.keys.find((k) => k.code.toLowerCase() === code.toLowerCase());
    if (!key) return { ok: false, reason: 'Invalid key.' };
    if (key.paused) return { ok: false, reason: 'Key is paused.' };
    if (key.expiresAt < Date.now()) return { ok: false, reason: 'Key expired.' };
    if (key.claimedByIp) {
      if (key.claimedByIp === ip) return { ok: true, key };
      return { ok: false, reason: 'Key already claimed.' };
    }
    key.claimedByIp = ip;
    key.claimedByDiscord = discord;
    key.claimedAt = Date.now();
    save(s);
    return { ok: true, key };
  },
  isIpUnlocked(ip) {
    const s = load();
    return s.keys.some(
      (k) => k.claimedByIp === ip && k.expiresAt > Date.now() && !k.paused
    );
  },
  ipKeyStatus(ip) {
    const s = load();
    const key = s.keys.find((k) => k.claimedByIp === ip);
    if (!key) return 'none';
    if (key.paused) return 'paused';
    if (key.expiresAt < Date.now()) return 'expired';
    return 'unlocked';
  },
};

// ============================================================
// SERVER
// ============================================================
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function getIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').toString();
  return fwd.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

app.get('/', (_req, res) => res.send('Roblox clone backend up.'));

app.get('/status', (_req, res) => {
  const s = Store.get();
  res.json({ paused: s.paused, hasSitePassword: !!s.sitePassword });
});

app.get('/check', (req, res) => {
  res.json({ unlocked: Store.isIpUnlocked(getIp(req)), status: Store.ipKeyStatus(getIp(req)) });
});

app.post('/unlock', (req, res) => {
  const { code, discord, sitePassword } = req.body || {};
  const s = Store.get();
  if (s.paused) return res.json({ ok: false, reason: 'Site is paused.' });
  if (s.sitePassword && s.sitePassword !== (sitePassword || '')) {
    return res.json({ ok: false, reason: 'Incorrect site password.' });
  }
  if (!discord?.trim()) {
    return res.json({ ok: false, reason: 'Discord username required.' });
  }
  res.json(Store.claimKey(code, getIp(req), discord));
});

app.post('/users/search', async (req, res) => {
  const { keyword } = req.body || {};
  if (!keyword?.trim()) return res.json({ data: [] });
  try {
    const r = await fetch(
      `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(keyword)}&limit=10`
    );
    const data = await r.json();
    res.json({ data: data?.data || [] });
  } catch {
    res.json({ data: [] });
  }
});

app.post('/users/headshots', async (req, res) => {
  const { userIds } = req.body || {};
  if (!userIds?.length) return res.json({ data: [] });
  try {
    const r = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(',')}&size=48x48&format=Png&isCircular=true`
    );
    const data = await r.json();
    res.json({ data: data?.data || [] });
  } catch {
    res.json({ data: [] });
  }
});

app.get('/admin/state', (_req, res) => {
  const s = Store.get();
  res.json({ paused: s.paused, sitePassword: s.sitePassword, keys: s.keys });
});

app.post('/admin/keys', (req, res) => {
  const { durationMs } = req.body || {};
  res.json(Store.createKey(Number(durationMs) || 24 * 60 * 60 * 1000));
});

app.delete('/admin/keys/:code', (req, res) => {
  Store.deleteKey(req.params.code);
  res.json({ ok: true });
});

app.post('/admin/keys/:code/pause', (req, res) => {
  const { paused } = req.body || {};
  res.json(Store.setKeyPaused(req.params.code, !!paused));
});

app.post('/admin/pause', (req, res) => {
  const { paused } = req.body || {};
  Store.setPaused(!!paused);
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Roblox backend on :${port}`));
