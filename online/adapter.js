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
let loaded = false;
let loadPromise = null;
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
  if (loaded) return cachedState;
  if (!loadPromise) {
    loadPromise = (async function () {
      try {
        if (env.FILES) {
          var obj = await env.FILES.get("state.json");
          if (obj) cachedState = JSON.parse(await obj.text());
        }
      } catch (e) {
        console.error("Lettura archivio fallita:", e && e.message);
        cachedState = null;
      }
      loaded = true;
      return cachedState;
    })();
  }
  return loadPromise;
}

function persist(env, ctx) {
  if (!env.FILES) return;
  var snapshot = JSON.stringify(cachedState);
  saveChain = saveChain.then(function () {
    return env.FILES.put("state.json", snapshot);
  }).catch(function (e) {
    console.error("Salvataggio archivio fallito:", e && e.message);
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(saveChain);
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

function lobbyRoute(method, path, b, u, db, core) {
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
  if (!L) return E(404, "Lobby non trovata (controlla il codice)");
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
      var token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "");
      token = token ? token[1] : null;
      var uid = token && state && state.tokens ? state.tokens[token] : null;
      var core = GDCore({
        admins: String((env && env.ADMINS) || "gattoitaliano").split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
        load: function () { return state; },
        save: function (db) {
          state = db;
          cachedState = db;
          persist(env, ctx);
        },
        session: function () { return uid; },
        setSession: function (id) {
          if (!id && token && state.tokens) {
            delete state.tokens[token];
            cachedState = state;
            persist(env, ctx);
          }
        },
        authBody: function (u) {
          var t = makeToken();
          state.tokens = state.tokens || {};
          state.tokens[t] = u.user_id;
          cachedState = state;
          persist(env, ctx);
          return { user_id: u.user_id, username: u.username, token: t };
        }
      });
      var db = core.getDb();
      state = db;
      cachedState = db;
      state.tokens = state.tokens || {};
      if (!hadState) persist(env, ctx);
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
      var lobby = apiPath.indexOf("/lobbies") === 0 ? lobbyRoute(request.method, apiPath, body, u, state, core) : null;
      var out = lobby || await core.route(request.method, apiPath, url.searchParams, { method: request.method, body: raw });
      if (!out) out = responseJson(404, { detail: "Not found" });
      return withCors(out);
    } catch (e) {
      console.error("Errore API:", e && (e.stack || e.message));
      return withCors(responseJson(500, { detail: "Errore del server" }));
    }
  }
};

export default worker;
