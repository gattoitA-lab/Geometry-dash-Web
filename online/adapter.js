/* Adapter Cloudflare Worker per il server di Geometry Dash Web.
   Viene concatenato a GDCore da online/build.js. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Max-Age": "86400"
};
const lobbies = Object.create(null);
const OPTS = ["normal", "collision", "shared_death", "turns"];
let cachedState = null;
let saveChain = Promise.resolve();

function responseJson(status, obj) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { "Content-Type": "application/json" }
  });
}
function withCors(res) {
  var headers = new Headers(res.headers);
  Object.keys(CORS).forEach(function (k) { headers.set(k, CORS[k]); });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: headers });
}
function randomInt(n) {
  if (n <= 0) return 0;
  var a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}
function makeToken() {
  var a = new Uint8Array(24), out = "";
  crypto.getRandomValues(a);
  for (var i = 0; i < a.length; i++) out += a[i].toString(16).padStart(2, "0");
  return out;
}
function now() { return Date.now(); }

async function loadState(env) {
  if (!env.FILES) return cachedState;
  try {
    var obj = await env.FILES.get("state.json");
    if (!obj) { cachedState = null; return null; }
    cachedState = JSON.parse(await obj.text());
    return cachedState;
  } catch (e) {
    console.error("Lettura archivio fallita:", e && e.message);
    throw e;
  }
}

function persist(env, ctx) {
  if (!env.FILES) return saveChain;
  var snapshot = JSON.stringify(cachedState);
  saveChain = saveChain.then(function () {
    return env.FILES.put("state.json", snapshot);
  }).catch(function (e) {
    console.error("Salvataggio archivio fallito:", e && e.message);
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(saveChain);
  return saveChain;
}

function code() {
  var a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", s = "";
  for (var i = 0; i < 5; i++) s += a[randomInt(a.length)];
  return lobbies[s] ? code() : s;
}
function lobbyView(L, uid) {
  var ps = {};
  Object.keys(L.players).forEach(function (id) {
    var p = L.players[id];
    ps[id] = { name: p.name, state: p.state, dead: !!p.dead, seen: p.seen, host: id === L.host };
  });
  var tl = L.turn ? Math.max(0, Math.round((L.turn.until - now()) / 100) / 10) : null;
  return {
    code: L.code, host: L.host, status: L.status, options: L.options, turn_seconds: L.turn_seconds,
    level_id: L.level_id, level_name: L.level_name,
    restart: L.restart, players: ps, you: uid, go_in: Math.max(0, (L.go_at || 0) - now()),
    turn: L.turn ? { uid: L.turn.uid, seq: L.turn.seq, left: tl } : null
  };
}
function pickTurn(L, prevUid) {
  var ids = Object.keys(L.players);
  if (!ids.length) { L.turn = null; return; }
  var cand = ids.filter(function (i) { return i !== prevUid; });
  var pool = cand.length ? cand : ids;
  var prev = L.turn;
  L.turn = { uid: pool[randomInt(pool.length)], seq: (prev ? prev.seq : 0) + 1, until: Math.max(now(), L.go_at || 0) + L.turn_seconds * 1000 };
}
function tickLobby(L) {
  if (L.status === "playing" && L.options.indexOf("turns") >= 0 && (!L.turn || now() >= L.turn.until || !L.players[L.turn.uid]))
    pickTurn(L, L.turn ? L.turn.uid : null);
}
function pruneLobbies() {
  var t = now();
  Object.keys(lobbies).forEach(function (c) {
    var L = lobbies[c];
    Object.keys(L.players).forEach(function (id) {
      if (t - L.players[id].seen > 20000) {
        delete L.players[id];
        if (L.host === id) L.host = Object.keys(L.players)[0] || null;
      }
    });
    if (!Object.keys(L.players).length || t - L.created > 6 * 3600 * 1000) delete lobbies[c];
    else tickLobby(L);
  });
}

function lobbyRouteMemory(method, path, b, u, db, core) {
  var J = core.json, E = function (s, d) { return J(s, { detail: d }); };
  if (!u) return E(401, "Accedi per giocare in lobby");
  var m, L;
  if (path === "/lobbies" && method === "POST") {
    var opts = Array.isArray(b.options) ? b.options.filter(function (o) { return OPTS.indexOf(o) >= 0 && o !== "normal"; }) : [];
    var ts = Math.max(3, Math.min(300, +b.turn_seconds || 15));
    L = {
      code: code(), host: u.user_id, status: "waiting", options: opts.length ? opts : ["normal"], turn_seconds: ts,
      level_id: b.level_id && b.level_id !== "random" ? String(b.level_id) : "random", level_name: null, level_data: null,
      restart: 0, players: {}, turn: null, created: now()
    };
    if (L.level_id !== "random") {
      var lv = db.levels.filter(function (x) { return x.id === L.level_id; })[0];
      if (!lv || !(lv.published || lv.user_id === u.user_id)) return E(404, "Livello non trovato");
      L.level_name = lv.name;
    }
    L.players[u.user_id] = { name: u.username, state: null, seen: now() };
    lobbies[L.code] = L;
    return J(200, lobbyView(L, u.user_id));
  }
  m = /^\/lobbies\/([A-Za-z0-9]+)(?:\/(\w+))?$/.exec(path);
  if (!m) return null;
  L = lobbies[m[1].toUpperCase()];
  if (!L) return E(404, "Lobby non trovata (controlla il codice e che entrambi usiate lo stesso server)");
  var act = m[2];
  if (!act && method === "GET") {
    if (L.players[u.user_id]) L.players[u.user_id].seen = now();
    return J(200, lobbyView(L, u.user_id));
  }
  if (act === "join" && method === "POST") {
    if (!L.players[u.user_id]) {
      if (Object.keys(L.players).length >= 8) return E(409, "Lobby piena (massimo 8 giocatori)");
      L.players[u.user_id] = { name: u.username, state: null, seen: now() };
    }
    L.players[u.user_id].seen = now();
    return J(200, lobbyView(L, u.user_id));
  }
  if (!L.players[u.user_id]) return E(403, "Non sei in questa lobby");
  var P = L.players[u.user_id];
  P.seen = now();
  if (act === "leave" && method === "POST") {
    delete L.players[u.user_id];
    if (L.host === u.user_id) L.host = Object.keys(L.players)[0] || null;
    if (!L.host) delete lobbies[L.code];
    return J(200, { ok: true });
  }
  if (act === "start" && method === "POST") {
    if (L.host !== u.user_id) return E(403, "Solo chi ha creato la lobby puo' avviare");
    var lvl;
    if (L.level_id === "random") {
      var pool = db.levels.filter(function (x) { return x.published && x.data && x.data.objects && x.data.objects.length; });
      if (!pool.length) return E(404, "Nessun livello pubblicato disponibile");
      lvl = pool[randomInt(pool.length)];
      L.level_name = lvl.name;
    } else lvl = db.levels.filter(function (x) { return x.id === L.level_id; })[0];
    if (!lvl) return E(404, "Livello non trovato");
    L.level_data = { id: lvl.id, name: lvl.name, data: lvl.data };
    L.status = "playing";
    L.restart++;
    L.go_at = now() + 3500;
    Object.keys(L.players).forEach(function (id) { L.players[id].state = null; L.players[id].snap = null; L.players[id].dead = false; });
    L.turn = null;
    if (L.options.indexOf("turns") >= 0) pickTurn(L, null);
    return J(200, lobbyView(L, u.user_id));
  }
  if (act === "sync" && method === "POST") {
    if (b.state && typeof b.state === "object") P.state = b.state;
    if (b.snap && typeof b.snap === "object") P.snap = b.snap;
    P.dead = !!b.dead;
    tickLobby(L);
    return J(200, lobbyView(L, u.user_id));
  }
  if (act === "death" && method === "POST") {
    if (L.options.indexOf("shared_death") >= 0 && L.status === "playing" && now() > (L.go_at || 0)) {
      L.restart++;
      L.go_at = now() + 1200;
      if (L.turn) L.turn.until = L.go_at + L.turn_seconds * 1000;
    }
    return J(200, lobbyView(L, u.user_id));
  }
  if (act === "level" && method === "GET") {
    if (L.status !== "playing") return E(409, "La partita non e' ancora iniziata");
    return J(200, L.level_data);
  }
  if (act === "pass" && method === "POST") {
    if (L.turn && L.turn.uid === u.user_id) {
      if (b.snap) P.snap = b.snap;
      pickTurn(L, u.user_id);
    }
    return J(200, lobbyView(L, u.user_id));
  }
  return null;
}

function lobbyPrefix(code) { return "lobbies/" + code + "/"; }
function lobbyMetaKey(code) { return lobbyPrefix(code) + "lobby.json"; }
function lobbyPlayerKey(code, uid) { return lobbyPrefix(code) + "players/" + uid + ".json"; }

async function writeLobbyMeta(env, L) {
  await env.FILES.put(lobbyMetaKey(L.code), JSON.stringify({
    code: L.code, host: L.host, status: L.status, options: L.options,
    turn_seconds: L.turn_seconds, level_id: L.level_id, level_name: L.level_name,
    level_data: L.level_data || null, restart: L.restart || 0, go_at: L.go_at || 0,
    turn: L.turn || null, created: L.created
  }));
}

async function writeLobbyPlayer(env, L, p) {
  await env.FILES.put(lobbyPlayerKey(L.code, p.uid), JSON.stringify(p));
}

async function readLobbyR2(env, code) {
  var obj = await env.FILES.get(lobbyMetaKey(code));
  if (!obj) return null;
  var L;
  try { L = JSON.parse(await obj.text()); } catch (e) { return null; }
  L.options = Array.isArray(L.options) ? L.options : ["normal"];
  L.turn = L.turn || null;
  L.created = L.created || now();
  L.players = {};
  var list = await env.FILES.list({ prefix: lobbyPrefix(code) + "players/" });
  var keys = (list.objects || []).map(function (o) { return o.key; });
  for (var i = 0; i < keys.length; i++) {
    var pObj = await env.FILES.get(keys[i]);
    if (!pObj) continue;
    try {
      var p = JSON.parse(await pObj.text());
      if (p && p.uid) L.players[p.uid] = p;
    } catch (e) { }
  }
  return L;
}

async function deleteLobbyR2(env, code) {
  await env.FILES.delete(lobbyMetaKey(code));
  var list = await env.FILES.list({ prefix: lobbyPrefix(code) + "players/" });
  var keys = (list.objects || []).map(function (o) { return o.key; });
  for (var i = 0; i < keys.length; i++) await env.FILES.delete(keys[i]);
}

async function newLobbyCodeR2(env) {
  var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (var n = 0; n < 30; n++) {
    var c = "";
    for (var i = 0; i < 5; i++) c += chars[randomInt(chars.length)];
    if (!(await env.FILES.get(lobbyMetaKey(c)))) return c;
  }
  throw new Error("Impossibile generare un codice lobby");
}

async function pruneLobbyR2(env, L) {
  var t = now(), changed = false;
  var stale = Object.keys(L.players).filter(function (uid) {
    return t - (L.players[uid].seen || 0) > 20000;
  });
  for (var i = 0; i < stale.length; i++) {
    delete L.players[stale[i]];
    await env.FILES.delete(lobbyPlayerKey(L.code, stale[i]));
    changed = true;
  }
  if (L.host && !L.players[L.host]) {
    L.host = Object.keys(L.players)[0] || null;
    changed = true;
  }
  if (!Object.keys(L.players).length || t - (L.created || t) > 6 * 3600 * 1000) {
    await deleteLobbyR2(env, L.code);
    return null;
  }
  if (changed) await writeLobbyMeta(env, L);
  return L;
}

async function lobbyRouteR2(env, method, path, b, u, db, core) {
  var J = core.json, E = function (s, d) { return J(s, { detail: d }); };
  if (!u) return E(401, "Accedi per giocare in lobby");
  var m, L, P, lvl;
  if (path === "/lobbies" && method === "POST") {
    var opts = Array.isArray(b.options) ? b.options.filter(function (o) { return OPTS.indexOf(o) >= 0 && o !== "normal"; }) : [];
    var ts = Math.max(3, Math.min(300, +b.turn_seconds || 15));
    L = {
      code: await newLobbyCodeR2(env), host: u.user_id, status: "waiting",
      options: opts.length ? opts : ["normal"], turn_seconds: ts,
      level_id: b.level_id && b.level_id !== "random" ? String(b.level_id) : "random",
      level_name: null, level_data: null, restart: 0, go_at: 0, turn: null,
      players: {}, created: now()
    };
    if (L.level_id !== "random") {
      lvl = db.levels.filter(function (x) { return x.id === L.level_id; })[0];
      if (!lvl || !(lvl.published || lvl.user_id === u.user_id)) return E(404, "Livello non trovato");
      L.level_name = lvl.name;
    }
    L.players[u.user_id] = { uid: u.user_id, name: u.username, state: null, snap: null, dead: false, seen: now() };
    await writeLobbyMeta(env, L);
    await writeLobbyPlayer(env, L, L.players[u.user_id]);
    return J(200, lobbyView(L, u.user_id));
  }
  m = /^\/lobbies\/([A-Za-z0-9]+)(?:\/(\w+))?$/.exec(path);
  if (!m) return null;
  L = await readLobbyR2(env, m[1].toUpperCase());
  if (!L) return E(404, "Lobby non trovata (controlla il codice e che entrambi usiate lo stesso server)");
  L = await pruneLobbyR2(env, L);
  if (!L) return E(404, "Lobby non trovata (controlla il codice e che entrambi usiate lo stesso server)");
  var act = m[2];
  if (!act && method === "GET") {
    if (L.players[u.user_id]) {
      var present = L.players[u.user_id], seenNow = now();
      if (seenNow - (present.seen || 0) > 10000) {
        present.seen = seenNow;
        await writeLobbyPlayer(env, L, present);
      }
    }
    return J(200, lobbyView(L, u.user_id));
  }
  if (act === "join" && method === "POST") {
    if (!L.players[u.user_id]) {
      if (Object.keys(L.players).length >= 8) return E(409, "Lobby piena (massimo 8 giocatori)");
      L.players[u.user_id] = { uid: u.user_id, name: u.username, state: null, snap: null, dead: false, seen: now() };
    } else {
      L.players[u.user_id].seen = now();
    }
    await writeLobbyPlayer(env, L, L.players[u.user_id]);
    return J(200, lobbyView(L, u.user_id));
  }
  if (!L.players[u.user_id]) return E(403, "Non sei in questa lobby");
  P = L.players[u.user_id];
  P.seen = now();
  if (act === "leave" && method === "POST") {
    delete L.players[u.user_id];
    await env.FILES.delete(lobbyPlayerKey(L.code, u.user_id));
    if (L.host === u.user_id) L.host = Object.keys(L.players)[0] || null;
    if (!L.host) await deleteLobbyR2(env, L.code);
    else await writeLobbyMeta(env, L);
    return J(200, { ok: true });
  }
  if (act === "start" && method === "POST") {
    if (L.host !== u.user_id) return E(403, "Solo chi ha creato la lobby puo' avviare");
    if (L.level_id === "random") {
      var pool = db.levels.filter(function (x) { return x.published && x.data && x.data.objects && x.data.objects.length; });
      if (!pool.length) return E(404, "Nessun livello pubblicato disponibile");
      lvl = pool[randomInt(pool.length)];
      L.level_name = lvl.name;
    } else lvl = db.levels.filter(function (x) { return x.id === L.level_id; })[0];
    if (!lvl) return E(404, "Livello non trovato");
    L.level_data = { id: lvl.id, name: lvl.name, data: lvl.data };
    L.status = "playing";
    L.restart = (L.restart || 0) + 1;
    L.go_at = now() + 3500;
    L.turn = null;
    var ids = Object.keys(L.players);
    ids.forEach(function (id) { L.players[id].state = null; L.players[id].snap = null; L.players[id].dead = false; L.players[id].seen = now(); });
    if (L.options.indexOf("turns") >= 0) pickTurn(L, null);
    await writeLobbyMeta(env, L);
    for (var si = 0; si < ids.length; si++) await writeLobbyPlayer(env, L, L.players[ids[si]]);
    return J(200, lobbyView(L, u.user_id));
  }
  if (act === "sync" && method === "POST") {
    if (b.state && typeof b.state === "object") P.state = b.state;
    if (b.snap && typeof b.snap === "object") P.snap = b.snap;
    P.dead = !!b.dead;
    var before = L.turn ? L.turn.seq + ":" + L.turn.uid + ":" + L.turn.until : "";
    tickLobby(L);
    var after = L.turn ? L.turn.seq + ":" + L.turn.uid + ":" + L.turn.until : "";
    await writeLobbyPlayer(env, L, P);
    if (before !== after) await writeLobbyMeta(env, L);
    return J(200, lobbyView(L, u.user_id));
  }
  if (act === "death" && method === "POST") {
    var changed = false;
    if (L.options.indexOf("shared_death") >= 0 && L.status === "playing" && now() > (L.go_at || 0)) {
      L.restart = (L.restart || 0) + 1;
      L.go_at = now() + 1200;
      if (L.turn) L.turn.until = L.go_at + L.turn_seconds * 1000;
      changed = true;
    }
    await writeLobbyPlayer(env, L, P);
    if (changed) await writeLobbyMeta(env, L);
    return J(200, lobbyView(L, u.user_id));
  }
  if (act === "level" && method === "GET") {
    if (L.status !== "playing") return E(409, "La partita non e' ancora iniziata");
    return J(200, L.level_data);
  }
  if (act === "pass" && method === "POST") {
    if (L.turn && L.turn.uid === u.user_id) {
      if (b.snap) P.snap = b.snap;
      pickTurn(L, u.user_id);
      await writeLobbyMeta(env, L);
    }
    await writeLobbyPlayer(env, L, P);
    return J(200, lobbyView(L, u.user_id));
  }
  return null;
}

async function lobbyRoute(env, method, path, b, u, db, core) {
  if (env && env.FILES) return await lobbyRouteR2(env, method, path, b, u, db, core);
  return lobbyRouteMemory(method, path, b, u, db, core);
}

const worker = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });
    var url = new URL(request.url);
    var path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/") {
        return withCors(new Response("Geometry Dash Web API", {
          status: 302,
          headers: { "Location": "https://gattoita-lab.github.io/Geometry-dash-Web/" }
        }));
      }
      var state = await loadState(env);
      var hadState = !!state;
      var dirtyState = false;
      var token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "");
      token = token ? token[1] : null;
      var uid = token && state && state.tokens ? state.tokens[token] : null;
      var core = GDCore({
        admins: String((env && env.ADMINS) || "gattoitaliano").split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
        load: function () { return state; },
        save: function (db) {
          state = db;
          cachedState = db;
          dirtyState = true;
          persist(env, ctx);
        },
        session: function () { return uid; },
        putAudio: async function (id, bytes, type) {
          if (!env.FILES) throw new Error("R2 non disponibile");
          await env.FILES.put("audio/" + id, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
        },
        getAudio: async function (id) {
          if (!env.FILES) return null;
          var obj = await env.FILES.get("audio/" + id);
          if (!obj) return null;
          return { body: obj.body, type: obj.httpMetadata && obj.httpMetadata.contentType };
        },
        setSession: function (id) {
          if (!id && token && state.tokens) {
            delete state.tokens[token];
            cachedState = state;
            dirtyState = true;
            persist(env, ctx);
          }
        },
        authBody: function (u) {
          var t = makeToken();
          state.tokens = state.tokens || {};
          state.tokens[t] = u.user_id;
          cachedState = state;
          dirtyState = true;
          persist(env, ctx);
          return { user_id: u.user_id, username: u.username, token: t };
        }
      });
      var db = core.getDb();
      state = db;
      cachedState = db;
      state.tokens = state.tokens || {};
      if (!hadState) { dirtyState = true; persist(env, ctx); }
      var u = uid && state.users[uid] ? state.users[uid] : null;

      if (path === "/ping" || path === "/api") {
        return withCors(responseJson(200, {
          ok: true,
          name: "geometry-dash-server",
          storage: env.FILES ? "r2" : "memory",
          users: Object.keys(state.users || {}).length,
          levels: (state.levels || []).length
        }));
      }
      if (path.indexOf("/api/") !== 0) {
        return withCors(responseJson(404, { detail: "Not found" }));
      }
      var apiPath = path.slice(4) || "/";
      var raw = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      var body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }
      pruneLobbies();
      var lobby = apiPath.indexOf("/lobbies") === 0 ? await lobbyRoute(env, request.method, apiPath, body, u, state, core) : null;
      var out = lobby || await core.route(request.method, apiPath, url.searchParams, { method: request.method, body: raw });
      if (!out) out = responseJson(404, { detail: "Not found" });
      if (dirtyState) await saveChain;
      return withCors(out);
    } catch (e) {
      console.error("Errore API:", e && (e.stack || e.message));
      return withCors(responseJson(500, { detail: "Errore del server" }));
    }
  }
};

export default worker;
