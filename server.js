import express from 'express';
import { MongoClient } from 'mongodb';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

// ============================================================
// MONGODB STORE
// ============================================================
const MONGODB_URL = process.env.MONGODB_URL || 'mongodb+srv://Prince:princewill@cluster0.ybmwcbx.mongodb.net/roblox-clone?appName=Cluster0';
let db = null;

async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URL);
    await client.connect();
    db = client.db('roblox-clone');
    console.log('✅ MongoDB connected');
  } catch (e) {
    console.error('MongoDB connection failed:', e?.message || e);
  }
}

async function getState() {
  if (!db) return { paused: false, sitePassword: '', keys: [] };
  const doc = await db.collection('state').findOne({ _id: 'main' });
  return doc || { paused: false, sitePassword: '', keys: [] };
}

async function saveState(state) {
  if (!db) return;
  await db.collection('state').replaceOne({ _id: 'main' }, { _id: 'main', ...state }, { upsert: true });
}

function generateCode() {
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X');
  return `${part()}-${part()}-${part()}-${part()}`;
}

const Store = {
  get: async () => getState(),
  async setPaused(paused) {
    const s = await getState();
    s.paused = paused;
    await saveState(s);
  },
  async createKey(durationMs) {
    const s = await getState();
    const key = {
      code: generateCode(),
      createdAt: Date.now(),
      expiresAt: durationMs === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : Date.now() + durationMs,
      paused: false,
    };
    s.keys.unshift(key);
    await saveState(s);
    return key;
  },
  async deleteKey(code) {
    const s = await getState();
    s.keys = s.keys.filter((k) => k.code !== code);
    await saveState(s);
  },
  async clearKeys() {
    const s = await getState();
    s.keys = [];
    await saveState(s);
  },
  async setKeyPaused(code, paused) {
    const s = await getState();
    const key = s.keys.find((k) => k.code.toLowerCase() === code.toLowerCase());
    if (key) { key.paused = paused; await saveState(s); }
    return { ok: !!key };
  },
  async claimKey(code, ip, discord, discordInfo) {
    const s = await getState();
    const key = s.keys.find((k) => k.code.toLowerCase() === code.toLowerCase());
    if (!key) return { ok: false, reason: 'Invalid key.' };
    if (key.paused) return { ok: false, reason: 'Key is paused.' };
    if (key.expiresAt < Date.now()) return { ok: false, reason: 'Key expired.' };
    if (key.claimedByIp) {
      if (key.claimedByIp === ip) return { ok: true, key };
      if (key.claimedByDiscord && discord &&
          key.claimedByDiscord.toLowerCase() === discord.toLowerCase()) {
        key.claimedByIp = ip;
        await saveState(s);
        return { ok: true, key };
      }
      return { ok: false, reason: 'Key already claimed.' };
    }
    key.claimedByIp = ip;
    key.claimedByDiscord = discord;
    key.discordInfo = discordInfo || null;
    key.claimedAt = Date.now();
    await saveState(s);
    return { ok: true, key };
  },
  async isIpUnlocked(ip) {
    const s = await getState();
    return s.keys.some((k) => k.claimedByIp === ip && k.expiresAt > Date.now() && !k.paused);
  },
  async ipKeyStatus(ip) {
    const s = await getState();
    const key = s.keys.find((k) => k.claimedByIp === ip);
    if (!key) return 'none';
    if (key.paused) return 'paused';
    if (key.expiresAt < Date.now()) return 'expired';
    return 'unlocked';
  },
};

// ============================================================
// DISCORD BOT
// ============================================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const CODE_KEYWORD = (process.env.DISCORD_CODE_KEYWORD || 'PRX').toUpperCase();

let discordReady = false;
let discordClient = null;

if (DISCORD_TOKEN && DISCORD_GUILD_ID) {
  discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences],
    partials: [Partials.GuildMember, Partials.User],
  });
  discordClient.once('ready', () => { discordReady = true; console.log(`🤖 Discord bot ready as ${discordClient.user.tag}`); });
  discordClient.on('error', (e) => console.error('Discord error:', e?.message || e));
  discordClient.login(DISCORD_TOKEN).catch((e) => console.error('Discord login failed:', e?.message || e));
}

async function lookupDiscordUser(rawUsername) {
  const q = (rawUsername || '').trim().replace(/^@/, '').toLowerCase();
  if (!q) return { found: false, reason: 'no username' };
  if (!discordReady || !discordClient) return { found: false, reason: 'bot offline' };
  let guild;
  try { guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID); } catch (e) { return { found: false, reason: 'guild fetch failed' }; }
  let member = null;
  try {
    const results = await guild.members.search({ query: q, limit: 10 });
    member = results.find((m) => {
      const u = m.user;
      return u.username?.toLowerCase() === q || u.globalName?.toLowerCase() === q || m.displayName?.toLowerCase() === q;
    }) || results.first();
  } catch (e) { console.error('members.search failed:', e?.message); }
  if (!member) {
    try {
      await guild.members.fetch({ withPresences: true });
      const names = (m) => [m.user.username, m.user.globalName, m.displayName].filter(Boolean).map((n) => n.toLowerCase());
      member = guild.members.cache.find((m) => names(m).some((n) => n === q))
        || guild.members.cache.find((m) => names(m).some((n) => n.startsWith(q)))
        || guild.members.cache.find((m) => names(m).some((n) => n.includes(q)));
    } catch (e) { console.error('members.fetch failed:', e?.message); }
  }
  if (!member) return { found: false, reason: 'not in server', inServer: false };
  try {
    const user = member.user;
    const avatarUrl = member.displayAvatarURL?.({ size: 128, extension: 'png' }) || '';
    let customStatus = '';
    const presence = member.presence;
    if (presence?.activities?.length) {
      const custom = presence.activities.find((a) => a.type === 4);
      customStatus = custom?.state || presence.activities[0]?.state || presence.activities[0]?.name || '';
    }
    return { found: true, inServer: true, id: user.id, username: user.username || '', displayName: member.displayName || user.globalName || user.username || '', avatarUrl, status: presence?.status || 'offline', customStatus, usesCode: customStatus.toUpperCase().includes(CODE_KEYWORD) };
  } catch (e) { return { found: false, reason: 'member processing failed' }; }
}

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
  return ((req.headers['x-forwarded-for'] || '').toString().split(',')[0]?.trim()) || req.socket.remoteAddress || 'unknown';
}

app.get('/', (_req, res) => res.send(`Roblox clone backend up. Discord: ${discordReady ? 'ready' : 'offline'} | DB: ${db ? 'connected' : 'offline'}`));

app.get('/status', async (_req, res) => {
  const s = await Store.get();
  res.json({ paused: s.paused, hasSitePassword: !!s.sitePassword, discord: discordReady, codeKeyword: CODE_KEYWORD });
});

app.get('/check', async (req, res) => {
  res.json({ unlocked: await Store.isIpUnlocked(getIp(req)), status: await Store.ipKeyStatus(getIp(req)) });
});

app.get('/check-code', async (req, res) => {
  const code = (req.query.code || '').toString();
  const s = await Store.get();
  const key = s.keys.find((k) => k.code.toLowerCase() === code.toLowerCase());
  if (!key) return res.json({ valid: false, reason: 'deleted' });
  if (key.paused) return res.json({ valid: false, reason: 'paused' });
  if (key.expiresAt < Date.now()) return res.json({ valid: false, reason: 'expired' });
  res.json({ valid: true });
});

app.get('/discord/lookup', async (req, res) => {
  res.json(await lookupDiscordUser((req.query.username || '').toString()));
});

app.post('/unlock', async (req, res) => {
  const { code, discord, sitePassword } = req.body || {};
  const s = await Store.get();
  if (s.paused) return res.json({ ok: false, reason: 'Site is paused.' });
  if (s.sitePassword && s.sitePassword !== (sitePassword || '')) return res.json({ ok: false, reason: 'Incorrect site password.' });
  if (!discord?.trim()) return res.json({ ok: false, reason: 'Discord username required.' });
  let discordInfo = null;
  if (discordReady) {
    discordInfo = await lookupDiscordUser(discord);
    if (!discordInfo.found || !discordInfo.inServer) return res.json({ ok: false, reason: 'You must join our Discord server first.' });
  }
  res.json(await Store.claimKey(code, getIp(req), discord, discordInfo));
});

app.post('/users/search', async (req, res) => {
  const kw = (req.body?.keyword || '').trim();
  if (!kw) return res.json({ data: [] });
  let results = [];
  try { const r = await fetch(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(kw)}&limit=10`); results = (await r.json())?.data || []; } catch {}
  if (!results.length) {
    try {
      const r = await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [kw], excludeBannedUsers: false }) });
      results = ((await r.json())?.data || []).map((u) => ({ id: u.id, name: u.name, displayName: u.displayName }));
    } catch {}
  }
  res.json({ data: results });
});

app.post('/users/headshots', async (req, res) => {
  const { userIds } = req.body || {};
  if (!userIds?.length) return res.json({ data: [] });
  try { const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(',')}&size=48x48&format=Png&isCircular=true`); res.json({ data: (await r.json())?.data || [] }); } catch { res.json({ data: [] }); }
});

app.get('/admin/state', async (_req, res) => {
  const s = await Store.get();
  res.json({ paused: s.paused, sitePassword: s.sitePassword, keys: s.keys, discord: discordReady, codeKeyword: CODE_KEYWORD });
});

app.post('/admin/keys', async (req, res) => {
  res.json(await Store.createKey(Number(req.body?.durationMs) || 24 * 60 * 60 * 1000));
});

app.delete('/admin/keys/:code', async (req, res) => {
  await Store.deleteKey(req.params.code);
  res.json({ ok: true });
});

app.post('/admin/clear-keys', async (_req, res) => {
  await Store.clearKeys();
  res.json({ ok: true });
});

app.post('/admin/keys/:code/pause', async (req, res) => {
  res.json(await Store.setKeyPaused(req.params.code, !!req.body?.paused));
});

app.post('/admin/pause', async (req, res) => {
  await Store.setPaused(!!req.body?.paused);
  res.json({ ok: true });
});

app.post('/admin/refresh-discord', async (_req, res) => {
  const s = await Store.get();
  for (const k of s.keys) {
    if (k.claimedByDiscord) {
      const info = await lookupDiscordUser(k.claimedByDiscord);
      if (info.found) k.discordInfo = info;
    }
  }
  await saveState(s);
  res.json({ ok: true, keys: s.keys });
});

const port = process.env.PORT || 3000;
connectDB().then(() => {
  app.listen(port, () => console.log(`🚀 Roblox backend on :${port}`));
});
