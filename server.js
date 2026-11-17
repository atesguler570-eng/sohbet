'use strict';

const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const http = require('node:http');

const { Server } = require('socket.io');
const { db, DATA_DIR } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.use(express.json({ limit: '1mb' }));

const now = () => Date.now();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  bio: u.bio,
  avatar: u.avatar,
  cover: u.cover || null,
});
function audit(userId, action, req) {
  try {
    const ip = req?.ip || req?.socket?.remoteAddress || null;
    db.prepare('INSERT INTO audit_logs (user_id, action, ip, created_at) VALUES (?,?,?,?)').run(userId, action, ip, now());
  } catch {}
}

const handle = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) { next(err); }
};

function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!row) return null;
  const stamp = now();
  const seen = db.prepare('SELECT last_seen FROM sessions WHERE token = ?').get(token)?.last_seen || 0;
  if (stamp - seen > 60 * 1000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(stamp, token);
  return row;
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Giris yapmalisin.' });
  req.user = user;
  next();
}
function optionalUser(req, res, next) {
  req.user = currentUser(req);
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 8);
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function removeFile(name) {
  if (!name) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch {}
}

/* ---------- Auth ---------- */
app.post('/api/register', handle((req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || '').trim() || username;
  if (!/^[a-z0-9._]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Kullanici adi 3-20 karakter (harf, rakam, nokta, alt cizgi).' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'Sifre en az 4 karakter olmali.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Bu kullanici adi alinmis.' });
  }
  const { hash, salt } = hashPassword(password);
  const info = db.prepare('INSERT INTO users (username, display_name, password_hash, salt, created_at) VALUES (?,?,?,?,?)')
    .run(username, displayName.slice(0, 40), hash, salt, now());
  const token = crypto.randomBytes(32).toString('hex');
  const stamp = now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, last_seen, user_agent) VALUES (?,?,?,?,?)')
    .run(token, Number(info.lastInsertRowid), stamp, stamp, String(req.headers['user-agent'] || '').slice(0, 400));
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
  audit(Number(info.lastInsertRowid), 'register', req);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  res.status(201).json({ user: publicUser(user) });
}));

app.post('/api/login', handle((req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return res.status(401).json({ error: 'Kullanici adi veya sifre hatali.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const stamp = now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, last_seen, user_agent) VALUES (?,?,?,?,?)')
    .run(token, user.id, stamp, stamp, String(req.headers['user-agent'] || '').slice(0, 400));
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
  audit(user.id, 'login', req);
  res.json({ user: publicUser(user) });
}));

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', optionalUser, (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

/* ---------- Kullanıcılar ---------- */
app.get('/api/users', requireAuth, handle((req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const me = req.user.id;
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare(`SELECT * FROM users WHERE id <> ? AND (username LIKE ? OR display_name LIKE ?) ORDER BY display_name COLLATE NOCASE LIMIT 50`).all(me, like, like);
  } else {
    rows = db.prepare('SELECT * FROM users WHERE id <> ? ORDER BY display_name COLLATE NOCASE LIMIT 50').all(me);
  }
  res.json({ users: rows.map(publicUser) });
}));

/* ---------- Sohbetler ---------- */
function memberOf(convId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, userId));
}

function convJson(conv, meId) {
  const members = db.prepare('SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ?').all(conv.id);
  const last = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(conv.id);
  const myMember = db.prepare('SELECT last_read_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conv.id, meId);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id <> ? AND created_at > ?').get(conv.id, meId, myMember?.last_read_at || 0).n;
  return {
    id: conv.id,
    type: conv.type,
    title: conv.title,
    members: members.map(publicUser),
    lastMessage: last ? { kind: last.kind, body: last.body, createdAt: last.created_at, mine: last.sender_id === meId } : null,
    unread,
    createdAt: conv.created_at,
    lastMessageAt: conv.last_message_at,
  };
}

app.get('/api/conversations', requireAuth, handle((req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE cm.user_id = ? ORDER BY c.last_message_at DESC`).all(me);
  res.json({ conversations: rows.map((c) => convJson(c, me)) });
}));

app.post('/api/conversations/direct/:username', requireAuth, handle((req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.params.username).toLowerCase());
  if (!target) return res.status(404).json({ error: 'Kullanici bulunamadi.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Kendinle sohbet baslatamazsin.' });

  // Mevcut direct sohbet var mı?
  const existing = db.prepare(`
    SELECT c.id FROM conversations c
    JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
    JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
    WHERE c.type = 'direct'`).get(req.user.id, target.id);
  if (existing) {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.id);
    return res.json({ conversation: convJson(conv, req.user.id) });
  }

  const stamp = now();
  const info = db.prepare('INSERT INTO conversations (type, title, created_at, last_message_at) VALUES (?,?,?,?)')
    .run('direct', null, stamp, stamp);
  const convId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?,?,?,?)').run(convId, req.user.id, stamp, stamp);
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?,?,?,?)').run(convId, target.id, stamp, 0);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  res.status(201).json({ conversation: convJson(conv, req.user.id) });
}));

app.post('/api/conversations/group', requireAuth, handle((req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 60) || 'Grup';
  const members = Array.isArray(req.body.members) ? req.body.members : [];
  const ids = [...new Set([req.user.id, ...members.map(Number).filter(Boolean)])];
  if (ids.length < 2) return res.status(400).json({ error: 'En az bir uye secmelisin.' });

  const stamp = now();
  const info = db.prepare('INSERT INTO conversations (type, title, created_at, last_message_at) VALUES (?,?,?,?)')
    .run('group', title, stamp, stamp);
  const convId = Number(info.lastInsertRowid);
  for (const uid of ids) {
    db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?,?,?,?)')
      .run(convId, uid, stamp, uid === req.user.id ? stamp : 0);
  }
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  res.status(201).json({ conversation: convJson(conv, req.user.id) });
}));

app.get('/api/conversations/:id', requireAuth, handle((req, res) => {
  const convId = Number(req.params.id);
  if (!memberOf(convId, req.user.id)) return res.status(404).json({ error: 'Sohbet bulunamadi.' });
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  res.json({ conversation: convJson(conv, req.user.id) });
}));

app.get('/api/conversations/:id/messages', requireAuth, handle((req, res) => {
  const convId = Number(req.params.id);
  if (!memberOf(convId, req.user.id)) return res.status(404).json({ error: 'Sohbet bulunamadi.' });
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ? AND m.id < ?
    ORDER BY m.id DESC LIMIT 80`).all(convId, before);
  rows.reverse();
  res.json({ messages: rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    body: m.body,
    mediaUrl: m.media_file ? `/media/${m.media_file}` : null,
    createdAt: m.created_at,
    mine: m.sender_id === req.user.id,
    sender: { id: m.sender_id, username: m.username, displayName: m.display_name, avatar: m.avatar },
  })) });
}));

app.post('/api/conversations/:id/messages', requireAuth, upload.fields([{ name: 'media', maxCount: 1 }]), handle((req, res) => {
  const convId = Number(req.params.id);
  if (!memberOf(convId, req.user.id)) return res.status(404).json({ error: 'Sohbet bulunamadi.' });
  const media = req.files?.media?.[0];
  const body = String(req.body.body || '').slice(0, 4000);
  if (!media && !body.trim()) return res.status(400).json({ error: 'Mesaj bos olamaz.' });

  const kind = media ? (media.mimetype.startsWith('video/') ? 'video' : (media.mimetype.startsWith('image/') ? 'image' : 'file')) : 'text';
  const stamp = now();
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_id, kind, body, media_file, created_at) VALUES (?,?,?,?,?,?)')
    .run(convId, req.user.id, kind, body, media?.filename || null, stamp);
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(stamp, convId);
  // diğer üyelere bildirim
  const others = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ?').all(convId, req.user.id);
  for (const o of others) addNotification(o.user_id, 'message', `${req.user.display_name}: ${body.slice(0, 80) || 'medya'}`);

  const row = db.prepare('SELECT m.*, u.username, u.display_name, u.avatar FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?').get(Number(info.lastInsertRowid));
  const msg = {
    id: row.id, kind: row.kind, body: row.body,
    mediaUrl: row.media_file ? `/media/${row.media_file}` : null,
    createdAt: row.created_at, mine: false,
    sender: { id: row.sender_id, username: row.username, displayName: row.display_name, avatar: row.avatar },
  };

  // Broadcast to room (herkese, mine client tarafında ayarlanacak)
  io.to('conv:' + convId).emit('message', { conversationId: convId, message: { ...msg, mine: undefined } });

  res.status(201).json({ message: { ...msg, mine: true } });
}));

app.post('/api/conversations/:id/read', requireAuth, handle((req, res) => {
  const convId = Number(req.params.id);
  if (!memberOf(convId, req.user.id)) return res.status(404).json({ error: 'Sohbet bulunamadi.' });
  const latest = db.prepare('SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ?').get(convId).t;
  const stamp = latest || now();
  db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(stamp, convId, req.user.id);
  res.json({ ok: true });
}));

/* ---------- Gönderiler / Feed / Reels ---------- */
function removeFile(name) { if (!name) return; try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch {} }

const POST_COLS = `p.id, p.media_type, p.media_file, p.poster_file, p.caption, p.created_at,
  u.id AS user_id, u.username, u.display_name, u.avatar`;

function mapPost(r, meId) {
  return {
    id: r.id,
    mediaType: r.media_type,
    mediaUrl: `/media/${r.media_file}`,
    posterUrl: r.poster_file ? `/media/${r.poster_file}` : null,
    caption: r.caption,
    createdAt: r.created_at,
    likeCount: r.like_count || 0,
    commentCount: r.comment_count || 0,
    liked: Boolean(r.liked),
    author: { id: r.user_id, username: r.username, displayName: r.display_name, avatar: r.avatar },
  };
}

app.get('/api/feed', optionalUser, handle((req, res) => {
  const me = req.user ? req.user.id : 0;
  const before = Number(req.query.before) || now() + 1;
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const rows = db.prepare(`
    SELECT ${POST_COLS},
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.created_at < ? AND p.deleted_at IS NULL
    ORDER BY p.created_at DESC LIMIT ?`).all(me, before, limit);
  res.json({ posts: rows.map((r) => mapPost(r, me)) });
}));

app.get('/api/reels', optionalUser, handle((req, res) => {
  const me = req.user ? req.user.id : 0;
  const limit = Math.min(Number(req.query.limit) || 12, 30);
  const rows = db.prepare(`
    SELECT ${POST_COLS},
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.media_type = 'video' AND p.deleted_at IS NULL
    ORDER BY p.created_at DESC LIMIT ?`).all(me, limit);
  res.json({ posts: rows.map((r) => mapPost(r, me)) });
}));

app.post('/api/posts', requireAuth, upload.fields([{ name: 'media', maxCount: 1 }, { name: 'poster', maxCount: 1 }]), handle((req, res) => {
  const media = req.files?.media?.[0];
  const poster = req.files?.poster?.[0];
  if (!media) return res.status(400).json({ error: 'Bir fotoğraf veya video seçmelisin.' });
  const mediaType = media.mimetype.startsWith('video/') ? 'video' : 'image';
  const caption = String(req.body.caption || '').slice(0, 2000);
  const info = db.prepare('INSERT INTO posts (user_id, media_type, media_file, poster_file, caption, created_at) VALUES (?,?,?,?,?,?)')
    .run(req.user.id, mediaType, media.filename, poster?.filename || null, caption, now());
  const row = db.prepare(`SELECT ${POST_COLS},
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      0 AS liked
    FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`).get(Number(info.lastInsertRowid));
  res.status(201).json({ post: mapPost(row, req.user.id) });
}));

app.delete('/api/posts/:id', requireAuth, handle((req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Gönderi bulunamadı.' });
  if (post.user_id !== req.user.id) return res.status(403).json({ error: 'Bu gönderi sana ait değil.' });
  db.prepare('UPDATE posts SET deleted_at = ? WHERE id = ?').run(now(), post.id);
  audit(req.user.id, 'post_deleted', req);
  res.json({ ok: true });
}));

/* ---------- Çöp Kutusu ---------- */
app.get('/api/trash', requireAuth, handle((req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`SELECT ${POST_COLS}, NULL AS deleted_flag FROM posts p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC`).all(me);
  res.json({ posts: rows.map((r) => mapPost(r, me)) });
}));

app.post('/api/posts/:id/restore', requireAuth, handle((req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Gönderi bulunamadı.' });
  if (post.user_id !== req.user.id) return res.status(403).json({ error: 'Bu gönderi sana ait değil.' });
  db.prepare('UPDATE posts SET deleted_at = NULL WHERE id = ?').run(post.id);
  audit(req.user.id, 'post_restored', req);
  res.json({ ok: true });
}));

app.delete('/api/trash/:id', requireAuth, handle((req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Gönderi bulunamadı.' });
  if (post.user_id !== req.user.id) return res.status(403).json({ error: 'Bu gönderi sana ait değil.' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  removeFile(post.media_file);
  removeFile(post.poster_file);
  audit(req.user.id, 'post_permanent_deleted', req);
  res.json({ ok: true });
}));

app.get('/api/audit', requireAuth, handle((req, res) => {
  const rows = db.prepare('SELECT action, ip, created_at FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json({ logs: rows });
}));

app.post('/api/posts/:id/like', requireAuth, handle((req, res) => {
  const postId = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId)) return res.status(404).json({ error: 'Gönderi bulunamadı.' });
  const existing = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').get(req.user.id, postId);
  if (existing) db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, postId);
  else db.prepare('INSERT INTO likes (user_id, post_id, created_at) VALUES (?,?,?)').run(req.user.id, postId, now());
  const count = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?').get(postId).c;
  res.json({ liked: !existing, likeCount: count });
}));

app.get('/api/posts/:id/comments', handle((req, res) => {
  const rows = db.prepare(`SELECT c.id, c.text, c.created_at, u.username, u.display_name, u.avatar
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT 200`).all(Number(req.params.id));
  res.json({ comments: rows.map((c) => ({ id: c.id, text: c.text, createdAt: c.created_at, author: { username: c.username, displayName: c.display_name, avatar: c.avatar } })) });
}));

app.post('/api/posts/:id/comments', requireAuth, handle((req, res) => {
  const postId = Number(req.params.id);
  const text = String(req.body.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Yorum boş olamaz.' });
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId)) return res.status(404).json({ error: 'Gönderi bulunamadı.' });
  const info = db.prepare('INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?,?,?,?)').run(postId, req.user.id, text, now());
  res.status(201).json({ comment: { id: Number(info.lastInsertRowid), text, createdAt: now(), author: { username: req.user.username, displayName: req.user.display_name, avatar: req.user.avatar } } });
}));

app.get('/api/users/:username', optionalUser, handle((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.params.username).toLowerCase());
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  const me = req.user ? req.user.id : 0;
  const posts = db.prepare(`SELECT ${POST_COLS},
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 60`).all(me, user.id);
  const followers = db.prepare('SELECT COUNT(*) AS c FROM follows WHERE followee_id = ?').get(user.id).c;
  const following = db.prepare('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?').get(user.id).c;
  const isFollowing = me ? Boolean(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(me, user.id)) : false;
  res.json({ user: publicUser(user), posts: posts.map((r) => mapPost(r, me)), followers, following, isFollowing });
}));

app.get('/api/search', optionalUser, handle((req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [], posts: [] });
  const me = req.user ? req.user.id : 0;
  const like = `%${q}%`;
  const users = db.prepare('SELECT * FROM users WHERE (username LIKE ? OR display_name LIKE ?) AND id <> ? ORDER BY display_name COLLATE NOCASE LIMIT 20').all(like, like, me);
  const postRows = db.prepare(`SELECT ${POST_COLS},
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id WHERE p.caption LIKE ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 24`).all(me, like);
  res.json({ users: users.map(publicUser), posts: postRows.map((r) => mapPost(r, me)) });
}));

/* ---------- Takip / Kaydet / Kapak ---------- */
app.post('/api/users/:username/follow', requireAuth, handle((req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.params.username).toLowerCase());
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Kendini takip edemezsin.' });
  const existing = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, target.id);
  if (existing) db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, target.id);
  else db.prepare('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?,?,?)').run(req.user.id, target.id, now());
  const followers = db.prepare('SELECT COUNT(*) AS c FROM follows WHERE followee_id = ?').get(target.id).c;
  res.json({ following: !existing, followers });
}));

app.post('/api/posts/:id/save', requireAuth, handle((req, res) => {
  const postId = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId)) return res.status(404).json({ error: 'Gönderi bulunamadı.' });
  const existing = db.prepare('SELECT 1 FROM saved_posts WHERE user_id = ? AND post_id = ?').get(req.user.id, postId);
  if (existing) db.prepare('DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?').run(req.user.id, postId);
  else db.prepare('INSERT INTO saved_posts (user_id, post_id, created_at) VALUES (?,?,?)').run(req.user.id, postId, now());
  res.json({ saved: !existing });
}));

app.get('/api/saved', requireAuth, handle((req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`SELECT ${POST_COLS},
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked
    FROM saved_posts s JOIN posts p ON p.id = s.post_id JOIN users u ON u.id = p.user_id
    WHERE s.user_id = ? AND p.deleted_at IS NULL ORDER BY s.created_at DESC`).all(me, me);
  res.json({ posts: rows.map((r) => mapPost(r, me)) });
}));

app.post('/api/me/cover', requireAuth, upload.single('cover'), handle((req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Bir görsel seçmelisin.' });
  const previous = db.prepare('SELECT cover AS f FROM users WHERE id = ?').get(req.user.id)?.f;
  db.prepare('UPDATE users SET cover = ? WHERE id = ?').run(file.filename, req.user.id);
  if (previous) removeFile(previous);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
}));

/* Update profile endpoint to include follow stats */
app.get('/api/users/:username/full', optionalUser, handle((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.params.username).toLowerCase());
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  const me = req.user ? req.user.id : 0;
  const posts = db.prepare(`SELECT ${POST_COLS},
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 60`).all(me, user.id);
  const followers = db.prepare('SELECT COUNT(*) AS c FROM follows WHERE followee_id = ?').get(user.id).c;
  const following = db.prepare('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?').get(user.id).c;
  const isFollowing = me ? Boolean(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(me, user.id)) : false;
  res.json({ user: publicUser(user), posts: posts.map((r) => mapPost(r, me)), followers, following, isFollowing });
}));

app.patch('/api/me', requireAuth, handle((req, res) => {
  const displayName = String(req.body.displayName ?? req.user.display_name).trim().slice(0, 40);
  const bio = String(req.body.bio ?? req.user.bio).slice(0, 200);
  db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(displayName || req.user.username, bio, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
}));

/* ---------- Ayarlar ---------- */
const DEFAULT_SETTINGS = {
  privateAccount: true,
  showOnline: true,
  showLastSeen: true,
  allowMessages: 'everyone',
  allowComments: true,
  allowTagging: true,
  allowMentions: true,
  showFollowerCount: true,
  showLikedPosts: true,
  notifications: true,
  sound: true,
  vibration: true,
  dnd: true,
  dndFrom: '22:00',
  dndTo: '08:00',
  autoplayVideo: true,
  dataSaver: false,
  fontSize: 'medium',
  language: 'tr',
  theme: 'dark',
  profileVisibility: 'public',
  reduceMotion: false,
  highContrast: false,
  autoDownloadMedia: 'always',
  autoSaveDrafts: true,
  locationSharing: true,
  analytics: true,
  autoDelete: true,
  cloudSync: true,
  autoBackup: true,
  wifiOnly: false,
};

function settingsOf(u) {
  let s = {};
  try { s = JSON.parse(u.settings || '{}'); } catch { s = {}; }
  return { ...DEFAULT_SETTINGS, ...s };
}

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ settings: settingsOf(req.user) });
});

app.patch('/api/settings', requireAuth, handle((req, res) => {
  const current = settingsOf(req.user);
  const next = { ...current, ...(req.body || {}) };
  // sadece bilinen anahtarları tut
  const clean = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) clean[k] = next[k];
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(clean), req.user.id);
  res.json({ settings: clean });
}));

app.post('/api/me/password', requireAuth, handle((req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (!verifyPassword(current, req.user.salt, req.user.password_hash)) {
    return res.status(401).json({ error: 'Mevcut şifre hatalı.' });
  }
  if (next.length < 4) return res.status(400).json({ error: 'Yeni şifre en az 4 karakter olmalı.' });
  const { hash, salt } = hashPassword(next);
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, req.user.id);
  audit(req.user.id, 'password_changed', req);
  const token = parseCookies(req.headers.cookie).sid || '';
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, token);
  res.json({ ok: true });
}));

app.delete('/api/me', requireAuth, handle((req, res) => {
  const token = parseCookies(req.headers.cookie).sid || '';
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/sessions', requireAuth, handle((req, res) => {
  const rows = db.prepare('SELECT token, created_at, last_seen, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(req.user.id);
  const token = parseCookies(req.headers.cookie).sid || '';
  res.json({ sessions: rows.map((r) => ({ id: r.token.slice(0, 16), current: r.token === token, createdAt: r.created_at, lastSeen: r.last_seen, device: r.user_agent || 'Bilinmeyen cihaz' })) });
}));

app.delete('/api/sessions/:id', requireAuth, handle((req, res) => {
  const row = db.prepare('SELECT token FROM sessions WHERE user_id = ? AND substr(token, 1, 16) = ?').get(req.user.id, String(req.params.id));
  if (!row) return res.status(404).json({ error: 'Oturum bulunamadı.' });
  db.prepare('DELETE FROM sessions WHERE token = ?').run(row.token);
  res.json({ ok: true });
}));

app.delete('/api/sessions', requireAuth, handle((req, res) => {
  const token = parseCookies(req.headers.cookie).sid || '';
  const info = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, token);
  res.json({ ok: true, closed: Number(info.changes) });
}));

app.post('/api/users/:username/block', requireAuth, handle((req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.params.username).toLowerCase());
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Kendini engelleyemezsin.' });
  const existing = db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(req.user.id, target.id);
  if (existing) db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, target.id);
  else db.prepare('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)').run(req.user.id, target.id, now());
  res.json({ blocked: !existing });
}));

app.post('/api/users/:username/mute', requireAuth, handle((req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.params.username).toLowerCase());
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  const existing = db.prepare('SELECT 1 FROM mutes WHERE muter_id = ? AND muted_id = ?').get(req.user.id, target.id);
  if (existing) db.prepare('DELETE FROM mutes WHERE muter_id = ? AND muted_id = ?').run(req.user.id, target.id);
  else db.prepare('INSERT INTO mutes (muter_id, muted_id, created_at) VALUES (?,?,?)').run(req.user.id, target.id, now());
  res.json({ muted: !existing });
}));

app.get('/api/blocks', requireAuth, handle((req, res) => {
  const rows = db.prepare('SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?').all(req.user.id);
  res.json({ users: rows.map(publicUser) });
}));

app.get('/api/mutes', requireAuth, handle((req, res) => {
  const rows = db.prepare('SELECT u.* FROM mutes m JOIN users u ON u.id = m.muted_id WHERE m.muter_id = ?').all(req.user.id);
  res.json({ users: rows.map(publicUser) });
}));

/* ---------- Bildirimler ---------- */
function addNotification(userId, type, text) {
  try {
    db.prepare('INSERT INTO notifications (user_id, type, text, created_at) VALUES (?,?,?,?)').run(userId, type, text, now());
  } catch {}
}

app.get('/api/notifications', requireAuth, handle((req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0').get(req.user.id).c;
  res.json({ notifications: rows, unread });
}));

app.post('/api/notifications/read', requireAuth, handle((req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
}));

/* ---------- Depolama ---------- */
function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile()) total += st.size;
    }
  } catch {}
  return total;
}

app.get('/api/storage', requireAuth, (req, res) => {
  const uploads = dirSize(UPLOAD_DIR);
  const dbFile = path.join(DATA_DIR, 'sohbet.db');
  const dbSize = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
  const me = req.user.id;
  const counts = {
    posts: db.prepare('SELECT COUNT(*) AS c FROM posts WHERE user_id = ?').get(me).c,
    messages: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ?').get(me).c,
    notifications: db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(me).c,
    sessions: db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(me).c,
  };
  res.json({ uploadsBytes: uploads, dbBytes: dbSize, ...counts });
});

app.get('/api/export', requireAuth, handle((req, res) => {
  const me = req.user.id;
  const data = {
    exportedAt: new Date().toISOString(),
    user: publicUser(req.user),
    posts: db.prepare('SELECT id, media_type, media_file, caption, created_at FROM posts WHERE user_id = ?').all(me),
    messages: db.prepare('SELECT id, conversation_id, kind, body, created_at FROM messages WHERE sender_id = ?').all(me),
    follows: db.prepare('SELECT followee_id, created_at FROM follows WHERE follower_id = ?').all(me),
    saved: db.prepare('SELECT post_id, created_at FROM saved_posts WHERE user_id = ?').all(me),
    notifications: db.prepare('SELECT type, text, created_at FROM notifications WHERE user_id = ?').all(me),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="sohbet-export.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data, null, 2));
}));

/* Otomatik silme (her saat) */
function cleanup() {
  const stamp = now();
  // 30 günden eski çöp kutusundaki gönderiler → kalıcı sil
  const oldTrash = db.prepare('SELECT media_file, poster_file FROM posts WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(stamp - 30 * 24 * 60 * 60 * 1000);
  for (const p of oldTrash) { removeFile(p.media_file); removeFile(p.poster_file); }
  db.prepare('DELETE FROM posts WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(stamp - 30 * 24 * 60 * 60 * 1000);
  // 180 günden eski güvenlik kayıtları
  db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(stamp - 180 * 24 * 60 * 60 * 1000);
  // 30 günden eski bildirimler
  db.prepare('DELETE FROM notifications WHERE created_at < ?').run(stamp - 30 * 24 * 60 * 60 * 1000);
  // 90 günden eski oturumlar
  db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(stamp - 90 * 24 * 60 * 60 * 1000);
  // 7 günden eski, hiçbir yerde kullanılmayan geçici dosyalar
  const referenced = new Set();
  for (const r of db.prepare("SELECT media_file AS f FROM posts WHERE media_file IS NOT NULL").all()) referenced.add(r.f);
  for (const r of db.prepare("SELECT poster_file AS f FROM posts WHERE poster_file IS NOT NULL").all()) referenced.add(r.f);
  for (const r of db.prepare("SELECT media_file AS f FROM messages WHERE media_file IS NOT NULL").all()) referenced.add(r.f);
  for (const r of db.prepare("SELECT avatar AS f FROM users WHERE avatar IS NOT NULL").all()) referenced.add(r.f);
  for (const r of db.prepare("SELECT cover AS f FROM users WHERE cover IS NOT NULL").all()) referenced.add(r.f);
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const fp = path.join(UPLOAD_DIR, f);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && !referenced.has(f) && st.mtimeMs < stamp - 7 * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(fp);
      }
    } catch {}
  }
}
setInterval(cleanup, 60 * 60 * 1000);
setTimeout(cleanup, 5000);

app.get('/Sohbet.apk', (req, res) => {
  const file = path.join(__dirname, 'apk', 'Sohbet.apk');
  if (!fs.existsSync(file)) return res.status(404).send('APK bulunamadı.');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="Sohbet.apk"');
  res.sendFile(file);
});

/* ---------- Statik ---------- */
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/presence', requireAuth, (_req, res) => {
  res.json({ online: [...onlineUsers.keys()] });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Bulunamadi.' });
  next();
});
app.use((err, _req, res, _next) => {
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'Dosya cok buyuk (en fazla 20 MB).' : (err.message || 'Hata.');
  res.status(status).json({ error: message });
});

/* ---------- Socket.io ---------- */
const onlineUsers = new Map(); // userId -> Set of socket ids

io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie || '';
  const cookies = parseCookies(cookieHeader);
  const token = cookies.sid;
  if (!token) return next(new Error('unauth'));
  const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!row) return next(new Error('unauth'));
  socket.user = row;
  next();
});

io.on('connection', (socket) => {
  const u = socket.user;
  if (!onlineUsers.has(u.id)) onlineUsers.set(u.id, new Set());
  onlineUsers.get(u.id).add(socket.id);
  // broadcast online
  io.emit('presence', { userId: u.id, online: true });

  // join user's conversation rooms
  const convs = db.prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ?').all(u.id);
  for (const c of convs) socket.join('conv:' + c.conversation_id);

  socket.on('join', (convId) => {
    if (memberOf(Number(convId), u.id)) socket.join('conv:' + convId);
  });

  socket.on('typing', (data) => {
    const convId = Number(data?.conversationId);
    if (!memberOf(convId, u.id)) return;
    socket.to('conv:' + convId).emit('typing', { conversationId: convId, userId: u.id, displayName: u.display_name, typing: Boolean(data?.typing) });
  });

  socket.on('disconnect', () => {
    const set = onlineUsers.get(u.id);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(u.id);
        io.emit('presence', { userId: u.id, online: false });
      }
    }
  });
});

/* ---------- Seed (ilk kurulumda demo hesaplar) ---------- */
function seedDemo() {
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (cnt > 0) return;
  const stamp = now();
  const { hash, salt } = hashPassword('demo1234');
  const insert = db.prepare('INSERT INTO users (username, display_name, password_hash, salt, created_at) VALUES (?,?,?,?,?)');
  const d1 = insert.run('demo', 'Demo', hash, salt, stamp);
  const d2 = insert.run('ayse', 'Ayşe', hash, salt, stamp);
  // demo ile ayse arasında hazır sohbet
  const convInfo = db.prepare('INSERT INTO conversations (type, title, created_at, last_message_at) VALUES (?,?,?,?)').run('direct', null, stamp, stamp);
  const cid = Number(convInfo.lastInsertRowid);
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?,?,?,?)').run(cid, Number(d1.lastInsertRowid), stamp, stamp);
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?,?,?,?)').run(cid, Number(d2.lastInsertRowid), stamp, 0);
  db.prepare('INSERT INTO messages (conversation_id, sender_id, kind, body, created_at) VALUES (?,?,?,?,?)').run(cid, Number(d2.lastInsertRowid), 'text', 'Merhaba! Demo sohbeti.', stamp);
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(stamp, cid);
}
seedDemo();
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddress();
  console.log('');
  console.log('  Sohbet calisiyor');
  console.log(`  Bu bilgisayar : http://localhost:${PORT}`);
  if (lan) console.log(`  Telefon        : http://${lan}:${PORT}   (ayni Wi-Fi aginda)`);
  console.log('');
});
