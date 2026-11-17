'use strict';
/* Bağımsız (çevrimdışı) mod: sunucu yok. Tüm veriler localStorage'da tutulur.
   Sadece file:// protokolünde etkinleşir (APK içinde). */
if (location.protocol === 'http:' || location.protocol === 'https:') {
  // Sunucu modunda shim devre dışı
} else (function () {
  const LS_KEY = 'sohbet-db';
  const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('sohbet') : null;

  function loadDB() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
  }
  function saveDB(db) { localStorage.setItem(LS_KEY, JSON.stringify(db)); }
  function rid(db, arr) { db[arr] = db[arr] || []; return db[arr]; }
  function now() { return Date.now(); }
  function uid(db, arr) {
    const a = rid(db, arr);
    return a.length ? Math.max(...a.map(x => x.id)) + 1 : 1;
  }
  function hash(p, salt) { return btoa(salt + ':' + p); }

  // İlk kurulum: demo hesaplar
  let db = loadDB();
  if (!db) {
    const salt = 'localsalt';
    db = {
      users: [
        { id: 1, username: 'demo', displayName: 'Demo', bio: '', avatar: null, cover: null, salt, hash: hash('demo1234', salt), createdAt: now() },
        { id: 2, username: 'ayse', displayName: 'Ayşe', bio: '', avatar: null, cover: null, salt, hash: hash('demo1234', salt), createdAt: now() },
      ],
      posts: [], comments: [], likes: [], follows: [], saved: [],
      conversations: [{ id: 1, type: 'direct', title: null, members: [1, 2], lastMessageAt: now(), lastRead: { 1: now(), 2: 0 }, createdAt: now() }],
      messages: [{ id: 1, conversationId: 1, senderId: 2, kind: 'text', body: 'Merhaba! Demo sohbeti.', mediaUrl: null, createdAt: now() }],
      notifications: [],
      settings: {},
      nextId: 100,
    };
    saveDB(db);
  }

  function curUser() {
    const u = loadDB();
    const sid = localStorage.getItem('sohbet-sid');
    if (!sid) return null;
    return u.users.find(x => x.id === Number(sid)) || null;
  }
  function requireUser() {
    const u = curUser();
    if (!u) throw { status: 401, data: { error: 'Giriş yapmalısın.' } };
    return u;
  }
  function publicUser(u) { return { id: u.id, username: u.username, displayName: u.displayName, bio: u.bio, avatar: u.avatar, cover: u.cover || null }; }
  function save(u) { localStorage.setItem('sohbet-sid', String(u.id)); }
  function clearSession() { localStorage.removeItem('sohbet-sid'); }

  async function readBody(body) {
    if (!body) return {};
    if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
    if (body instanceof FormData) {
      const out = {};
      const entries = [...body.entries()];
      for (const [k, v] of entries) {
        if (v instanceof File) {
          out[k + '_file'] = await fileToDataURL(v);
          out[k + '_type'] = v.type;
          out[k + '_name'] = v.name;
        } else out[k] = v;
      }
      return out;
    }
    return {};
  }
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  function convPresentation(c, me, u) {
    const others = c.members.filter(id => id !== me.id).map(id => u.users.find(x => x.id === id)).filter(Boolean);
    const last = [...u.messages].filter(m => m.conversationId === c.id).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    const unread = u.messages.filter(m => m.conversationId === c.id && m.senderId !== me.id && m.createdAt > (c.lastRead?.[me.id] || 0)).length;
    return {
      id: c.id, type: c.type, title: c.title,
      members: c.members.map(id => publicUser(u.users.find(x => x.id === id))).filter(m => m.username),
      lastMessage: last ? { kind: last.kind, body: last.body, createdAt: last.createdAt, mine: last.senderId === me.id } : null,
      unread, lastMessageAt: c.lastMessageAt, createdAt: c.createdAt,
    };
  }
  function findOrCreateDirect(u, me, target) {
    let c = u.conversations.find(c => c.type === 'direct' && c.members.includes(me.id) && c.members.includes(target.id));
    if (!c) {
      c = { id: uid(u, 'conversations'), type: 'direct', title: null, members: [me.id, target.id], lastMessageAt: now(), createdAt: now(), lastRead: { [me.id]: now(), [target.id]: 0 } };
      u.conversations.push(c);
    }
    return c;
  }

  const routes = {
    'GET /api/me': () => ({ user: curUser() ? publicUser(curUser()) : null }),
    'POST /api/login': async (u, me, b) => {
      const row = u.users.find(x => x.username === String(b.username || '').toLowerCase());
      if (!row || row.hash !== hash(String(b.password || ''), row.salt)) throw { status: 401, data: { error: 'Kullanıcı adı veya şifre hatalı.' } };
      save(row);
      return { user: publicUser(row) };
    },
    'POST /api/register': async (u, me, b) => {
      const username = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._]{3,20}$/.test(username)) throw { status: 400, data: { error: 'Geçersiz kullanıcı adı.' } };
      if (String(b.password || '').length < 4) throw { status: 400, data: { error: 'Şifre en az 4 karakter.' } };
      if (u.users.some(x => x.username === username)) throw { status: 409, data: { error: 'Bu kullanıcı adı alınmış.' } };
      const salt = 'salt' + now();
      const user = { id: uid(u, 'users'), username, displayName: String(b.displayName || username).slice(0, 40), bio: '', avatar: null, cover: null, salt, hash: hash(String(b.password), salt), createdAt: now() };
      u.users.push(user);
      save(user);
      return { user: publicUser(user) };
    },
    'POST /api/logout': () => { clearSession(); return { ok: true }; },
    'GET /api/presence': () => ({ online: [] }),
    'GET /api/users': (u, me, q) => {
      const query = String(q.q || '').toLowerCase();
      const users = u.users.filter(x => x.id !== me?.id && (!query || x.username.includes(query) || (x.displayName || '').toLowerCase().includes(query))).map(publicUser).slice(0, 50);
      return { users };
    },
    'GET /api/conversations': (u, me) => ({ conversations: u.conversations.filter(c => c.members.includes(me.id)).sort((a, b) => b.lastMessageAt - a.lastMessageAt).map(c => convPresentation(c, me, u)) }),
    'POST /api/conversations/direct/:username': (u, me, b, params) => {
      const target = u.users.find(x => x.username === String(params.username).toLowerCase());
      if (!target) throw { status: 404, data: { error: 'Kullanıcı bulunamadı.' } };
      const c = findOrCreateDirect(u, me, target);
      return { conversation: convPresentation(c, me, u) };
    },
    'POST /api/conversations/group': (u, me, b) => {
      const title = String(b.title || 'Grup').slice(0, 60) || 'Grup';
      const members = [...new Set([me.id, ...(Array.isArray(b.members) ? b.members.map(Number) : [])])];
      if (members.length < 2) throw { status: 400, data: { error: 'En az bir üye gerekli.' } };
      const c = { id: uid(u, 'conversations'), type: 'group', title, members, lastMessageAt: now(), createdAt: now(), lastRead: {} };
      u.conversations.push(c);
      return { conversation: convPresentation(c, me, u) };
    },
    'GET /api/conversations/:id': (u, me, b, params) => {
      const c = u.conversations.find(c => c.id === Number(params.id) && c.members.includes(me.id));
      if (!c) throw { status: 404, data: { error: 'Sohbet bulunamadı.' } };
      return { conversation: convPresentation(c, me, u) };
    },
    'GET /api/conversations/:id/messages': (u, me, b, params) => {
      const cid = Number(params.id);
      const c = u.conversations.find(x => x.id === cid && x.members.includes(me.id));
      if (!c) throw { status: 404, data: { error: 'Sohbet bulunamadı.' } };
      const messages = u.messages.filter(m => m.conversationId === cid).sort((a, b) => a.id - b.id).map(m => ({
        id: m.id, kind: m.kind, body: m.body, mediaUrl: m.mediaUrl, createdAt: m.createdAt,
        mine: m.senderId === me.id, sender: publicUser(u.users.find(x => x.id === m.senderId)),
      }));
      return { messages };
    },
    'POST /api/conversations/:id/messages': async (u, me, b, params) => {
      const cid = Number(params.id);
      const c = u.conversations.find(x => x.id === cid && x.members.includes(me.id));
      if (!c) throw { status: 404, data: { error: 'Sohbet bulunamadı.' } };
      const msg = { id: uid(u, 'messages'), conversationId: cid, senderId: me.id, kind: b.media_file ? (b.media_type?.startsWith('video') ? 'video' : 'image') : 'text', body: String(b.body || '').slice(0, 4000), mediaUrl: b.media_file || null, createdAt: now() };
      u.messages.push(msg);
      c.lastMessageAt = msg.createdAt;
      bc && bc.postMessage({ type: 'message', conversationId: cid, message: msg });
      // bildirim
      c.members.filter(id => id !== me.id).forEach(id => {
        u.notifications.push({ id: uid(u, 'notifications'), userId: id, type: 'message', text: me.displayName + ': ' + (msg.body || 'medya').slice(0, 80), read: 0, createdAt: now() });
      });
      return { message: { id: msg.id, kind: msg.kind, body: msg.body, mediaUrl: msg.mediaUrl, createdAt: msg.createdAt, mine: true, sender: publicUser(me) } };
    },
    'POST /api/conversations/:id/read': (u, me, b, params) => {
      const c = u.conversations.find(x => x.id === Number(params.id) && x.members.includes(me.id));
      if (c) { c.lastRead = c.lastRead || {}; c.lastRead[me.id] = now(); }
      return { ok: true };
    },
    'GET /api/feed': (u, me) => ({ posts: u.posts.slice().sort((a, b) => b.createdAt - a.createdAt).map(p => postJson(u, p, me)) }),
    'GET /api/reels': (u, me) => ({ posts: u.posts.filter(p => p.mediaType === 'video').slice().sort((a, b) => b.createdAt - a.createdAt).map(p => postJson(u, p, me)) }),
    'GET /api/search': (u, me, q) => {
      const query = String(q.q || '').toLowerCase();
      if (!query) return { users: [], posts: [] };
      const users = u.users.filter(x => x.id !== me.id && (x.username.includes(query) || x.displayName.toLowerCase().includes(query))).map(publicUser);
      const posts = u.posts.filter(p => (p.caption || '').toLowerCase().includes(query)).sort((a, b) => b.createdAt - a.createdAt).map(p => postJson(u, p, me));
      return { users, posts };
    },
    'GET /api/users/:username': (u, me, b, params) => {
      const target = u.users.find(x => x.username === String(params.username).toLowerCase());
      if (!target) throw { status: 404, data: { error: 'Kullanıcı bulunamadı.' } };
      const posts = u.posts.filter(p => p.userId === target.id).sort((a, b) => b.createdAt - a.createdAt);
      const followers = u.follows.filter(f => f.followeeId === target.id).length;
      const following = u.follows.filter(f => f.followerId === target.id).length;
      const isFollowing = me ? u.follows.some(f => f.followerId === me.id && f.followeeId === target.id) : false;
      return { user: publicUser(target), posts: posts.map(p => postJson(u, p, me)), followers, following, isFollowing };
    },
    'POST /api/users/:username/follow': (u, me, b, params) => {
      const target = u.users.find(x => x.username === String(params.username).toLowerCase());
      if (!target) throw { status: 404, data: { error: 'Kullanıcı bulunamadı.' } };
      const existing = u.follows.find(f => f.followerId === me.id && f.followeeId === target.id);
      if (existing) u.follows = u.follows.filter(f => f !== existing);
      else u.follows.push({ followerId: me.id, followeeId: target.id, createdAt: now() });
      return { following: !existing, followers: u.follows.filter(f => f.followeeId === target.id).length };
    },
    'POST /api/posts': async (u, me, b) => {
      if (!b.media_file) throw { status: 400, data: { error: 'Bir medya seçmelisin.' } };
      const post = { id: uid(u, 'posts'), userId: me.id, mediaType: b.media_type?.startsWith('video') ? 'video' : 'image', mediaFile: b.media_file, posterFile: null, caption: String(b.caption || '').slice(0, 2000), createdAt: now() };
      u.posts.push(post);
      return { post: postJson(u, post, me) };
    },
    'DELETE /api/posts/:id': (u, me, b, params) => {
      const p = u.posts.find(p => p.id === Number(params.id));
      if (p && p.userId === me.id) u.posts = u.posts.filter(x => x !== p);
      return { ok: true };
    },
    'POST /api/posts/:id/like': (u, me, b, params) => {
      const postId = Number(params.id);
      const existing = u.likes.find(l => l.userId === me.id && l.postId === postId);
      if (existing) u.likes = u.likes.filter(l => l !== existing);
      else u.likes.push({ userId: me.id, postId, createdAt: now() });
      const count = u.likes.filter(l => l.postId === postId).length;
      return { liked: !existing, likeCount: count };
    },
    'POST /api/posts/:id/save': (u, me, b, params) => {
      const postId = Number(params.id);
      const existing = u.saved.find(s => s.userId === me.id && s.postId === postId);
      if (existing) u.saved = u.saved.filter(s => s !== existing);
      else u.saved.push({ userId: me.id, postId, createdAt: now() });
      return { saved: !existing };
    },
    'GET /api/saved': (u, me) => ({ posts: u.posts.filter(p => u.saved.some(s => s.userId === me.id && s.postId === p.id)).sort((a, b) => b.createdAt - a.createdAt).map(p => postJson(u, p, me)) }),
    'GET /api/posts/:id/comments': (u, me, b, params) => {
      const postId = Number(params.id);
      const comments = u.comments.filter(c => c.postId === postId).sort((a, b) => a.createdAt - b.createdAt).map(c => ({ id: c.id, text: c.text, createdAt: c.createdAt, author: publicUser(u.users.find(x => x.id === c.userId)) }));
      return { comments };
    },
    'POST /api/posts/:id/comments': (u, me, b, params) => {
      const postId = Number(params.id);
      const text = String(b.text || '').trim().slice(0, 1000);
      if (!text) throw { status: 400, data: { error: 'Yorum boş olamaz.' } };
      u.comments.push({ id: uid(u, 'comments'), postId, userId: me.id, text, createdAt: now() });
      return { comment: { id: u.comments[u.comments.length - 1].id, text, createdAt: now(), author: publicUser(me) } };
    },
    'POST /api/me/cover': async (u, me, b) => {
      if (!b.cover_file) throw { status: 400, data: { error: 'Görsel seçin.' } };
      const usr = u.users.find(x => x.id === me.id);
      usr.cover = b.cover_file;
      return { user: publicUser(usr) };
    },
    'POST /api/me/avatar': async (u, me, b) => {
      if (!b.avatar_file) throw { status: 400, data: { error: 'Görsel seçin.' } };
      const usr = u.users.find(x => x.id === me.id);
      usr.avatar = b.avatar_file;
      return { user: publicUser(usr) };
    },
    'PATCH /api/me': (u, me, b) => {
      const usr = u.users.find(x => x.id === me.id);
      if (b.displayName !== undefined) usr.displayName = String(b.displayName).trim().slice(0, 40) || usr.displayName;
      if (b.bio !== undefined) usr.bio = String(b.bio).slice(0, 200);
      if (b.accent) { /* yoksay */ }
      return { user: publicUser(usr) };
    },
    'GET /api/settings': (u, me) => ({ settings: u.settings || {} }),
    'PATCH /api/settings': (u, me, b) => {
      u.settings = u.settings || {};
      Object.assign(u.settings, b);
      return { settings: u.settings };
    },
    'POST /api/me/password': (u, me, b) => {
      const usr = u.users.find(x => x.id === me.id);
      if (usr.hash !== hash(String(b.currentPassword || ''), usr.salt)) throw { status: 401, data: { error: 'Mevcut şifre hatalı.' } };
      if (String(b.newPassword || '').length < 4) throw { status: 400, data: { error: 'Şifre en az 4 karakter.' } };
      usr.salt = 'salt' + now();
      usr.hash = hash(String(b.newPassword), usr.salt);
      return { ok: true };
    },
    'DELETE /api/me': (u, me) => {
      u.users = u.users.filter(x => x.id !== me.id);
      u.conversations = u.conversations.filter(c => !c.members.includes(me.id));
      u.messages = u.messages.filter(m => m.senderId !== me.id);
      clearSession();
      return { ok: true };
    },
    'GET /api/sessions': (u, me) => ({ sessions: [{ id: 'local', current: true, device: navigator.userAgent.slice(0, 60), createdAt: now(), lastSeen: now() }] }),
    'GET /api/storage': (u, me) => ({ uploadsBytes: 0, dbBytes: (localStorage.getItem(LS_KEY) || '').length, posts: u.posts.filter(p => p.userId === me.id).length, messages: u.messages.filter(m => m.senderId === me.id).length, notifications: u.notifications.filter(n => n.userId === me.id).length, sessions: 1 }),
    'GET /api/blocks': () => ({ users: [] }),
    'GET /api/mutes': () => ({ users: [] }),
    'POST /api/users/:username/block': () => ({ blocked: true }),
    'POST /api/users/:username/mute': () => ({ muted: true }),
    'GET /api/export': (u, me) => ({ user: publicUser(me), posts: u.posts, messages: u.messages, follows: u.follows, saved: u.saved, notifications: u.notifications }),
    'POST /api/notifications/read': () => ({ ok: true }),
    'GET /api/notifications': (u, me) => ({ notifications: u.notifications.filter(n => n.userId === me.id), unread: u.notifications.filter(n => n.userId === me.id && !n.read).length }),
  };

  function postJson(u, p, me) {
    const author = u.users.find(x => x.id === p.userId);
    return {
      id: p.id, mediaType: p.mediaType, mediaUrl: p.mediaFile, posterUrl: p.posterFile || null,
      caption: p.caption, createdAt: p.createdAt,
      likeCount: u.likes.filter(l => l.postId === p.id).length,
      commentCount: u.comments.filter(c => c.postId === p.id).length,
      liked: u.likes.some(l => l.postId === p.id && l.userId === me.id),
      author: publicUser(author),
    };
  }

  function route(path, method) {
    const m = routes[method + ' ' + path];
    if (m) return m;
    const parts = path.split('/').filter(Boolean);
    // parametreli rotalar
    const keys = Object.keys(routes).filter(k => k.startsWith(method + ' '));
    for (const k of keys) {
      const pattern = k.slice(method.length + 1);
      const segs = pattern.split('/').filter(Boolean);
      if (segs.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        if (segs[i].startsWith(':')) params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
        else if (segs[i] !== parts[i]) { ok = false; break; }
      }
      if (ok) return (u, me, b) => routes[k](u, me, b, params);
    }
    return null;
  }

  window.fetch = async function (input, init = {}) {
    const url = String(input);
    const method = (init.method || 'GET').toUpperCase();
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0];
    const query = new URLSearchParams((url.split('?')[1]) || '');
    const body = await readBody(init.body);
    const u = loadDB();
    const me = curUser();
    try {
      const fn = route(path, method);
      if (!fn) throw { status: 404, data: { error: 'Bulunamadı.' } };
      let result = await fn(u, me, Object.assign(body, Object.fromEntries(query.entries())));
      saveDB(u);
      return {
        ok: true, status: 200,
        json: async () => result,
        text: async () => JSON.stringify(result),
      };
    } catch (err) {
      if (err && err.status) {
        return { ok: false, status: err.status, json: async () => err.data || { error: 'Hata' }, text: async () => JSON.stringify(err.data || {}) };
      }
      // beklenmedik hata
      return { ok: false, status: 500, json: async () => ({ error: String(err && err.message || err) }), text: async () => String(err) };
    }
  };

  // Socket.io'nun yerini alan yerel haberleşme (aynı cihazda sekmeler arasında)
  const listeners = { message: [], presence: [], typing: [] };
  if (bc) {
    bc.onmessage = (ev) => {
      const d = ev.data;
      if (d && d.type === 'message' && listeners.message.length) {
        const u = loadDB();
        const msg = u.messages.find(m => m && m.id === d.message.id) || d.message;
        for (const fn of listeners.message) fn({ conversationId: d.conversationId, message: msg });
      }
    };
  }
  window.io = function () {
    return {
      id: 'local-' + Math.random(),
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      emit() {},
      close() {},
    };
  };
})();
