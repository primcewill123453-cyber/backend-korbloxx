import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

// ============================================================
// STORE
// ============================================================
const DATA_FILE = path.join(os.tmpdir(), 'roblox-clone-store.json');

const DEFAULT_STATE = { paused: false, sitePassword: '', keys: [] };

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) };
    }
  } catch {}
  return { ...DEFAULT_STATE };
}

function save(state) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); } catch {}
}

function generateCode() {
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X');
  return `${part()}-${part()}-${part()}-${part()}`;
}

const Store = {
  get: () => load(),
  setPaused(paused) { const s = load(); s.paused = paused; save(s); },
  createKey(durationMs) {
    const s = load();
    const key = { code: generateCode(), createdAt: Date.now(), expiresAt: Date.now() + durationMs, paused: false };
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
    if (key) { key.paused = paused; save(s); }
    return { ok: !!key };
  },
  claimKey(code, ip, discord, discordInfo) {
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
    key.discordInfo = discordInfo || null;
    key.claimedAt = Date.now();
    save(s);
    return { ok: true, key };
  },
  isIpUnlocked(ip) {
    const s = load();
    return s.keys.some((k) => k.claimedByIp === ip && k.expiresAt > Date.now() && !k.paused);
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
// DISCORD BOT
// ============================================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const CODE_KEYWORD = (process.env.DISCORD_CODE_KEYWORD || 'PRX').toUpperCase();

let discordReady = false;
let discordClient = null;

if (DISCORD_TOKEN && DISCORD_GUILD_ID) {
  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
    ],
    partials: [Partials.GuildMember, Partials.User],
  });
  discordClient.once('ready', () => {
    discordReady = true;
    console.log(`🤖 Discord bot ready as ${discordClient.user.tag}`);
  });
  discordClient.on('error', (e) => console.error('Discord error:', e?.message || e));
  discordClient.login(DISCORD_TOKEN).catch((e) => console.error('Discord login failed:', e?.message || e));
} else {
  console.warn('⚠️  Discord bot disabled — set DISCORD_TOKEN and DISCORD_GUILD_ID env vars.');
}

async function lookupDiscordUser(rawUsername) {
  const q = (rawUsername || '').trim().replace(/^@/, '').toLowerCase();
  if (!q) return { found: false, reason: 'no username' };
  if (!discordReady || !discordClient) return { found: false, reason: 'bot offline' };

  let guild;
  try {
    guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
  } catch (e) {
    console.error('guild fetch failed:', e?.message || e);
    return { found: false, reason: 'guild fetch failed' };
  }

  let member = null;

  // 1) Discord server-side search API (handles partial usernames)
  try {
    const results = await guild.members.search({ query: q, limit: 10 });
    member = results.find((m) => {
      const u = m.user;
      return (
        u.username?.toLowerCase() === q ||
        u.globalName?.toLowerCase() === q ||
        m.displayName?.toLowerCase() === q
      );
    }) || results.first();
  } catch (e) {
    console.error('members.search failed:', e?.message || e);
  }

  // 2) Fallback: full cache lookup
  if (!member) {
    try {
      await guild.members.fetch({ withPresences: true });
      const names = (m) => {
        const u = m.user;
        return [u.username, u.globalName, m.displayName]
          .filter(Boolean)
          .map((n) => n.toLowerCase());
      };
      member =
        guild.members.cache.find((m) => names(m).some((n) => n === q)) ||
        guild.members.cache.find((m) => names(m).some((n) => n.startsWith(q))) ||
        guild.members.cache.find((m) => names(m).some((n) => n.includes(q)));
    } catch (e) {
      console.error('members.fetch failed:', e?.message || e);
    }
  }

  if (!member) return { found: false, reason: 'not in server', inServer: false };

  try {
    const user = member.user;
    const avatarUrl = member.displayAvatarURL
      ? member.displayAvatarURL({ size: 128, extension: 'png' })
      : user.displayAvatarURL?.({ size: 128, extension: 'png' }) || '';

    let customStatus = '';
    const presence = member.presence;
    if (presence?.activities?.length) {
      const custom = presence.activities.find((a) => a.type === 4);
      if (custom?.state) customStatus = custom.state;
      else {
        const other = presence.activities[0];
        if (other?.state) customStatus = other.state;
        else if (other?.name) customStatus = other.name;
      }
    }
    const usesCode = customStatus.toUpperCase().includes(CODE_KEYWORD);

    return {
      found: true,
      inServer: true,
      id: user.id,
      username: user.username || '',
      displayName: member.displayName || user.globalName || user.username || '',
      avatarUrl,
      status: presence?.status || 'offline',
      customStatus,
      usesCode,
    };
  } catch (e) {
    console.error('member processing failed:', e?.message || e);
    return { found: false, reason: 'member processing failed' };
  }
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
  const fwd = (req.headers['x-forwarded-for'] || '').toString();
  return fwd.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

app.get('/', (_req, res) => res.send(`Roblox clone backend up. Discord: ${discordReady ? 'ready' : 'offline'}`));

app.get('/status', (_req, res) => {
  const s = Store.get();
  res.json({ paused: s.paused, hasSitePassword: !!s.sitePassword, discord: discordReady, codeKeyword: CODE_KEYWORD });
});

app.get('/check', (req, res) => {
  res.json({ unlocked: Store.isIpUnlocked(getIp(req)), status: Store.ipKeyStatus(getIp(req)) });
});

app.get('/discord/lookup', async (req, res) => {
  const username = (req.query.username || '').toString();
  res.json(await lookupDiscordUser(username));
});

app.post('/unlock', async (req, res) => {
  const { code, discord, sitePassword } = req.body || {};
  const s = Store.get();
  if (s.paused) return res.json({ ok: false, reason: 'Site is paused.' });
  if (s.sitePassword && s.sitePassword !== (sitePassword || '')) {
    return res.json({ ok: false, reason: 'Incorrect site password.' });
  }
  if (!discord?.trim()) return res.json({ ok: false, reason: 'Discord username required.' });
  let discordInfo = null;
  if (discordReady) {
    discordInfo = await lookupDiscordUser(discord);
    if (!discordInfo.found || !discordInfo.inServer) {
      return res.json({ ok: false, reason: 'You must join our Discord server first.' });
    }
  }
  res.json(Store.claimKey(code, getIp(req), discord, discordInfo));
});

app.post('/users/search', async (req, res) => {
  const { keyword } = req.body || {};
  if (!keyword?.trim()) return res.json({ data: [] });
  try {
    const r = await fetch(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(keyword)}&limit=10`);
    const data = await r.json();
    res.json({ data: data?.data || [] });
  } catch { res.json({ data: [] }); }
});

app.post('/users/headshots', async (req, res) => {
  const { userIds } = req.body || {};
  if (!userIds?.length) return res.json({ data: [] });
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(',')}&size=48x48&format=Png&isCircular=true`);
    const data = await r.json();
    res.json({ data: data?.data || [] });
  } catch { res.json({ data: [] }); }
});

app.get('/admin/state', (_req, res) => {
  const s = Store.get();
  res.json({ paused: s.paused, sitePassword: s.sitePassword, keys: s.keys, discord: discordReady, codeKeyword: CODE_KEYWORD });
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

app.post('/admin/refresh-discord', async (_req, res) => {
  const s = Store.get();
  for (const k of s.keys) {
    if (k.claimedByDiscord) {
      const info = await lookupDiscordUser(k.claimedByDiscord);
      if (info.found) k.discordInfo = info;
    }
  }
  save(s);
  res.json({ ok: true, keys: s.keys });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Roblox backend on :${port}`));
