'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let me = null;
let socket = null;
let activeConv = null; // conversation object
let convs = [];
let onlineSet = new Set();
let typingTimers = {};
let typingState = false;

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function avatarEl(user, size) {
  if (user.avatar) return `<img src="/media/${user.avatar}" alt="" />`;
  const initial = (user.displayName || user.username || '?').charAt(0).toUpperCase();
  return initial;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

/* ---------- Auth ---------- */
let authMode = 'login';
function showAuth() {
  $('#authModal').style.display = 'grid';
}
function hideAuth() {
  $('#authModal').style.display = 'none';
}

$('#authSwitch').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'register' : 'login';
  $('#authTitle').textContent = authMode === 'login' ? 'Giriş' : 'Kayıt';
  $('#authSubmit').textContent = authMode === 'login' ? 'Giriş yap' : 'Kayıt ol';
  $('#displayNameField').style.display = authMode === 'register' ? 'block' : 'none';
  $('#authError').textContent = '';
});

$('#authSubmit').addEventListener('click', async () => {
  const username = $('#authUsername').value.trim();
  const password = $('#authPassword').value;
  const displayName = $('#authDisplayName').value.trim();
  $('#authError').textContent = '';
  try {
    if (authMode === 'login') {
      const d = await api('/api/login', { method: 'POST', body: { username, password } });
      me = d.user;
    } else {
      const d = await api('/api/register', { method: 'POST', body: { username, password, displayName } });
      me = d.user;
    }
    hideAuth();
    await boot();
  } catch (e) {
    $('#authError').textContent = e.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

/* ---------- Boot ---------- */
async function boot() {
  try {
    const d = await api('/api/me');
    me = d.user;
  } catch (e) {
    me = null;
  }
  if (!me) { showAuth(); return; }
  hideAuth();
  initSocket();
  await loadConversations();
  await loadPresence();
  if (window.innerWidth <= 760) {
    $('#sidebar').classList.add('open');
  } else if (convs.length) {
    openConversation(convs[0].id);
  }
}

/* ---------- Socket ---------- */
function initSocket() {
  socket = io({ withCredentials: true });
  socket.on('connect', () => {
    (convs || []).forEach((c) => socket.emit('join', c.id));
  });
  socket.on('message', (data) => {
    const convId = data.conversationId;
    // update conv list preview
    loadConversations().then(() => {
      if (activeConv && activeConv.id === convId) {
        // append message if not mine (mine already appended optimistically? we append on send)
        const msg = data.message;
        if (msg.sender.id !== me.id) {
          appendMessage({ ...msg, mine: false });
          scrollToBottom();
        }
      }
    });
  });
  socket.on('presence', (data) => {
    if (data.online) onlineSet.add(data.userId); else onlineSet.delete(data.userId);
    updatePresenceUI();
  });
  socket.on('typing', (data) => {
    if (!activeConv || activeConv.id !== data.conversationId) return;
    if (data.userId === me.id) return;
    const el = $('#typing');
    if (data.typing) {
      el.textContent = (data.displayName || 'Birisi') + ' yazıyor...';
      clearTimeout(typingTimers[data.userId]);
      typingTimers[data.userId] = setTimeout(() => { el.textContent = ''; }, 2000);
    } else {
      el.textContent = '';
    }
  });
}

async function loadPresence() {
  try {
    const d = await api('/api/presence');
    onlineSet = new Set(d.online);
    updatePresenceUI();
  } catch {}
}

function updatePresenceUI() {
  // update chat sub
  if (activeConv) {
    const otherMembers = activeConv.members.filter((m) => m.id !== me.id);
    const onlineCount = otherMembers.filter((m) => onlineSet.has(m.id)).length;
    const sub = activeConv.type === 'group'
      ? `${activeConv.members.length} üye · ${onlineCount} çevrimiçi`
      : (onlineSet.has(otherMembers[0]?.id) ? 'çevrimiçi' : 'çevrimdışı');
    $('#chatSub').textContent = sub;
  }
  // update conv list dots
  renderConvList();
}

/* ---------- Conversations ---------- */
async function loadConversations() {
  const d = await api('/api/conversations');
  convs = d.conversations;
  renderConvList();
}

function renderConvList() {
  const q = $('#searchInput').value.trim().toLowerCase();
  const list = $('#convList');
  list.innerHTML = '';
  const filtered = convs.filter((c) => {
    if (!q) return true;
    const name = convName(c).toLowerCase();
    const preview = (c.lastMessage?.body || '').toLowerCase();
    return name.includes(q) || preview.includes(q);
  });
  for (const c of filtered) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (activeConv && activeConv.id === c.id ? ' active' : '');
    const other = c.type === 'direct' ? c.members.find((m) => m.id !== me.id) : null;
    const online = other && onlineSet.has(other.id);
    item.innerHTML = `
      <div class="conv-avatar">${convAvatar(c)}</div>
      <div class="conv-info">
        <div class="conv-name">${escapeHtml(convName(c))}</div>
        <div class="conv-preview">${escapeHtml(c.lastMessage ? (c.lastMessage.mine ? 'Sen: ' : '') + c.lastMessage.body : 'Henüz mesaj yok')}</div>
      </div>
      <div class="conv-meta">
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}
        ${online ? '<span class="dot"></span>' : ''}
      </div>`;
    item.addEventListener('click', () => openConversation(c.id));
    list.appendChild(item);
  }
}

function convAvatar(c) {
  if (c.type === 'group') return '👥';
  const other = c.members.find((m) => m.id !== me.id);
  return avatarEl(other || c.members[0] || {}, 42);
}

function convName(c) {
  if (c.type === 'group') return c.title || 'Grup';
  const other = c.members.find((m) => m.id !== me.id);
  return other ? (other.displayName || other.username) : 'Sohbet';
}

async function openConversation(id) {
  const d = await api('/api/conversations/' + id);
  activeConv = d.conversation;
  // messages
  const md = await api('/api/conversations/' + id + '/messages');
  $('#messages').innerHTML = '';
  for (const m of md.messages) appendMessage(m);
  // UI
  $('#emptyState').style.display = 'none';
  $('#chatHead').style.display = 'flex';
  $('#inputBar').style.display = 'flex';
  $('#chatAvatar').innerHTML = convAvatar(activeConv);
  $('#chatName').textContent = convName(activeConv);
  updatePresenceUI();
  scrollToBottom();
  // mark read
  await api('/api/conversations/' + id + '/read', { method: 'POST' }).catch(() => {});
  await loadConversations();
  // socket join
  if (socket) socket.emit('join', id);
  // mobile
  $('#sidebar').classList.remove('open');
  $('#msgInput').focus();
}

function appendMessage(m) {
  const div = document.createElement('div');
  div.className = 'msg ' + (m.mine ? 'mine' : 'other');
  const showSender = activeConv && activeConv.type === 'group' && !m.mine;
  let mediaHtml = '';
  if (m.mediaUrl) {
    if (m.kind === 'image') mediaHtml = `<img src="${m.mediaUrl}" alt="" />`;
    else if (m.kind === 'video') mediaHtml = `<video src="${m.mediaUrl}" controls></video>`;
    else mediaHtml = `<a class="file-link" href="${m.mediaUrl}" target="_blank">Dosya</a>`;
  }
  div.innerHTML = `
    ${showSender ? `<div class="sender">${escapeHtml(m.sender.displayName || m.sender.username)}</div>` : ''}
    <div>${escapeHtml(m.body || '')}</div>
    ${mediaHtml}
    <div class="time">${formatTime(m.createdAt)}</div>`;
  $('#messages').appendChild(div);
}

function scrollToBottom() {
  const el = $('#messages');
  el.scrollTop = el.scrollHeight;
}

/* ---------- Send ---------- */
async function sendMessage() {
  const input = $('#msgInput');
  const body = input.value.trim();
  const file = $('#fileInput').files[0];
  if (!body && !file) return;
  if (!activeConv) return;

  const fd = new FormData();
  if (body) fd.append('body', body);
  if (file) fd.append('media', file);

  input.value = '';
  $('#fileInput').value = '';

  // optimistic
  const tempMsg = {
    id: 'tmp-' + Date.now(),
    kind: file ? (file.type.startsWith('video/') ? 'video' : (file.type.startsWith('image/') ? 'image' : 'file')) : 'text',
    body: body,
    mediaUrl: file ? URL.createObjectURL(file) : null,
    createdAt: Date.now(),
    mine: true,
    sender: me,
  };
  appendMessage(tempMsg);
  scrollToBottom();

  try {
    const d = await fetch('/api/conversations/' + activeConv.id + '/messages', {
      method: 'POST', credentials: 'same-origin', body: fd,
    });
    const data = await d.json();
    if (!d.ok) throw new Error(data.error);
    // replace temp? just leave; real message already broadcast to others. For self, optimistic stays.
  } catch (e) {
    alert(e.message);
  }
}

$('#sendBtn').addEventListener('click', sendMessage);
$('#msgInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  // typing
  if (socket && activeConv) {
    if (!typingState) {
      typingState = true;
      socket.emit('typing', { conversationId: activeConv.id, typing: true });
    }
    clearTimeout(window._typingStop);
    window._typingStop = setTimeout(() => {
      typingState = false;
      socket.emit('typing', { conversationId: activeConv.id, typing: false });
    }, 1200);
  }
});
$('#msgInput').addEventListener('input', () => {
  const ta = $('#msgInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
});

$('#attachBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', () => {
  if ($('#fileInput').files[0]) sendMessage();
});

/* ---------- Search / New chat ---------- */
$('#searchInput').addEventListener('input', renderConvList);

$('#newChatBtn').addEventListener('click', async () => {
  $('#newChatModal').style.display = 'grid';
  $('#userSearch').value = '';
  await loadUserPick('');
});
$('#closeNewChat').addEventListener('click', () => $('#newChatModal').style.display = 'none');
$('#overlay').addEventListener('click', () => $('#sidebar').classList.remove('open'));

async function loadUserPick(q) {
  const d = await api('/api/users?q=' + encodeURIComponent(q));
  const list = $('#userPickList');
  list.innerHTML = '';
  for (const u of d.users) {
    const div = document.createElement('div');
    div.className = 'user-pick';
    div.innerHTML = `<div class="av">${avatarEl(u, 34)}</div><div>${escapeHtml(u.displayName || u.username)}<div style="font-size:11px;color:var(--muted)">@${escapeHtml(u.username)}</div></div>`;
    div.addEventListener('click', async () => {
      $('#newChatModal').style.display = 'none';
      await api('/api/conversations/direct/' + u.username, { method: 'POST' });
      await loadConversations();
      const conv = convs.find((c) => c.type === 'direct' && c.members.some((m) => m.id === u.id));
      if (conv) openConversation(conv.id);
    });
    list.appendChild(div);
  }
}
$('#userSearch').addEventListener('input', (e) => loadUserPick(e.target.value));

/* Group */
$('#newGroupBtn').addEventListener('click', () => {
  $('#newChatModal').style.display = 'none';
  $('#groupModal').style.display = 'grid';
});
$('#closeGroup').addEventListener('click', () => $('#groupModal').style.display = 'none');
$('#createGroupBtn').addEventListener('click', async () => {
  const title = $('#groupName').value.trim();
  const names = $('#groupMembers').value.split(',').map((s) => s.trim()).filter(Boolean);
  // resolve usernames to ids
  const allUsers = (await api('/api/users')).users;
  const ids = [];
  for (const name of names) {
    const u = allUsers.find((x) => x.username.toLowerCase() === name.toLowerCase());
    if (u) ids.push(u.id);
  }
  try {
    const d = await api('/api/conversations/group', { method: 'POST', body: { title, members: ids } });
    $('#groupModal').style.display = 'none';
    await loadConversations();
    openConversation(d.conversation.id);
  } catch (e) { alert(e.message); }
});

/* ---------- Mobile ---------- */
$('#backBtn').addEventListener('click', () => {
  $('#sidebar').classList.add('open');
});
// hamburger: tap empty? Add a menu button in head when no conv? We'll open sidebar on title click for mobile
$('#chatName').addEventListener('click', () => {
  if (window.innerWidth <= 760) $('#sidebar').classList.add('open');
});

// swipe open sidebar from left edge
let touchStartX = 0;
document.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
document.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (touchStartX < 30 && dx > 60) $('#sidebar').classList.add('open');
  if (dx < -60 && $('#sidebar').classList.contains('open')) $('#sidebar').classList.remove('open');
});

/* ---------- Views / Feed / Reels / Profil ---------- */
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => (v.style.display = 'none'));
  const chat = document.getElementById('chat');
  if (name === 'chat') { chat.style.display = 'flex'; }
  else { chat.style.display = 'none'; document.getElementById('view' + name.charAt(0).toUpperCase() + name.slice(1)).style.display = 'block'; }
  document.querySelectorAll('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'feed') loadFeed();
  if (name === 'reels') loadReels();
  if (name === 'profile') loadProfile(me?.username);
}

document.querySelectorAll('.bottom-nav button').forEach((b) => {
  b.addEventListener('click', () => showView(b.dataset.view));
});

document.getElementById('feedSearch').addEventListener('input', () => loadFeed());

async function loadFeed() {
  const q = document.getElementById('feedSearch')?.value.trim() || '';
  let d;
  if (q) {
    d = await api('/api/search?q=' + encodeURIComponent(q));
  } else {
    d = await api('/api/feed?limit=30');
  }
  const grid = document.getElementById('feedGrid');
  grid.innerHTML = '';
  for (const p of d.posts) {
    const card = document.createElement('div');
    card.className = 'feed-card';
    const media = p.mediaType === 'video'
      ? `<video src="${p.mediaUrl}" muted></video>` : `<img src="${p.mediaUrl}" />`;
    card.innerHTML = `${media}
      <div class="cap">${escapeHtml(p.caption || p.author.displayName)}</div>
      <div class="feed-actions">
        <button class="fa-btn" data-like="${p.id}">${p.liked ? '❤️' : '🤍'} ${p.likeCount || 0}</button>
        <button class="fa-btn" data-comment="${p.id}">💬 ${p.commentCount || 0}</button>
        <button class="fa-btn" data-save="${p.id}">🔖</button>
      </div>`;
    card.addEventListener('click', () => openPost(p.id));
    grid.appendChild(card);
  }
  grid.querySelectorAll('[data-like]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); api('/api/posts/' + b.dataset.like + '/like', { method: 'POST' }).then(() => loadFeed()); }));
  grid.querySelectorAll('[data-comment]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openComments(b.dataset.comment); }));
  grid.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); api('/api/posts/' + b.dataset.save + '/save', { method: 'POST' }).then(() => loadFeed()); }));
}

async function loadReels() {
  const d = await api('/api/reels?limit=20');
  const wrap = document.getElementById('reelsWrap');
  wrap.innerHTML = '';
  for (const p of d.posts) {
    const reel = document.createElement('div');
    reel.className = 'reel';
    reel.innerHTML = `<video src="${p.mediaUrl}" ${p.posterUrl ? 'poster="' + p.posterUrl + '"' : ''} loop playsinline></video>
      <div class="overlay"><strong>${escapeHtml(p.author.displayName)}</strong><br>${escapeHtml(p.caption || '')}</div>
      <div class="reel-actions">
        <button class="fa-btn" data-like="${p.id}">${p.liked ? '❤️' : '🤍'} ${p.likeCount || 0}</button>
        <button class="fa-btn" data-comment="${p.id}">💬 ${p.commentCount || 0}</button>
        <button class="fa-btn" data-save="${p.id}">🔖</button>
        <button class="fa-btn" data-mute="${p.id}">🔊</button>
        <button class="fa-btn" data-share="${p.id}">↗</button>
      </div>
      <div class="heart-anim">❤️</div>`;
    wrap.appendChild(reel);
    // double tap to like
    const video = reel.querySelector('video');
    let lastTap = 0;
    video.addEventListener('click', () => {
      const t = Date.now();
      if (t - lastTap < 300) {
        api('/api/posts/' + p.id + '/like', { method: 'POST' }).then(() => {
          const heart = reel.querySelector('.heart-anim');
          heart.classList.remove('show');
          void heart.offsetWidth;
          heart.classList.add('show');
          loadReels();
        });
      } else {
        if (video.paused) video.play(); else video.pause();
      }
      lastTap = t;
    });
  }
  wrap.querySelectorAll('[data-like]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); api('/api/posts/' + b.dataset.like + '/like', { method: 'POST' }).then(() => loadReels()); }));
  wrap.querySelectorAll('[data-comment]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openComments(b.dataset.comment); }));
  wrap.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); api('/api/posts/' + b.dataset.save + '/save', { method: 'POST' }).then(() => loadReels()); }));
  wrap.querySelectorAll('[data-mute]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const v = b.closest('.reel').querySelector('video'); v.muted = !v.muted; b.textContent = v.muted ? '🔇' : '🔊'; }));
  wrap.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const url = window.location.origin + '/?reel=' + b.dataset.share; if (navigator.share) navigator.share({ url }); else prompt('Bağlantıyı kopyalayın:', url); }));
  // autoplay on scroll
  const videos = wrap.querySelectorAll('video');
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((e) => { const v = e.target.querySelector('video') || e.target; if (e.isIntersecting) v.play().catch(() => {}); else v.pause(); });
  }, { threshold: 0.6 });
  wrap.querySelectorAll('.reel').forEach((r) => obs.observe(r));
}

async function loadProfile(username) {
  if (!username) return;
  const d = await api('/api/users/' + username);
  const box = document.getElementById('profileBox');
  const u = d.user;
  const avatar = u.avatar ? `<img src="/media/${u.avatar}" />` : (u.displayName || u.username).charAt(0).toUpperCase();
  const cover = u.cover ? `style="background-image:url(/media/${u.cover});background-size:cover;background-position:center;"` : '';
  box.innerHTML = `
    <div class="profile-cover" ${cover}></div>
    <div class="profile-head">
      <div class="profile-avatar">${avatar}</div>
      <div style="flex:1;">
        <h2>${escapeHtml(u.displayName)}</h2>
        <div style="color:var(--muted)">@${escapeHtml(u.username)}</div>
        <div style="font-size:13px;margin-top:4px;">${escapeHtml(u.bio || '')}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px;">${d.followers || 0} takipçi · ${d.following || 0} takip · ${d.posts.length} gönderi</div>
        ${me && me.username === u.username ? `
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn secondary" style="width:auto;padding:6px 12px;" onclick="editProfile()">İsim/Biyografi düzenle</button>
            <button class="btn secondary" style="width:auto;padding:6px 12px;" onclick="document.getElementById('coverInput').click()">Arka plan değiştir</button>
            <button class="btn" style="width:auto;padding:6px 12px;" onclick="uploadVideo()">Video yükle</button>
            <button class="btn secondary" style="width:auto;padding:6px 12px;" onclick="showSaved()">Kaydettiklerim</button>
          </div>
          <input type="file" id="coverInput" hidden accept="image/*" />
        ` : (me ? `<button class="btn" style="margin-top:8px;max-width:160px;" onclick="toggleFollow('${u.username}', this)">${d.isFollowing ? 'Takipten çık' : 'Takip et'}</button>` : '')}
      </div>
    </div>
    <div class="profile-grid" id="profileGrid"></div>`;
  const grid = document.getElementById('profileGrid');
  for (const p of d.posts) {
    const media = p.mediaType === 'video' ? `<video src="${p.mediaUrl}" muted></video>` : `<img src="${p.mediaUrl}" />`;
    const div = document.createElement('div');
    div.innerHTML = media;
    grid.appendChild(div);
  }
  const ci = document.getElementById('coverInput');
  if (ci) ci.addEventListener('change', async () => {
    const file = ci.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('cover', file);
    const res = await fetch('/api/me/cover', { method: 'POST', credentials: 'same-origin', body: fd });
    const data = await res.json();
    if (res.ok) { alert('Arka plan güncellendi'); loadProfile(username); }
    else alert(data.error);
  });
}

async function showSaved() {
  try {
    const d = await api('/api/saved');
    const grid = document.getElementById('profileGrid');
    grid.innerHTML = '<h3 style="grid-column:1/-1;">Kaydettiklerim</h3>';
    if (!d.posts.length) { grid.innerHTML += '<div style="grid-column:1/-1;color:var(--muted);">Kaydedilen gönderi yok</div>'; return; }
    for (const p of d.posts) {
      const media = p.mediaType === 'video' ? `<video src="${p.mediaUrl}" muted></video>` : `<img src="${p.mediaUrl}" />`;
      const div = document.createElement('div');
      div.innerHTML = media;
      grid.appendChild(div);
    }
  } catch (e) { alert(e.message); }
}

async function toggleFollow(username, btn) {
  try {
    const d = await api('/api/users/' + username + '/follow', { method: 'POST' });
    btn.textContent = d.following ? 'Takipten çık' : 'Takip et';
  } catch (e) { alert(e.message); }
}

function editProfile() {
  const name = prompt('Yeni görünen ad:');
  const bio = prompt('Biyografi:');
  if (name === null && bio === null) return;
  api('/api/me', { method: 'PATCH', body: { displayName: name || undefined, bio: bio || undefined } })
    .then(() => { alert('Profil güncellendi'); loadProfile(me.username); })
    .catch((e) => alert(e.message));
}

function uploadVideo() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const caption = prompt('Açıklama (isteğe bağlı):') || '';
    const fd = new FormData();
    fd.append('media', file);
    fd.append('caption', caption);
    try {
      const res = await fetch('/api/posts', { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert('Video yüklendi!');
      loadProfile(me.username);
    } catch (e) { alert(e.message); }
  };
  input.click();
}

let activePostId = null;
function openPost(id) { openComments(id); }

async function openComments(id) {
  activePostId = id;
  document.getElementById('commentModal').style.display = 'grid';
  document.getElementById('commentInput').value = '';
  await loadComments(id);
}

function closeComments() {
  document.getElementById('commentModal').style.display = 'none';
}

async function loadComments(id) {
  try {
    const d = await api('/api/posts/' + id + '/comments');
    const list = document.getElementById('commentList');
    list.innerHTML = d.comments.length ? '' : '<div style="color:var(--muted);text-align:center;padding:20px;">Henüz yorum yok</div>';
    for (const c of d.comments) {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);';
      div.innerHTML = `<div style="width:32px;height:32px;border-radius:50%;background:var(--accent);display:grid;place-items:center;font-weight:700;">${(c.author.displayName||c.author.username).charAt(0).toUpperCase()}</div>
        <div><strong>${escapeHtml(c.author.displayName||c.author.username)}</strong>
          <div style="font-size:13px;">${escapeHtml(c.text)}</div>
        </div>`;
      list.appendChild(div);
    }
  } catch (e) { document.getElementById('commentList').innerHTML = '<div style="color:var(--danger);padding:20px;">'+escapeHtml(e.message)+'</div>'; }
}

async function submitComment() {
  const input = document.getElementById('commentInput');
  const text = input.value.trim();
  if (!text || !activePostId) return;
  try {
    await api('/api/posts/' + activePostId + '/comments', { method: 'POST', body: { text } });
    input.value = '';
    await loadComments(activePostId);
  } catch (e) { alert(e.message); }
}

function openUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const caption = prompt('Açıklama (isteğe bağlı):') || '';
    const fd = new FormData();
    fd.append('media', file);
    fd.append('caption', caption);
    try {
      const res = await fetch('/api/posts', { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert('Paylaşıldı!');
      if (document.getElementById('viewFeed').style.display !== 'none') loadFeed();
    } catch (e) { alert(e.message); }
  };
  input.click();
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

/* ---------- Ayarlar ---------- */
document.getElementById('settingsBtn').addEventListener('click', openSettings);

function openSettings() {
  document.querySelectorAll('.view').forEach((v) => v.style.display = 'none');
  document.getElementById('viewSettings').style.display = 'block';
  document.querySelectorAll('.bottom-nav button').forEach((b) => b.classList.remove('active'));
  loadSettings();
}

let currentSettings = {};
async function loadSettings() {
  const d = await api('/api/settings');
  currentSettings = d.settings;
  const s = d.settings;
  applySettings(s);
  const content = document.getElementById('settingsContent');
  content.innerHTML = `
    <h1>⚙️ Ayarlar</h1>

    <div class="settings-h">🔒 Gizlilik ve Güvenlik</div>
    ${toggleRow('privateAccount', 'Gizli hesap', s.privateAccount)}
    ${toggleRow('showOnline', 'Çevrimiçi durumunu göster', s.showOnline)}
    ${toggleRow('showLastSeen', 'Son görülmeyi göster', s.showLastSeen)}
    ${selectRow('allowMessages', 'Kimler mesaj gönderebilir', s.allowMessages, [['everyone','Herkes'],['friends','Sadece arkadaşlarım']])}
    ${toggleRow('allowComments', 'Yorumlara izin ver', s.allowComments)}
    ${toggleRow('allowTagging', 'Etiketlemelere izin ver', s.allowTagging)}
    <div class="set-row"><label>Engellenen hesaplar</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showBlocks()">Listele</button></div>
    <div class="set-row"><label>Sessize alınan hesaplar</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showMutes()">Listele</button></div>

    <div class="settings-h">🔔 Bildirimler</div>
    ${toggleRow('notifications', 'Bildirimler', s.notifications)}
    ${toggleRow('sound', 'Bildirim sesleri', s.sound)}
    ${toggleRow('vibration', 'Titreşim', s.vibration)}
    ${toggleRow('dnd', 'Rahatsız Etmeyin modu', s.dnd)}

    <div class="settings-h">🎨 Görünüm</div>
    ${selectRow('theme', 'Tema', s.theme, [['dark','Koyu'],['light','Açık']])}
    ${selectRow('fontSize', 'Yazı boyutu', s.fontSize, [['small','Küçük'],['medium','Orta'],['large','Büyük']])}
    ${toggleRow('reduceMotion', 'Hareketleri azalt', s.reduceMotion)}
    ${toggleRow('highContrast', 'Yüksek kontrast', s.highContrast)}

    <div class="settings-h">📰 Akış</div>
    ${toggleRow('autoplayVideo', 'Videoları otomatik oynat', s.autoplayVideo)}
    ${toggleRow('dataSaver', 'Veri tasarrufu', s.dataSaver)}
    ${selectRow('autoDownloadMedia', 'Medya indirme', s.autoDownloadMedia, [['always','Her zaman'],['wifi','Sadece Wi-Fi'],['never','Asla']])}
    ${toggleRow('showLikedPosts', 'Beğenilenleri akışta göster', s.showLikedPosts)}

    <div class="settings-h">👤 Profil</div>
    ${toggleRow('showFollowerCount', 'Takipçi sayısını göster', s.showFollowerCount)}
    ${selectRow('profileVisibility', 'Profilimi kimler görebilir', s.profileVisibility, [['public','Herkes'],['followers','Takipçilerim'],['private','Sadece ben']])}

    <div class="settings-h">🔔 Rahatsız Etmeyin</div>
    ${toggleRow('dnd', 'Rahatsız Etmeyin', s.dnd)}

    <div class="settings-h">🛡️ Gizlilik</div>
    ${toggleRow('allowMentions', 'Bahsedilmelere izin ver', s.allowMentions)}
    ${toggleRow('autoSaveDrafts', 'Taslakları otomatik kaydet', s.autoSaveDrafts)}
    ${toggleRow('locationSharing', 'Konum paylaşımı', s.locationSharing)}
    ${toggleRow('analytics', 'Kullanım istatistikleri', s.analytics)}

    <div class="settings-h">🌐 Dil ve Bölge</div>
    ${selectRow('language', 'Dil', s.language, [['tr','Türkçe'],['en','English']])}

    <div class="settings-h">📱 Hesap</div>
    <div class="set-row"><label>Şifre değiştir</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="changePassword()">Değiştir</button></div>
    <div class="set-row"><label>Hesabı kalıcı sil</label><button class="btn danger" style="width:auto;padding:4px 10px;" onclick="deleteAccount()">Sil</button></div>
    <div class="set-row"><label>Aktif oturumlar</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showSessions()">Görüntüle</button></div>

    <div class="settings-h">📱 Uygulama</div>
    <div class="set-row"><label>Önbelleği temizle</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="clearCache()">Temizle</button></div>

    <div class="settings-h">☁️ Depolama</div>
    ${toggleRow('autoDelete', 'Otomatik silme sistemi', s.autoDelete)}
    ${toggleRow('cloudSync', 'Bulut senkronizasyonu', s.cloudSync)}
    ${toggleRow('autoBackup', 'Otomatik yedekleme', s.autoBackup)}
    ${toggleRow('wifiOnly', 'Wi-Fi üzerinden indirme', s.wifiOnly)}
    <div class="set-row"><label>Depolama kullanımı</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showStorage()">Görüntüle</button></div>
    <div class="set-row"><label>Çöp kutusu</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showTrash()">Görüntüle</button></div>
    <div class="set-row"><label>Güvenlik kayıtları</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showAudit()">Görüntüle</button></div>
    <div class="set-row"><label>Verileri dışa aktar</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="exportData()">İndir</button></div>
    ${window.AkisAndroid ? '<div class="settings-h">🌐 Sunucu</div><div class="set-row"><label>Sunucuya bağlan</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="AkisAndroid.changeServer()">Bağlan</button></div>' : ''}
  `;
}

function toggleRow(key, label, value) {
  return `<div class="set-row"><label>${label}</label><div class="toggle ${value ? 'on' : ''}" onclick="toggleSetting('${key}', this)"></div></div>`;
}
function selectRow(key, label, value, options) {
  const opts = options.map(([k,v]) => `<option value="${k}" ${k===value?'selected':''}>${v}</option>`).join('');
  return `<div class="set-row"><label>${label}</label><select onchange="saveSetting('${key}', this.value)">${opts}</select></div>`;
}

async function toggleSetting(key, el) {
  const next = !el.classList.contains('on');
  el.classList.toggle('on', next);
  await saveSetting(key, next);
}
async function saveSetting(key, value) {
  currentSettings[key] = value;
  await api('/api/settings', { method: 'PATCH', body: { [key]: value } });
  applySettings(currentSettings);
}
async function showBlocks() {
  const d = await api('/api/blocks');
  const names = d.users.map(u => '@' + u.username).join('\n') || 'Engellenen kimse yok';
  alert('Engellenenler:\n' + names);
}
async function showMutes() {
  const d = await api('/api/mutes');
  const names = d.users.map(u => '@' + u.username).join('\n') || 'Sessize alınan kimse yok';
  alert('Sessize alınanlar:\n' + names);
}
async function showSessions() {
  const d = await api('/api/sessions');
  const list = d.sessions.map(s => `${s.device.slice(0,30)}${s.current?' (bu cihaz)':''}`).join('\n');
  alert('Aktif oturumlar:\n' + list);
}
function changePassword() {
  const cur = prompt('Mevcut şifre:');
  if (!cur) return;
  const next = prompt('Yeni şifre:');
  if (!next) return;
  api('/api/me/password', { method: 'POST', body: { currentPassword: cur, newPassword: next } })
    .then(() => alert('Şifre değiştirildi'))
    .catch((e) => alert(e.message));
}
async function deleteAccount() {
  if (!confirm('Hesabınızı kalıcı olarak silmek istediğinize emin misiniz?')) return;
  try {
    await api('/api/me', { method: 'DELETE' });
    location.reload();
  } catch (e) { alert(e.message); }
}
function clearCache() {
  if ('caches' in window) caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  alert('Önbellek temizlendi');
}

function applySettings(s) {
  const body = document.body;
  // font size
  body.classList.remove('fs-small','fs-medium','fs-large');
  body.classList.add('fs-' + (s.fontSize || 'medium'));
  // theme
  body.classList.toggle('light', s.theme === 'light');
  // reduce motion
  body.classList.toggle('reduce-motion', s.reduceMotion);
  body.classList.toggle('high-contrast', s.highContrast);
}

async function showStorage() {
  const d = await api('/api/storage');
  const kb = (b) => (b/1024).toFixed(1) + ' KB';
  const mb = (b) => (b/1024/1024).toFixed(2) + ' MB';
  alert(`📱 Depolama kullanımı\n\nVeritabanı: ${kb(d.dbBytes)}\nYüklenen dosyalar: ${mb(d.uploadsBytes)}\nGönderi sayısı: ${d.posts}\nMesaj sayısı: ${d.messages}\nBildirim: ${d.notifications}\nOturum: ${d.sessions}`);
}

async function exportData() {
  try {
    const res = await fetch('/api/export');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sohbet-export.json';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { alert(e.message); }
}

async function showTrash() {
  try {
    const d = await api('/api/trash');
    if (!d.posts.length) { alert('Çöp kutusu boş'); return; }
    const lines = d.posts.map((p) => `#${p.id} — ${p.caption || '(açıklama yok)'}`).join('\n');
    const id = prompt('Çöp kutusu:\n' + lines + '\n\nGeri yükle veya kalıcı sil için ID yazın (veya boş kapatın)');
    if (!id) return;
    const restore = confirm('#' + id + ' gönderisini geri yükle?\n(İptal = kalıcı sil)');
    if (restore) await api('/api/posts/' + id + '/restore', { method: 'POST' });
    else await api('/api/trash/' + id, { method: 'DELETE' });
    alert('İşlem tamam');
  } catch (e) { alert(e.message); }
}

async function showAudit() {
  try {
    const d = await api('/api/audit');
    const lines = d.logs.slice(0, 30).map((l) => `${new Date(l.created_at).toLocaleString('tr-TR')} — ${l.action}`).join('\n') || 'Kayıt yok';
    alert('Güvenlik kayıtları:\n' + lines);
  } catch (e) { alert(e.message); }
}

/* ---------- Init ---------- */
boot();
document.querySelector('.bottom-nav button[data-view="chat"]').classList.add('active');
