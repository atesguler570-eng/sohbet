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
  checkForUpdates();
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

const APK_INSTALLED = 2;
async function checkForUpdates() {
  try {
    const res = await fetch('/version.json');
    if (!res.ok) return;
    const v = await res.json();
    const stored = localStorage.getItem('sohbet-web');
    if (!stored) { localStorage.setItem('sohbet-web', v.web); }
    else if (stored !== v.web) {
      const auto = localStorage.getItem('sohbet-autoupdate') !== 'off';
      if (auto) { localStorage.setItem('sohbet-web', v.web); location.reload(); return; }
      const toast = document.getElementById('updateToast');
      if (toast) {
        toast.style.display = 'block';
        toast.textContent = 'Yeni sürüm hazır — Güncelle';
        toast.onclick = () => { localStorage.setItem('sohbet-web', v.web); location.reload(); };
      }
    }
    // APK varsa ve daha yeni sürüm varsa bildir
    if (window.AkisAndroid && v.apk && v.apk > APK_INSTALLED) {
      const toast = document.getElementById('updateToast');
      if (toast) {
        toast.style.display = 'block';
        toast.textContent = 'Yeni APK sürümü var — İndirmek için dokun';
        toast.onclick = () => { window.location.href = '/apk.html'; };
      }
    }
  } catch { /* çevrimdışı */ }
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

/* ---------- Ayarlar (bileşen tabanlı) ---------- */
document.getElementById('settingsBtn').addEventListener('click', openSettings);

let currentSettings = {};
let currentSection = 'account';

const SECTIONS = [
  { id: 'account', label: '👤 Hesap' },
  { id: 'privacy', label: '🔒 Gizlilik ve Güvenlik' },
  { id: 'notifications', label: '🔔 Bildirimler' },
  { id: 'messages', label: '💬 Mesajlar' },
  { id: 'appearance', label: '🎨 Görünüm' },
  { id: 'feed', label: '📰 Akış ve İçerik' },
  { id: 'posts', label: '📸 Gönderi ve Hikâye' },
  { id: 'social', label: '🎮 Arkadaşlar' },
  { id: 'accessibility', label: '♿ Erişilebilirlik' },
  { id: 'app', label: '📱 Uygulama' },
  { id: 'help', label: '🛡️ Yardım' },
  { id: 'advanced', label: '🧑‍💻 Gelişmiş' },
];

function openSettings() {
  document.querySelectorAll('.view').forEach((v) => v.style.display = 'none');
  document.getElementById('viewSettings').style.display = 'block';
  document.querySelectorAll('.bottom-nav button').forEach((b) => b.classList.remove('active'));
  renderSettings();
}

async function renderSettings() {
  const d = await api('/api/settings');
  currentSettings = d.settings;
  applySettings(currentSettings);
  const isAdmin = me && me.role === 'admin';
  const content = document.getElementById('settingsContent');
  const nav = SECTIONS.map((s) => `<button class="set-nav ${s.id === currentSection ? 'active' : ''}" data-section="${s.id}">${s.label}</button>`).join('');
  content.innerHTML = `
    <h1>⚙️ Ayarlar</h1>
    <div class="settings-layout">
      <aside class="settings-nav">${nav}${isAdmin ? '<button class="set-nav' + (currentSection === 'admin' ? ' active' : '') + '" data-section="admin">🛡️ Yönetim Paneli</button>' : ''}</aside>
      <div class="settings-body" id="settingsBody"></div>
    </div>`;
  content.querySelectorAll('.set-nav').forEach((b) => b.addEventListener('click', () => { currentSection = b.dataset.section; renderSettings(); }));
  renderSection(currentSection, currentSettings);
}

function renderSection(id, s) {
  const b = document.getElementById('settingsBody');
  b.innerHTML = SECTION_RENDERERS[id] ? SECTION_RENDERERS[id](s) : '';
  if (id === 'admin') loadAdmin();
  b.querySelectorAll('[data-toggle]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.toggle;
      const next = !currentSettings[key];
      currentSettings[key] = next;
      el.classList.toggle('on', !!next);
      api('/api/settings', { method: 'PATCH', body: { [key]: next } }).catch(() => {});
      applySettings(currentSettings);
    });
  });
  b.querySelectorAll('[data-select]').forEach((el) => {
    el.addEventListener('change', () => {
      api('/api/settings', { method: 'PATCH', body: { [el.dataset.select]: el.value } }).catch(() => {});
    });
  });
}

function toggleRow(key, label, value) {
  return `<div class="set-row"><label>${label}</label><div class="toggle ${value ? 'on' : ''}" data-toggle="${key}"></div></div>`;
}
function selectRow(key, label, value, options) {
  const opts = options.map(([k, v]) => `<option value="${k}" ${k === value ? 'selected' : ''}>${v}</option>`).join('');
  return `<div class="set-row"><label>${label}</label><select data-select="${key}">${opts}</select></div>`;
}
function header(label) { return `<div class="settings-h">${label}</div>`; }
function soon(label) { return `<div class="set-row"><label>${label}</label><span style="color:var(--muted);font-size:12px;">Yakında</span></div>`; }

const SECTION_RENDERERS = {
  account: (s) => `
    ${header('👤 Hesap Ayarları')}
    <div class="set-row"><label>Görünen ad</label><input value="${escapeHtml(me?.displayName || '')}" onchange="saveProfile('displayName', this.value)" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);" /></div>
    <div class="set-row"><label>Kullanıcı adı</label><input value="${escapeHtml(me?.username || '')}" onchange="changeUsername(this.value)" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);" /></div>
    <div class="set-row"><label>Biyografi</label><textarea onchange="saveProfile('bio', this.value)" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);width:200px;min-height:40px;">${escapeHtml(me?.bio || '')}</textarea></div>
    <div class="set-row"><label>Profil fotoğrafı</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="pickAvatar()">Değiştir</button></div>
    <div class="set-row"><label>Kapak fotoğrafı</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="pickCover()">Değiştir</button></div>
    ${selectRow('accountType', 'Hesap türü', s.accountType, [['personal','Kişisel'],['creator','İçerik Üretici']])}
    ${toggleRow('showCreateDate', 'Hesap oluşturma tarihini göster', s.showCreateDate)}
    <div class="set-row"><label>Hesap durumu</label><span style="color:var(--muted)">${me?.verified ? '✓ Doğrulandı' : 'Doğrulanmadı'}</span></div>
    <div class="set-row"><label>Şifre</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="changePassword()">Değiştir</button></div>
    <div class="set-row"><label>Hesap dondur</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="deactivateAccount()">Dondur</button></div>
    <div class="set-row"><label>Hesabı kalıcı sil</label><button class="btn danger" style="width:auto;padding:4px 10px;" onclick="deleteAccount()">Kalıcı Sil</button></div>
  `,
  privacy: (s) => `
    ${header('🔒 Gizlilik ve Güvenlik')}
    ${toggleRow('privateAccount', 'Gizli hesap', s.privateAccount)}
    ${toggleRow('searchable', 'Beni arama sonuçlarında göster', s.searchable)}
    ${toggleRow('activityStatus', 'Etkinlik durumunu göster', s.activityStatus)}
    ${toggleRow('showOnline', 'Çevrimiçi durumunu göster', s.showOnline)}
    ${toggleRow('showLastSeen', 'Son görülmeyi göster', s.showLastSeen)}
    ${selectRow('profileVisibility', 'Profilimi kimler görebilir', s.profileVisibility, [['public','Herkes'],['followers','Takipçilerim'],['private','Sadece ben']])}
    ${selectRow('postsVisibility', 'Gönderilerimi kimler görebilir', s.postsVisibility, [['public','Herkes'],['followers','Takipçilerim'],['private','Sadece ben']])}
    ${selectRow('storiesVisibility', 'Hikâyelerimi kimler görebilir', s.storiesVisibility, [['everyone','Herkes'],['followers','Takipçilerim'],['close','Yakın arkadaşlar'],['nobody','Kimse']])}
    ${selectRow('followersVisibility', 'Beni kimler takip edebilir', s.followersVisibility, [['everyone','Herkes'],['followers','Takipçilerim']])}
    ${selectRow('allowMessages', 'Kimler mesaj gönderebilir', s.allowMessages, [['everyone','Herkes'],['followers','Takipçilerim'],['friends','Arkadaşlarım']])}
    ${toggleRow('allowMessageRequests', 'Mesaj isteklerine izin ver', s.allowMessageRequests)}
    ${toggleRow('allowTagging', 'Etiketlemelere izin ver', s.allowTagging)}
    ${toggleRow('allowMentions', 'Bahsedilmelere izin ver', s.allowMentions)}
    ${toggleRow('twoFactorAuth', 'İki aşamalı doğrulama', s.twoFactorAuth)}
    ${toggleRow('securityAlerts', 'Güvenlik bildirimleri', s.securityAlerts)}
    ${toggleRow('suspiciousLoginAlert', 'Şüpheli giriş uyarıları', s.suspiciousLoginAlert)}
    <div class="set-row"><label>Engellenen hesaplar</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showBlocks()">Listele</button></div>
    <div class="set-row"><label>Sessize alınan hesaplar</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showMutes()">Listele</button></div>
    <div class="set-row"><label>Aktif oturumlar</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showSessions()">Görüntüle</button></div>
    <div class="set-row"><label>Güvenlik kayıtları</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showAudit()">Görüntüle</button></div>
  `,
  notifications: (s) => `
    ${header('🔔 Bildirimler')}
    ${toggleRow('notifications', 'Bildirimleri tamamen aç/kapat', s.notifications)}
    ${toggleRow('likeNotifications', 'Beğeniler', s.likeNotifications)}
    ${toggleRow('commentNotifications', 'Yorumlar', s.commentNotifications)}
    ${toggleRow('followNotifications', 'Takip istekleri', s.followNotifications)}
    ${toggleRow('newFollowerNotifications', 'Yeni takipçiler', s.newFollowerNotifications)}
    ${toggleRow('messageNotifications', 'Mesajlar', s.messageNotifications)}
    ${toggleRow('storyNotifications', 'Hikâyeler', s.storyNotifications)}
    ${toggleRow('liveNotifications', 'Canlı yayınlar', s.liveNotifications)}
    ${toggleRow('mentionNotifications', 'Bahsedilmeler', s.mentionNotifications)}
    ${toggleRow('tagNotifications', 'Etiketlenmeler', s.tagNotifications)}
    ${toggleRow('friendSuggestions', 'Arkadaş önerileri', s.friendSuggestions)}
    ${toggleRow('systemNotifications', 'Sistem', s.systemNotifications)}
    ${toggleRow('updateNotifications', 'Güncellemeler', s.updateNotifications)}
    ${toggleRow('sound', 'Bildirim sesleri', s.sound)}
    ${toggleRow('vibration', 'Titreşim', s.vibration)}
    ${toggleRow('dnd', 'Rahatsız Etmeyin modu', s.dnd)}
    ${selectRow('dndFrom', 'Rah.Et. başlangıç', s.dndFrom, [['21:00','21'],['22:00','22'],['23:00','23'],['00:00','00']])}
    ${selectRow('dndTo', 'Rah.Et. bitiş', s.dndTo, [['06:00','06'],['07:00','07'],['08:00','08'],['09:00','09']])}
  `,
  messages: (s) => `
    ${header('💬 Mesaj Ayarları')}
    ${toggleRow('allowMessageRequests', 'Mesaj istekleri', s.allowMessageRequests)}
    ${toggleRow('readReceipts', 'Okundu bilgisi', s.readReceipts)}
    ${toggleRow('typingIndicator', 'Yazıyor göstergesi', s.typingIndicator)}
    ${selectRow('allowMessages', 'Kimler mesaj gönderebilir', s.allowMessages, [['everyone','Herkes'],['followers','Takipçilerim'],['friends','Arkadaşlarım']])}
    ${toggleRow('messageFilter', 'Otomatik mesaj filtreleme', s.messageFilter)}
    ${toggleRow('groupInvites', 'Grup davetlerine izin ver', s.groupInvites)}
    ${selectRow('autoDownloadMedia', 'Medya otomatik indirme', s.autoDownloadMedia, [['always','Her zaman'],['wifi','Sadece Wi-Fi'],['never','Asla']])}
    ${toggleRow('closeFriends', 'Yakın arkadaşlar mesajları', s.closeFriends)}
    ${toggleRow('autoSaveDrafts', 'Taslakları otomatik kaydet', s.autoSaveDrafts)}
  `,
  appearance: (s) => `
    ${header('🎨 Görünüm ve Tema')}
    ${selectRow('theme', 'Tema', s.theme, [['dark','Koyu'],['light','Açık']])}
    ${selectRow('accent', 'Tema rengi', s.accent, [['#6c7bff','Mor-Mavi'],['#ff0050','Pembe'],['#ff6b6b','Kırmızı'],['#3dd68c','Yeşil'],['#f5c518','Sarı'],['#22d3ee','Turkuaz']])}
    ${selectRow('background', 'Arka plan', s.background, [['default','Varsayılan'],['aurora','Aurora'],['ocean','Okyanus'],['sunset','Gün Batımı']])}
    ${selectRow('fontSize', 'Yazı boyutu', s.fontSize, [['small','Küçük'],['medium','Orta'],['large','Büyük']])}
    ${selectRow('fontFamily', 'Yazı tipi', s.fontFamily, [['default','Varsayılan'],['serif','Serif'],['mono','Mono']])}
    ${toggleRow('transitionEffects', 'Geçiş efektleri', s.transitionEffects)}
    ${toggleRow('animation', 'Animasyonlar', s.animation)}
    ${toggleRow('reduceMotion', 'Hareketleri azalt', s.reduceMotion)}
    ${toggleRow('highContrast', 'Yüksek kontrast', s.highContrast)}
    ${toggleRow('colorBlindMode', 'Renk körlüğü desteği', s.colorBlindMode)}
  `,
  feed: (s) => `
    ${header('📰 Akış ve İçerik')}
    ${selectRow('feedOrder', 'Ana sayfa sıralaması', s.feedOrder, [['recommended','Önerilen'],['recent','En son'],['following','Takip ettiklerim']])}
    ${toggleRow('recommendedPosts', 'Önerilen gönderiler', s.recommendedPosts)}
    ${toggleRow('followingFeed', 'Takip edilenler akışı', s.followingFeed)}
    ${toggleRow('autoplayVideo', 'Video otomatik oynatma', s.autoplayVideo)}
    ${toggleRow('sensitiveContentFilter', 'Hassas içerik filtresi', s.sensitiveContentFilter)}
    ${toggleRow('hideUnwanted', 'İstenmeyen içerikleri gizle', s.hideUnwanted)}
    ${toggleRow('showLikedPosts', 'Beğenilenleri akışta göster', s.showLikedPosts)}
    ${toggleRow('showSaveCount', 'Kaydedilen sayısını göster', s.showSaveCount)}
    ${toggleRow('interestReset', 'Öneri algoritmasını sıfırla', s.interestReset)}
  `,
  posts: (s) => `
    ${header('📸 Gönderi ve Hikâye')}
    ${toggleRow('commentsEnabled', 'Yorumları aç/kapat', s.commentsEnabled)}
    ${toggleRow('showLikeCount', 'Beğeni sayılarını göster', s.showLikeCount)}
    ${toggleRow('allowDownload', 'İndirmeye izin ver', s.allowDownload)}
    ${toggleRow('allowShare', 'Paylaşma izni', s.allowShare)}
    ${toggleRow('allowStoryHide', 'Hikâye gizleme', s.allowStoryHide)}
    ${toggleRow('nearFriends', 'Yakın arkadaşlar', s.nearFriends)}
    ${toggleRow('storyArchive', 'Hikâye arşivi', s.storyArchive)}
    ${selectRow('storyDuration', 'Hikâye süresi', s.storyDuration, [['24h','24 saat'],['12h','12 saat'],['6h','6 saat']])}
    ${toggleRow('autoSaveDrafts', 'Taslakları otomatik kaydet', s.autoSaveDrafts)}
    ${toggleRow('tagApproval', 'Etiket onayı', s.tagApproval)}
    ${toggleRow('locationSharing', 'Konum paylaşımı', s.locationSharing)}
  `,
  social: (s) => `
    ${header('🎮 Arkadaş ve Sosyal')}
    ${toggleRow('friendRecommendations', 'Arkadaş önerileri', s.friendRecommendations)}
    ${toggleRow('showOnlineStatus', 'Arkadaş çevrimiçi durumu', s.showOnlineStatus)}
    ${toggleRow('searchable', 'Kullanıcı arama izni', s.searchable)}
    ${toggleRow('hideFriendList', 'Arkadaş listesini gizle', s.hideFriendList)}
    ${toggleRow('showFollowerCount', 'Takipçi sayısını göster', s.showFollowerCount)}
    ${toggleRow('showFollowingCount', 'Takip edilen sayısını göster', s.showFollowingCount)}
    ${toggleRow('nearFriends', 'Yakın arkadaşlar listesi', s.nearFriends)}
  `,
  accessibility: (s) => `
    ${header('♿ Erişilebilirlik')}
    ${toggleRow('screenReader', 'Ekran okuyucu desteği', s.screenReader)}
    ${toggleRow('captions', 'Altyazıları göster', s.captions)}
    ${toggleRow('autoCaptions', 'Otomatik video altyazısı', s.autoCaptions)}
    ${toggleRow('highContrast', 'Yüksek kontrast', s.highContrast)}
    ${toggleRow('colorBlindMode', 'Renk körlüğü desteği', s.colorBlindMode)}
    ${toggleRow('largeText', 'Büyük yazılar', s.largeText)}
    ${toggleRow('reduceMotion', 'Hareket azaltma', s.reduceMotion)}
    ${toggleRow('keyboardNav', 'Klavye ile gezinme', s.keyboardNav)}
  `,
  app: (s) => `
    ${header('📱 Uygulama Ayarları')}
    ${selectRow('language', 'Dil', s.language, [['tr','Türkçe'],['en','English']])}
    ${selectRow('country', 'Ülke/Bölge', s.country, [['TR','Türkiye'],['US','ABD'],['DE','Almanya'],['GB','İngiltere']])}
    ${selectRow('dateFormat', 'Tarih biçimi', s.dateFormat, [['dd.MM.yyyy','GG.AA.YYYY'],['MM/dd/yyyy','AA/GG/YYYY'],['yyyy-MM-dd','YYYY-AA-GG']])}
    ${selectRow('timeFormat', 'Saat biçimi', s.timeFormat, [['24h','24 saat'],['12h','12 saat']])}
    ${toggleRow('dataSaver', 'Veri tasarrufu', s.dataSaver)}
    ${toggleRow('autoUpdate', 'Otomatik güncelleme', s.autoUpdate)}
    ${toggleRow('batterySaver', 'Pil tasarrufu', s.batterySaver)}
    ${toggleRow('permissionsCamera', 'Kamera izni', s.permissionsCamera)}
    ${toggleRow('permissionsMicrophone', 'Mikrofon izni', s.permissionsMicrophone)}
    ${toggleRow('permissionsPhotos', 'Fotoğraf izni', s.permissionsPhotos)}
    ${toggleRow('permissionsLocation', 'Konum izni', s.permissionsLocation)}
    ${toggleRow('wifiOnly', 'Wi-Fi üzerinden indirme', s.wifiOnly)}
    ${toggleRow('offlineMode', 'Çevrimdışı mod', s.offlineMode)}
    <div class="set-row"><label>Önbelleği temizle</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="clearCache()">Temizle</button></div>
    <div class="set-row"><label>Depolama kullanımı</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showStorage()">Görüntüle</button></div>
    <div class="set-row"><label>Çöp kutusu</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showTrash()">Görüntüle</button></div>
    <div class="set-row"><label>Verileri dışa aktar</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="exportData()">İndir</button></div>
  `,
  help: (s) => `
    ${header('🛡️ Yardım')}
    <div class="set-row"><label>Yardım merkezi</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="alert('Yardım: ayarlar@sohbet.app')">Aç</button></div>
    <div class="set-row"><label>SSS</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="alert('SSS: Mesaj göndermek için sohbeti açın. Kaydedilenler profilinizde.')">Aç</button></div>
    <div class="set-row"><label>Sorun bildir</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="reportProblem()">Bildir</button></div>
    <div class="set-row"><label>Gizlilik politikası</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="alert('Verileriniz bu cihazda/sunucuda saklanır.')">Oku</button></div>
    <div class="set-row"><label>Kullanım şartları</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="alert('Sohbet: spam yasak, saygı şart.')">Oku</button></div>
    <div class="set-row"><label>Geri bildirim</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="reportProblem()">Gönder</button></div>
    <div class="set-row"><label>Topluluk kuralları</label><span style="color:var(--muted);font-size:12px;">Spam yok, saygı var</span></div>
    <div class="set-row"><label>Sürüm</label><span style="color:var(--muted)">Sohbet v1.1</span></div>
    ${soon('Hikâye özelliği')}
    ${soon('Canlı yayın')}
    ${soon('Ticari hesaplar')}
  `,
  advanced: (s) => `
    ${header('🧑‍💻 Gelişmiş Ayarlar')}
    <div class="set-row"><label>Aktif oturumlar</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="showSessions()">Görüntüle</button></div>
    <div class="set-row"><label>Verileri dışa aktar</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="exportData()">İndir</button></div>
    ${toggleRow('analytics', 'Kullanım istatistikleri', s.analytics)}
    ${toggleRow('adsPersonalization', 'Reklam kişiselleştirme', s.adsPersonalization)}
    ${toggleRow('personalization', 'Kişiselleştirme', s.personalization)}
    ${selectRow('recommendationAlgorithm', 'Öneri algoritması', s.recommendationAlgorithm, [['balanced','Dengeli'],['recent','Yeni'],['relevant','İlgili']])}
    ${toggleRow('experimentalFeatures', 'Deneysel özellikler', s.experimentalFeatures)}
    ${toggleRow('betaProgram', 'Beta programı', s.betaProgram)}
    <div class="set-row"><label>API erişimi</label><button class="btn secondary" style="width:auto;padding:4px 10px;" onclick="alert('API: /api/* — oturum cookie ile erişilir.')">Bilgi</button></div>
    ${soon('OAuth uygulaması')}
  `,
  admin: (s) => `
    ${header('🛡️ Yönetim Paneli')}
    <div id="adminBox">Yükleniyor...</div>
  `,
};

window.saveProfile = async function (field, value) {
  const body = {}; if (field === 'displayName') body.displayName = value; else body.bio = value;
  const d = await api('/api/me', { method: 'PATCH', body });
  me = d.user;
  alert('Kaydedildi');
};
window.changeUsername = async function (value) {
  try { const d = await api('/api/me/username', { method: 'PATCH', body: { username: value } }); me = d.user; alert('Kullanıcı adı güncellendi'); }
  catch (e) { alert(e.message); }
};
window.pickAvatar = function () {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('avatar', file);
    const res = await fetch('/api/me/avatar', { method: 'POST', credentials: 'same-origin', body: fd });
    const d = await res.json();
    if (res.ok) { me = d.user; alert('Profil fotoğrafı güncellendi'); } else alert(d.error);
  };
  input.click();
};
window.pickCover = function () {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('cover', file);
    const res = await fetch('/api/me/cover', { method: 'POST', credentials: 'same-origin', body: fd });
    const d = await res.json();
    if (res.ok) { me = d.user; alert('Kapak güncellendi'); } else alert(d.error);
  };
  input.click();
};
window.changePassword = function () {
  const cur = prompt('Mevcut şifre:'); if (cur === null) return;
  const next = prompt('Yeni şifre:'); if (next === null) return;
  api('/api/me/password', { method: 'POST', body: { currentPassword: cur, newPassword: next } })
    .then(() => alert('Şifre değiştirildi'))
    .catch((e) => alert(e.message));
};
window.deactivateAccount = function () {
  if (!confirm('Hesabınızı dondurmak istediğinize emin misiniz?')) return;
  api('/api/me/deactivate', { method: 'POST' }).then(() => { alert('Hesap donduruldu'); location.reload(); }).catch((e) => alert(e.message));
};
window.deleteAccount = function () {
  if (!confirm('Hesabınızı kalıcı olarak silmek istediğinize emin misiniz?')) return;
  api('/api/me', { method: 'DELETE' }).then(() => location.reload()).catch((e) => alert(e.message));
};
window.showSessions = async function () {
  try {
    const d = await api('/api/sessions');
    alert('Aktif oturumlar:\n' + d.sessions.map(s => ((s.device || 'Cihaz').slice(0, 40)) + (s.current ? ' (bu cihaz)' : '')).join('\n'));
  } catch (e) { alert(e.message); }
};
window.showBlocks = async function () {
  try { const d = await api('/api/blocks'); alert('Engellenenler:\n' + ((d.users.map(u => '@' + u.username).join('\n')) || 'Yok')); } catch (e) { alert(e.message); }
};
window.showMutes = async function () {
  try { const d = await api('/api/mutes'); alert('Sessize alınanlar:\n' + ((d.users.map(u => '@' + u.username).join('\n')) || 'Yok')); } catch (e) { alert(e.message); }
};
window.showAudit = async function () {
  try { const d = await api('/api/audit'); alert('Güvenlik kayıtları:\n' + ((d.logs.map(l => new Date(l.created_at).toLocaleString('tr-TR') + ' — ' + l.action).join('\n')) || 'Kayıt yok')); } catch (e) { alert(e.message); }
};
window.reportProblem = function () {
  const what = prompt('Sorun nedir?'); if (!what) return;
  api('/api/reports', { method: 'POST', body: { target: 'app', reason: what } }).then(() => alert('Bildirildi, teşekkürler')).catch((e) => alert(e.message));
};
window.loadAdmin = async function () {
  const el = document.getElementById('adminBox');
  if (!el) return;
  try {
    const [o, ur, rpt] = await Promise.all([api('/api/admin/overview'), api('/api/admin/users'), api('/api/admin/reports')]);
    const users = ur.users.map(u => `<div class="set-row"><label>${u.verified ? '✓' : ''} @${escapeHtml(u.username)} (${u.role}) ${u.suspended ? '· askıda' : ''}</label><span><button class="btn secondary" style="width:auto;padding:2px 8px;margin-right:4px;" onclick="verifyUser(${u.id})">Doğrula</button><button class="btn danger" style="width:auto;padding:2px 8px;" onclick="suspendUser(${u.id})">Askıya Al</button></span></div>`).join('');
    const reports = rpt.reports.map(r => `<div class="set-row"><label>${escapeHtml(r.reporter)} → ${escapeHtml(r.target)}<br><small>${escapeHtml(r.reason)}</small></label></div>`).join('') || '<div class="set-row"><label>Rapor yok</label></div>';
    el.innerHTML = `
      <div class="set-row"><label>Kullanıcı sayısı</label><span>${o.users}</span></div>
      <div class="set-row"><label>Gönderi sayısı</label><span>${o.posts}</span></div>
      <div class="set-row"><label>Açık rapor</label><span>${o.openReports}</span></div>
      <div class="set-row"><label>Askıya alınan</label><span>${o.suspended}</span></div>
      ${header('👤 Kullanıcılar')}${users}
      ${header('🚩 Raporlar')}${reports}`;
  } catch (e) { el.textContent = e.message; }
};
window.verifyUser = async function (id) { try { await api('/api/admin/verify/' + id, { method: 'POST' }); loadAdmin(); } catch (e) { alert(e.message); } };
window.suspendUser = async function (id) { try { await api('/api/admin/suspend/' + id, { method: 'POST' }); loadAdmin(); } catch (e) { alert(e.message); } };

function applySettings(s) {
  const body = document.body;
  body.classList.remove('fs-small','fs-medium','fs-large');
  body.classList.add('fs-' + (s.fontSize || 'medium'));
  body.classList.toggle('light', s.theme === 'light');
  if (s.accent) body.style.setProperty('--accent', s.accent);
  body.classList.toggle('reduce-motion', s.reduceMotion);
  body.classList.toggle('high-contrast', s.highContrast);
  body.classList.toggle('colorblind', s.colorBlindMode);
  body.classList.toggle('large-text', s.largeText);
}


/* ---------- Init ---------- */
boot();
document.querySelector('.bottom-nav button[data-view="chat"]').classList.add('active');
