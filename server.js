const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use((req, res, next) => {
  if (req.path.endsWith(".glb")) res.type("model/gltf-binary");
  next();
});
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const chatMessages = [];
const clients = new Set();
const profiles = new Map();
const pendingRequests = new Map();
const clans = new Map();
const clanInvites = new Map();
const leaderboards = { cr: new Map(), best: new Map() };
let clanCounter = 1;

function newClanId() { return "CLAN-" + String(clanCounter++).padStart(3, "0"); }
function publicClan(id) {
  const c = clans.get(id);
  if (!c) return null;
  return { id: c.id, name: c.name, owner: c.owner, members: [...c.members], createdAt: c.createdAt };
}
function sendClanData(playerId) {
  const p = getProfile(playerId);
  const clan = p.clanId ? publicClan(p.clanId) : null;
  const invites = [...(clanInvites.get(p.id) || new Set())].map(publicClan).filter(Boolean);
  send(p.ws, { t: "clan_data", clan, invites });
}
function sendLeaderboard(ws) {
  const crRows = [...leaderboards.cr.values()].sort((a,b)=>b.cr-a.cr).slice(0,10);
  const bestRows = [...leaderboards.best.values()].sort((a,b)=>a.best-b.best).slice(0,10);
  send(ws, { t: "leaderboard_data", cr: crRows, best: bestRows });
}

function cleanText(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function onlineCount() {
  let n = 0;
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) n++;
  return n;
}
function getProfile(id) {
  id = cleanText(id, 18).toUpperCase();
  if (!profiles.has(id)) {
    profiles.set(id, { id, name: "Racer", public: true, online: false, lastSeen: Date.now(), friends: new Set(), ws: null, clanId: null, title: "Rookie Racer" });
  }
  return profiles.get(id);
}
function publicProfile(id) {
  const p = profiles.get(id);
  if (!p) return { id, name: "Unknown", online: false };
  return {
    id: p.id,
    name: p.name || "Racer",
    online: !!p.online,
    lastSeen: p.lastSeen || Date.now(),
    racing: !!(p.ws && p.ws.matchId),
    matchId: p.ws && p.ws.matchId ? p.ws.matchId : null,
    clanId: p.clanId || null,
    title: p.title || "Rookie Racer"
  };
}
function wsForPlayer(id) {
  const p = profiles.get(cleanText(id, 18).toUpperCase());
  return p && p.ws && p.ws.readyState === WebSocket.OPEN ? p.ws : null;
}
function sendRaceStatus(id) {
  const p = profiles.get(cleanText(id, 18).toUpperCase());
  if (!p || !p.ws) return;
  const friends = [...p.friends].map(publicProfile);
  send(p.ws, {
    t: "friend_race_status",
    friends,
    racing: !!(p.ws && p.ws.matchId),
    matchId: p.ws && p.ws.matchId ? p.ws.matchId : null
  });
}
function notifyFriendsRaceStatus(id) {
  const p = profiles.get(cleanText(id, 18).toUpperCase());
  if (!p) return;
  sendRaceStatus(p.id);
  for (const fid of p.friends) sendRaceStatus(fid);
}
function sendFriendsData(id) {
  const p = getProfile(id);
  const requestsSet = pendingRequests.get(p.id) || new Set();
  send(p.ws, { t: "friends_data", friends: [...p.friends].map(publicProfile), requests: [...requestsSet].map(publicProfile), online: onlineCount() });
  sendClanData(p.id);
  sendLeaderboard(p.ws);
}
function notifyProfile(id, message) {
  const p = profiles.get(id);
  if (p && p.ws) send(p.ws, { t: "friend_notice", message });
  if (p) sendFriendsData(id);
}

const MAX_MATCH_PLAYERS = 5;
const matches = new Map();
let waitingMatchId = null;
let matchCounter = 1;

function newMatchId() { return "AUTO-" + String(matchCounter++).padStart(3, "0"); }
function matchMembers(matchId) { return matches.get(matchId) || new Set(); }
function broadcastMatch(matchId, obj) {
  const set = matchMembers(matchId);
  for (const p of set) send(p, obj);
}
function sendMatchPeers(matchId) {
  const set = matchMembers(matchId);
  const ids = [...set].map(p => p.id);
  for (const p of set) send(p, { t: "peers", ids });
}
function leaveMatch(ws) {
  if (!ws.matchId) return;
  const matchId = ws.matchId;
  const set = matches.get(matchId);
  if (set) {
    set.delete(ws);
    for (const p of set) send(p, { t: "left", id: ws.id });
    if (set.size === 0) {
      matches.delete(matchId);
      if (waitingMatchId === matchId) waitingMatchId = null;
    } else {
      sendMatchPeers(matchId);
      if (set.size >= 2) {
        if (waitingMatchId === matchId) waitingMatchId = null;
        broadcastMatch(matchId, { t: "match_started", matchId, count: set.size });
      } else {
        waitingMatchId = matchId;
        broadcastMatch(matchId, { t: "match_waiting", matchId, count: set.size });
      }
    }
  }
  const pid = ws.playerId;
  ws.matchId = null;
  ws.room = null;
  if (pid) notifyFriendsRaceStatus(pid);
}
function joinMatch(ws, matchId) {
  const set = matchMembers(matchId);
  if (set.size >= MAX_MATCH_PLAYERS) return false;
  leaveMatch(ws);
  set.add(ws);
  matches.set(matchId, set);
  ws.matchId = matchId;
  ws.room = matchId;
  if (ws.playerId) notifyFriendsRaceStatus(ws.playerId);
  sendMatchPeers(matchId);
  if (set.size === 1) {
    waitingMatchId = matchId;
    send(ws, { t: "match_waiting", matchId, count: 1 });
  } else {
    if (waitingMatchId === matchId) waitingMatchId = null;
    broadcastMatch(matchId, { t: "match_started", matchId, count: set.size });
  }
  return true;
}
function chooseAutoMatch() {
  for (const [id, set] of matches) if (set.size >= 2 && set.size < MAX_MATCH_PLAYERS) return id;
  if (waitingMatchId && matches.has(waitingMatchId) && matches.get(waitingMatchId).size < MAX_MATCH_PLAYERS) return waitingMatchId;
  const id = newMatchId();
  matches.set(id, new Set());
  waitingMatchId = id;
  return id;
}

// hidden old room support, kept so nothing breaks internally
const rooms = new Map();
function roomPin() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let pin = "";
  for (let i = 0; i < 6; i++) pin += chars[Math.floor(Math.random() * chars.length)];
  return pin;
}
function leaveRoom(ws) {
  if (!ws.room || ws.matchId === ws.room) return;
  const set = rooms.get(ws.room);
  if (set) {
    set.delete(ws);
    for (const p of set) send(p, { t: "left", id: ws.id });
    if (set.size === 0) rooms.delete(ws.room);
    else {
      const ids = [...set].map(p => p.id);
      for (const p of set) send(p, { t: "peers", ids });
    }
  }
  ws.room = null;
}
function broadcastRoom(ws, obj) {
  if (ws.matchId) {
    broadcastMatch(ws.matchId, obj);
    return;
  }
  if (!ws.room) return;
  const set = rooms.get(ws.room);
  if (!set) return;
  for (const p of set) if (p !== ws) send(p, obj);
}

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2, 10);
  clients.add(ws);
  send(ws, { t: "hello", id: ws.id });
  send(ws, { t: "chat_history", messages: chatMessages });
  broadcast({ t: "chat_online", count: onlineCount() });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "chat") {
      const name = cleanText(msg.name, 14) || "Racer";
      const text = cleanText(msg.text, 140);
      if (!text) return send(ws, { t: "chat_error", message: "Empty message." });
      const lower = text.toLowerCase();
      const blocked = ["nigger", "nigga", "fuck your mom", "kill yourself"];
      if (blocked.some(w => lower.includes(w))) return send(ws, { t: "chat_error", message: "Message blocked. Keep chat clean." });
      const entry = { t: "chat", name, text, time: Date.now() };
      chatMessages.push({ name, text, time: entry.time });
      while (chatMessages.length > 50) chatMessages.shift();
      broadcast(entry);
      return;
    }

    if (msg.t === "profile_register") {
      const id = cleanText(msg.id, 18).toUpperCase();
      if (!id) return;
      const p = getProfile(id);
      p.name = cleanText(msg.name, 32) || p.name || "Racer";
      p.title = cleanText(msg.title, 24) || p.title || "Rookie Racer";
      p.public = true;
      p.online = true;
      p.lastSeen = Date.now();
      p.ws = ws;
      ws.playerId = id;
      if (Array.isArray(msg.friends)) {
        for (const fidRaw of msg.friends) {
          const fid = cleanText(fidRaw, 18).toUpperCase();
          if (fid && fid !== id) p.friends.add(fid);
        }
      }
      send(ws, { t: "profile_ok", id: p.id, name: p.name, online: onlineCount() });
      sendFriendsData(id);
      sendRaceStatus(id);
      notifyFriendsRaceStatus(id);
      return;
    }

    if (msg.t === "friends_get") {
      const id = cleanText(msg.id, 18).toUpperCase();
      if (id) {
        sendFriendsData(id);
        sendRaceStatus(id);
      }
      return;
    }

    if (msg.t === "friend_request") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      if (!from || !target || from === target) return;
      const fromP = getProfile(from);
      getProfile(target);
      if (fromP.friends.has(target)) return send(ws, { t: "friend_notice", message: "Already friends." });
      if (!pendingRequests.has(target)) pendingRequests.set(target, new Set());
      pendingRequests.get(target).add(from);
      send(ws, { t: "friend_notice", message: "Friend request sent to " + target + "." });
      notifyProfile(target, (fromP.name || from) + " sent you a friend request.");
      sendFriendsData(from);
      return;
    }

    if (msg.t === "friend_accept") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      if (!from || !target) return;
      const reqs = pendingRequests.get(from);
      if (reqs) reqs.delete(target);
      const a = getProfile(from);
      const b = getProfile(target);
      a.friends.add(target);
      b.friends.add(from);
      notifyProfile(from, "Friend added.");
      notifyProfile(target, (a.name || from) + " accepted your friend request.");
      return;
    }

    if (msg.t === "friend_decline") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      const reqs = pendingRequests.get(from);
      if (reqs) reqs.delete(target);
      notifyProfile(from, "Request declined.");
      return;
    }

    if (msg.t === "friend_remove") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      const a = getProfile(from);
      const b = getProfile(target);
      a.friends.delete(target);
      b.friends.delete(from);
      notifyProfile(from, "Friend removed.");
      notifyProfile(target, (a.name || from) + " removed you from friends.");
      return;
    }



    if (msg.t === "leaderboard_submit") {
      const id = cleanText(msg.id, 18).toUpperCase();
      if (!id) return;
      const p = getProfile(id);
      p.name = cleanText(msg.name, 32) || p.name || "Racer";
      p.title = cleanText(msg.title, 24) || p.title || "Rookie Racer";
      const cr = Math.max(0, Math.floor(Number(msg.cr) || 0));
      const best = Number(msg.best);
      leaderboards.cr.set(id, { id, name: p.name, title: p.title, clanId: p.clanId || null, cr });
      if (best > 0 && Number.isFinite(best)) leaderboards.best.set(id, { id, name: p.name, title: p.title, clanId: p.clanId || null, best });
      sendLeaderboard(ws);
      return;
    }

    if (msg.t === "leaderboard_get") {
      sendLeaderboard(ws);
      return;
    }

    if (msg.t === "clan_create") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const name = cleanText(msg.name, 20) || "Racing Clan";
      if (!from) return;
      const p = getProfile(from);
      if (p.clanId) return send(ws, { t: "clan_notice", message: "You are already in a clan." });
      const id = newClanId();
      clans.set(id, { id, name, owner: from, members: new Set([from]), createdAt: Date.now() });
      p.clanId = id;
      send(ws, { t: "clan_notice", message: "Clan created: " + name });
      sendClanData(from);
      return;
    }

    if (msg.t === "clan_invite") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      if (!from || !target || from === target) return;
      const fromP = getProfile(from);
      if (!fromP.clanId) return send(ws, { t: "clan_notice", message: "Create or join a clan first." });
      if (!fromP.friends.has(target)) return send(ws, { t: "clan_notice", message: "You can only invite friends." });
      if (!clanInvites.has(target)) clanInvites.set(target, new Set());
      clanInvites.get(target).add(fromP.clanId);
      send(ws, { t: "clan_notice", message: "Clan invite sent." });
      const targetWs = wsForPlayer(target);
      if (targetWs) {
        send(targetWs, { t: "clan_invite_notice", from, fromName: fromP.name || from, clan: publicClan(fromP.clanId) });
        sendClanData(target);
      }
      return;
    }

    if (msg.t === "clan_accept") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const clanId = cleanText(msg.clanId, 16).toUpperCase();
      const p = getProfile(from);
      const c = clans.get(clanId);
      if (!p || !c) return;
      if (p.clanId) return send(ws, { t: "clan_notice", message: "Leave your clan first." });
      const inv = clanInvites.get(from);
      if (!inv || !inv.has(clanId)) return send(ws, { t: "clan_notice", message: "Clan invite expired." });
      inv.delete(clanId);
      c.members.add(from);
      p.clanId = clanId;
      send(ws, { t: "clan_notice", message: "Joined clan: " + c.name });
      for (const mid of c.members) sendClanData(mid);
      return;
    }

    if (msg.t === "clan_leave") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const p = getProfile(from);
      if (!p || !p.clanId) return;
      const c = clans.get(p.clanId);
      const oldClan = p.clanId;
      if (c) {
        c.members.delete(from);
        if (c.owner === from) c.owner = [...c.members][0] || "";
        if (c.members.size === 0) clans.delete(oldClan);
      }
      p.clanId = null;
      send(ws, { t: "clan_notice", message: "You left the clan." });
      sendClanData(from);
      if (c) for (const mid of c.members) sendClanData(mid);
      return;
    }

    if (msg.t === "friend_invite_race") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      if (!from || !target || from === target) return;
      const fromP = getProfile(from);
      const targetWs = wsForPlayer(target);
      if (!fromP.friends.has(target)) return send(ws, { t: "friend_notice", message: "You can only invite friends." });
      if (!ws.matchId) {
        const matchId = chooseAutoMatch();
        joinMatch(ws, matchId);
      }
      if (targetWs) {
        send(targetWs, { t: "race_invite", from, fromName: fromP.name || from, matchId: ws.matchId });
        send(ws, { t: "friend_notice", message: "Race invite sent." });
      } else {
        send(ws, { t: "friend_notice", message: "Friend is offline." });
      }
      if (from) notifyFriendsRaceStatus(from);
      return;
    }

    if (msg.t === "join_friend_race") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      if (!from || !target || from === target) return;
      const fromP = getProfile(from);
      if (!fromP.friends.has(target)) return send(ws, { t: "friend_notice", message: "You can only join friends." });
      const targetWs = wsForPlayer(target);
      if (!targetWs || !targetWs.matchId) return send(ws, { t: "friend_notice", message: "That friend is not racing right now." });
      const ok = joinMatch(ws, targetWs.matchId);
      if (!ok) return send(ws, { t: "match_full" });
      send(ws, { t: "joined_friend_race", target, matchId: targetWs.matchId });
      if (from) notifyFriendsRaceStatus(from);
      return;
    }

    if (msg.t === "join_match_id") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const matchId = cleanText(msg.matchId, 16).toUpperCase();
      if (!matchId || !matches.has(matchId)) return send(ws, { t: "friend_notice", message: "Race invite expired." });
      const ok = joinMatch(ws, matchId);
      if (!ok) return send(ws, { t: "match_full" });
      send(ws, { t: "joined_friend_race", target: "", matchId });
      if (from) notifyFriendsRaceStatus(from);
      return;
    }

    if (msg.t === "match_play") {
      const matchId = chooseAutoMatch();
      const ok = joinMatch(ws, matchId);
      if (!ok) return send(ws, { t: "match_full" });
      return;
    }

    if (msg.t === "match_leave") {
      leaveMatch(ws);
      send(ws, { t: "match_cancelled" });
      return;
    }

    if (msg.t === "create") {
      leaveMatch(ws);
      leaveRoom(ws);
      let pin = roomPin();
      while (rooms.has(pin)) pin = roomPin();
      rooms.set(pin, new Set([ws]));
      ws.room = pin;
      send(ws, { t: "created", room: pin });
      send(ws, { t: "peers", ids: [ws.id] });
      return;
    }

    if (msg.t === "join") {
      leaveMatch(ws);
      const pin = cleanText(msg.room, 8).toUpperCase();
      const set = rooms.get(pin);
      if (!set) return send(ws, { t: "error", message: "Room not found" });
      leaveRoom(ws);
      set.add(ws);
      ws.room = pin;
      send(ws, { t: "joined", room: pin });
      const ids = [...set].map(p => p.id);
      for (const p of set) send(p, { t: "peers", ids });
      return;
    }

    if (msg.t === "leave") {
      leaveRoom(ws);
      return;
    }

    if (msg.t === "state") {
      broadcastRoom(ws, { t: "state", from: ws.id, s: msg.s });
      return;
    }
  });

  ws.on("close", () => {
    leaveMatch(ws);
    leaveRoom(ws);
    if (ws.playerId && profiles.has(ws.playerId)) {
      const p = profiles.get(ws.playerId);
      p.online = false;
      p.lastSeen = Date.now();
      p.ws = null;
      notifyFriendsRaceStatus(ws.playerId);
    }
    clients.delete(ws);
    broadcast({ t: "chat_online", count: onlineCount() });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Mini Racer server running on port " + PORT);
});
