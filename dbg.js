/* BLIP diagnostics - hidden. Tap the top-left corner 5 times quickly to show/hide the panel. */
(function () {
  'use strict';
  var logs = [], MAX = 80, on = false, box = null, t0 = Date.now(), live = [], streams = [], killed = false;
  var stat = { wsId: 0, audioMsgs: 0, lastAudio: 0, ctxs: [], sentAudio: 0, lastSent: 0, sentVideo: 0, heard: '', said: '' };
  // Google marked gemini-3.1-flash-live-preview as a legacy preview and recommends gemini-3.8-live.
  // BLIP's app still asks for the old one, so the model name is swapped as the session setup is sent.
  // If the new model fails to start 3 times in a row, fall back to the old one automatically.
  var MODEL_OLD = 'models/gemini-3.1-flash-live-preview', MODEL_NEW = 'models/gemini-3.8-live';
  var MODEL_PREF_KEY = 'blip_model_pref';
  function loadModel() { try { var p = JSON.parse(localStorage.getItem(MODEL_PREF_KEY) || 'null'); if (p && p.until > Date.now() && p.m === 'new') return MODEL_NEW; } catch (e) {} return MODEL_OLD; }
  var curModel = loadModel(), modelFails = 0;
  function saveModel() { try { localStorage.setItem(MODEL_PREF_KEY, JSON.stringify({ m: curModel === MODEL_NEW ? 'new' : 'old', until: Date.now() + 3600000 })); } catch (e) {} }
  // Live Google Search for the voice session (exchange rates, news, weather, prices, scores...).
  // If Google rejects a session with search enabled twice in a row, search is switched off
  // so BLIP still works; it is retried when the model falls back.
  var searchOn = true, searchFails = 0, fnOn = true, fnFails = 0, fnOffAt = 0, skipRic = false;
  var VER = 'dbg v7', keep = [], lastSearchNote = 0, turnLookupMs = 0, lookupCache = {}, geoCache = {}, GS_KEY = 'blip_gs_blocked_until';
  function note(m) { keep.push(ts() + ' ' + m); if (keep.length > 7) keep.shift(); log(m); }
  function isGS(t) { return !!(t && (t.googleSearch || t.google_search)); }
  function gsBlocked() { try { return Number(localStorage.getItem(GS_KEY) || 0) > Date.now(); } catch (e) { return false; } }
  function blockGS(mins) {
    try { localStorage.setItem(GS_KEY, String(Date.now() + mins * 60000)); } catch (e) {}
    note('Google Search quota/billing problem on the API key - using built-in lookups for ' + mins + ' min');
  }

  // ---- Built-in lookups (used when Google Search is unavailable on the API key) ----
  var FNS = [
    { name: 'get_exchange_rate', description: 'Get the current exchange rate between two currencies, e.g. AED to PHP.',
      parameters: { type: 'OBJECT', properties: { from: { type: 'STRING', description: 'ISO code to convert from, e.g. AED' }, to: { type: 'STRING', description: 'ISO code to convert to, e.g. PHP' }, amount: { type: 'NUMBER', description: 'Optional amount, default 1' } }, required: ['from', 'to'] } },
    { name: 'get_weather', description: 'Get current weather and a 2-day forecast for a city.',
      parameters: { type: 'OBJECT', properties: { city: { type: 'STRING', description: 'City name, e.g. Manila' } }, required: ['city'] } },
    { name: 'search_web', description: 'Search the web for current facts, news or general information.',
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Short search query' } }, required: ['query'] } }
  ];
  function cached(key, ms, fn) {
    var c = lookupCache[key]; if (c && Date.now() - c.t < ms) return Promise.resolve(c.v);
    return fn().then(function (v) { if (v && !v.error) lookupCache[key] = { t: Date.now(), v: v }; return v; });
  }
  function firstOk(ps) {
    return new Promise(function (res, rej) { var n = ps.length, bad = 0; ps.forEach(function (p) { p.then(res, function () { if (++bad === n) rej(new Error('all failed')); }); }); });
  }
  function jget(url, ms) {
    var c = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var tm = setTimeout(function () { try { c && c.abort(); } catch (e) {} }, ms || 7000);
    return fetch(url, c ? { signal: c.signal } : {}).then(function (r) { clearTimeout(tm); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
      function (e) { clearTimeout(tm); throw e; });
  }
  function rateLookup(a) {
    var from = String(a.from || '').trim().toUpperCase(), to = String(a.to || '').trim().toUpperCase(), amt = Number(a.amount) || 1;
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return Promise.resolve({ error: 'Need 3-letter currency codes like AED and PHP.' });
    function done(rate, src, asof) { return { from: from, to: to, rate: Number(Number(rate).toFixed(4)), amount: amt, converted: Number((rate * amt).toFixed(2)), source: src, as_of: asof, note: 'Daily mid-market rate. Exchange houses and banks give slightly less.' }; }
    var lf = from.toLowerCase(), lt = to.toLowerCase();
    return cached('rate|' + from + '|' + to, 600000, function () {
      var a = jget('https://open.er-api.com/v6/latest/' + from, 5000).then(function (j) {
        var r = j && j.rates && j.rates[to]; if (!r) throw new Error('no rate');
        return done(r, 'open.er-api.com', j.time_last_update_utc || 'today');
      });
      var b = jget('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/' + lf + '.json', 5000).then(function (j) {
        var r = j && j[lf] && j[lf][lt]; if (!r) throw new Error('no rate');
        return done(r, 'currency-api', j.date || 'today');
      });
      return firstOk([a, b]).catch(function () { return { error: 'Could not reach a rate service right now.' }; });
    }).then(function (v) { if (v && v.rate) { v = JSON.parse(JSON.stringify(v)); v.amount = amt; v.converted = Number((v.rate * amt).toFixed(2)); } return v; });
  }
  var WMO = { 0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' };
  function weatherLookup(a) {
    var city = String(a.city || '').trim(); if (!city) return Promise.resolve({ error: 'Which city?' });
    var gk = city.toLowerCase();
    var geo = geoCache[gk] ? Promise.resolve(geoCache[gk]) : jget('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(city), 5000).then(function (g) { var q = g && g.results && g.results[0]; if (q) geoCache[gk] = q; return q; });
    return cached('wx|' + gk, 600000, function () { return geo.then(function (p) {
      if (!p) return { error: 'City not found.' };
      return jget('https://api.open-meteo.com/v1/forecast?latitude=' + p.latitude + '&longitude=' + p.longitude + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=2&timezone=auto', 5000).then(function (w) {
        var c = w.current || {}, d = w.daily || {};
        function at(k, i) { return d[k] ? d[k][i] : undefined; }
        return { place: p.name + (p.country ? ', ' + p.country : ''), now_c: c.temperature_2m, feels_like_c: c.apparent_temperature, humidity_pct: c.relative_humidity_2m, wind_kmh: c.wind_speed_10m, conditions: WMO[c.weather_code] || 'unknown',
          today_high_c: at('temperature_2m_max', 0), today_low_c: at('temperature_2m_min', 0), rain_chance_today_pct: at('precipitation_probability_max', 0),
          tomorrow_high_c: at('temperature_2m_max', 1), tomorrow_low_c: at('temperature_2m_min', 1), rain_chance_tomorrow_pct: at('precipitation_probability_max', 1), local_time: c.time };
      });
    }).catch(function () { return { error: 'Could not reach the weather service right now.' }; }); });
  }
  function webLookup(a) {
    var q = String(a.query || '').trim(); if (!q) return Promise.resolve({ error: 'No query.' });
    return jget('/.netlify/functions/websearch?q=' + encodeURIComponent(q), 8000).then(function (j) {
      if (j && (j.answer || (j.results && j.results.length))) return j; throw new Error('empty');
    }).catch(function () {
      return jget('https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=3&prop=extracts&exintro=1&explaintext=1&exchars=450&format=json&origin=*&gsrsearch=' + encodeURIComponent(q), 7000).then(function (j) {
        var pg = j && j.query && j.query.pages; if (!pg) return { error: 'Nothing found.', note: 'Say you could not find current info on this.' };
        var arr = Object.keys(pg).map(function (k) { return pg[k]; }).sort(function (x, y) { return x.index - y.index; });
        return { source: 'wikipedia', note: 'Encyclopedia info, not live news.', results: arr.map(function (p) { return { title: p.title, summary: p.extract }; }) };
      });
    }).catch(function () { return { error: 'Could not search right now.' }; });
  }
  var handled = {};
  function handleTool(ws, t) {
    if (typeof t !== 'string' || t.indexOf('"toolCall"') < 0) return;
    var m; try { m = JSON.parse(t); } catch (e) { return; }
    var calls = m && m.toolCall && m.toolCall.functionCalls; if (!calls) return;
    calls.forEach(function (c) {
      var fn = c && c.name, impl = fn === 'get_exchange_rate' ? rateLookup : fn === 'get_weather' ? weatherLookup : fn === 'search_web' ? webLookup : null;
      if (!impl) return;
      var hk = c.id || (fn + '|' + Date.now()); if (handled[hk]) return; handled[hk] = 1;
      var args = c.args || {};
      var t1 = Date.now();
      impl(args).then(function (res) {
        var ms = Date.now() - t1; turnLookupMs += ms;
        note('LOOKUP ' + fn + ' ' + JSON.stringify(args).slice(0, 30) + ' -> ' + (res.error ? 'ERR ' + res.error : (res.rate || 'ok')) + ' ' + ms + 'ms');
        if (ws.readyState === 1 && ws.__osend) ws.__osend.call(ws, JSON.stringify({ toolResponse: { functionResponses: [{ id: c.id, name: fn, response: { output: res } }] } }));
      });
    });
  }

  var NAME_RULE = '\n\nNAME RULE: Never guess, infer or save the person\'s name from a random word, background speech, a TV, or unclear audio. Only use a name if the person clearly introduced it themselves ("my name is...", "call me...") or it is given to you in these instructions. If something merely sounds like a name, ignore it and do not address them by it. If you are unsure what you heard, ask them to repeat instead of assuming.';
  var QUICK_RULE = ' Do NOT use tools for greetings, small talk, the current date or time (given above), or things that do not change - just answer directly and quickly.';
  function addSearch(ws, d) {
    try {
      var o = JSON.parse(d);
      if (!o || !o.setup) return d;
      var st = o.setup;
      var tools = Array.isArray(st.tools) ? st.tools : [];
      if (!fnOn && Date.now() - fnOffAt > 120000) { fnOn = true; fnFails = 0; note('retrying built-in lookups'); }
      var mode = 'none';
      if (!gsBlocked() && searchOn) {
        if (!tools.some(isGS)) { tools.push({ googleSearch: {} }); ws.__added = true; }
        mode = 'gs';
      } else {
        tools.forEach(function (t) { if (t) { delete t.googleSearch; delete t.google_search; } });
        tools = tools.filter(function (t) { return t && Object.keys(t).length; });
        if (fnOn) {
          var fd = null;
          tools.forEach(function (t) { if (!fd && Array.isArray(t.functionDeclarations)) fd = t; });
          if (!fd) { fd = { functionDeclarations: [] }; tools.push(fd); }
          FNS.forEach(function (f) { if (!fd.functionDeclarations.some(function (x) { return x && x.name === f.name; })) fd.functionDeclarations.push(f); });
          mode = 'fn';
        }
      }
      if (tools.length || st.tools) st.tools = tools;
      ws.__mode = mode; ws.__search = mode !== 'none'; ws.__hasGS = tools.some(isGS);
      var now = new Date(), tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time');
      var add;
      if (mode === 'gs') add = '\n\nLIVE INFO RULES: Right now it is ' + now.toString() + ' (' + tz + '). You have Google Search. For anything that changes over time - currency exchange rates (e.g. AED to PHP), crypto and stock prices, news, weather, sports scores, opening hours, "latest" or "current" anything - ALWAYS search first and answer from the search result, never from memory. Say the figure naturally and mention it is live. If search fails, say you could not check live rather than guessing.' + QUICK_RULE;
      else if (mode === 'fn') add = '\n\nLIVE INFO RULES: Right now it is ' + now.toString() + ' (' + tz + '). You cannot browse, but you have tools: get_exchange_rate, get_weather and search_web. For currency rates (e.g. AED to PHP), weather, or any current fact, CALL the matching tool first and answer from its result - never from memory. Exchange rates are daily mid-market rates: say "about X, as of <date>" and mention exchange houses give slightly less. If a tool returns an error, say you could not check live data. For news, scores or stock prices the tools cannot cover, say you cannot check those live right now.' + QUICK_RULE;
      else add = '\n\nNO LIVE DATA: Right now it is ' + now.toString() + '. You can NOT look things up on the internet in this session. For exchange rates, prices, news, weather or scores, never present a number as live or say you checked. Say you cannot check live data right now.';
      add += NAME_RULE;
      var key = st.systemInstruction ? 'systemInstruction' : (st.system_instruction ? 'system_instruction' : 'systemInstruction');
      var si = st[key];
      if (!si) si = { parts: [{ text: add.trim() }] };
      else if (typeof si === 'string') si = si + add;
      else if (Array.isArray(si.parts) && si.parts.length) { si.parts[si.parts.length - 1].text = String(si.parts[si.parts.length - 1].text || '') + add; }
      else si.parts = [{ text: add.trim() }];
      st[key] = si;
      ws.__sum = 'model=' + String(st.model || '?').replace('models/', '') + ' keys=' + Object.keys(st).join(',') + ' mode=' + mode.toUpperCase() + ' tools=' + tools.map(function (t) { return Object.keys(t).join('+'); }).join(',');
      return JSON.stringify(o);
    } catch (e) { note('setup patch FAILED: ' + String(e.message).slice(0, 60)); return d; }
  }
  function ts() { return ((Date.now() - t0) / 1000).toFixed(1) + 's'; }
  function log(s) { logs.push(ts() + ' ' + s); if (logs.length > MAX) logs.shift(); }
  window.__blipDbgLog = log;

  // ---- WebSocket (Gemini Live) ----
  var O = window.WebSocket;
  if (O) {
    var W = function (u, p) {
      if (killed && String(u).indexOf('generativelanguage') >= 0) u = 'wss://blip-locked.invalid/';
      var ws = p === undefined ? new O(u) : new O(u, p);
      try {
        if (String(u).indexOf('generativelanguage') >= 0) {
          var id = ++stat.wsId;
          // Only one Live session may exist. If an older one is still open or connecting
          // (a double reconnect), close it so two sessions never talk over each other.
          live = live.filter(function (x) { return x.readyState <= 1; });
          live.forEach(function (old) {
            try { old.close(1000, 'superseded by newer session'); log('closed older duplicate session (WS#' + old.__dbgId + ')'); } catch (e) {}
          });
          ws.__dbgId = id; live.push(ws);
          try {
            var os = ws.send; ws.__osend = os;
            ws.send = function (d) {
              try {
                if (typeof d === 'string' && d.indexOf('"setup"') >= 0 && d.indexOf(MODEL_OLD) >= 0 && curModel !== MODEL_OLD) {
                  d = d.split(MODEL_OLD).join(curModel);
                  // Make BLIP less eager to start talking on background noise or its own echo.
                  try {
                    var o = JSON.parse(d);
                    if (o && o.setup && !skipRic && !o.setup.realtimeInputConfig) {
                      o.setup.realtimeInputConfig = { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', endOfSpeechSensitivity: 'END_SENSITIVITY_DEFAULT', prefixPaddingMs: 120, silenceDurationMs: 900 } };
                      d = JSON.stringify(o);
                    }
                  } catch (e2) {}
                  ws.__model = curModel; log('using model ' + curModel);
                } else if (typeof d === 'string' && d.indexOf('"setup"') >= 0) ws.__model = MODEL_OLD;
                if (typeof d === 'string' && d.indexOf('"setup"') >= 0) { ws.__search = false; d = addSearch(ws, d); note('WS#' + id + ' setup: ' + (ws.__sum || 'not patched')); }
                else if (typeof d !== 'string' && !ws.__binNoted) { ws.__binNoted = 1; note('WS#' + id + ' sends non-text frames (' + Object.prototype.toString.call(d) + ')'); }
                if (typeof d === 'string') {
                  if (d.indexOf('audio/pcm') >= 0) { stat.sentAudio++; stat.lastSent = Date.now(); }
                  else if (d.indexOf('image/jpeg') >= 0) stat.sentVideo++;
                }
              } catch (e) {}
              return os.call(ws, d);
            };
          } catch (e) {}
          log('WS#' + id + ' connecting');
          ws.addEventListener('open', function () { log('WS#' + id + ' open'); });
          ws.addEventListener('close', function (e) {
            if (!ws.__setup && !killed && e.code !== 1000 && e.code !== 4000) {
              var rs = String(e.reason || ''), toolish = /tool|function|declaration|search/i.test(rs);
              if (/realtime_input_config/i.test(rs) && ws.__model === MODEL_NEW && !skipRic) { skipRic = true; note('gemini-3.8-live rejected the voice-sensitivity setting - retrying without it'); }
              else if (/quota|billing|RESOURCE_EXHAUSTED/i.test(rs) && ws.__hasGS) blockGS(20);
              else if (ws.__mode === 'gs' && ws.__added && searchOn && toolish && ++searchFails >= 2) { searchOn = false; note('Google rejected sessions WITH search twice - search OFF'); }
              else if (ws.__mode === 'fn' && fnOn && toolish && ++fnFails >= 2) { fnOn = false; fnOffAt = Date.now(); note('Google rejected the lookup tools twice - lookups OFF for 2 min'); }
            }
            if (!ws.__setup && ws.__sum && ws.__model === curModel && !killed && e.code !== 1000 && e.code !== 4000) {
              if (++modelFails >= 3) {
                var was = curModel; curModel = (curModel === MODEL_OLD) ? MODEL_NEW : MODEL_OLD; modelFails = 0;
                searchOn = true; searchFails = 0; fnOn = true; fnFails = 0; saveModel();
                note(was.replace('models/', '') + ' failed 3 times - switching to ' + curModel.replace('models/', ''));
              }
            }
            if (!ws.__setup) note('WS#' + id + ' died before ready code=' + e.code + ' ' + String(e.reason || '').slice(0, 70) + ' [' + (ws.__sum || '?') + ']');
            log('WS#' + id + ' CLOSED code=' + e.code + ' ' + String(e.reason || '').slice(0, 90)); });
          ws.addEventListener('error', function () { log('WS#' + id + ' error'); });
          ws.__born = Date.now(); ws.__setup = false;
          ws.addEventListener('message', function (e) {
            var d = e.data;
            if (typeof d === 'string') { watch(ws, d); handleTool(ws, d); if (on) inspect(id, d); }
            else if (d && typeof d.text === 'function' && d.size < 60000) d.text().then(function (t) { watch(ws, t); handleTool(ws, t); if (on) inspect(id, t); }).catch(function () {});
          });
        }
      } catch (err) {}
      return ws;
    };
    W.prototype = O.prototype;
    W.CONNECTING = O.CONNECTING; W.OPEN = O.OPEN; W.CLOSING = O.CLOSING; W.CLOSED = O.CLOSED;
    window.WebSocket = W;
  }
  function inspect(id, t) {
    if (t.indexOf('"inlineData"') >= 0) { stat.audioMsgs++; stat.lastAudio = Date.now(); }
    if (t.indexOf('goAway') >= 0) log('WS#' + id + ' goAway (server will disconnect)');
    var th = /"inputTranscription"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.){0,200})"/.exec(t);
    if (th) stat.heard = (stat.heard + th[1]).slice(-70);
    var ts2 = /"outputTranscription"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.){0,200})"/.exec(t);
    if (ts2) stat.said = (stat.said + ts2[1]).slice(-70);
    if (t.indexOf('"interrupted"') >= 0) log('WS#' + id + ' INTERRUPTED');
    if (t.indexOf('turnComplete') >= 0) log('WS#' + id + ' turnComplete');
    if (t.indexOf('setupComplete') >= 0) log('WS#' + id + ' setupComplete');
    var m = /"error"\s*:\s*\{[^}]{0,160}/.exec(t); if (m) log('WS#' + id + ' ERROR ' + m[0].slice(0, 160));
  }


  // ---- Silence watchdog ----
  // Sometimes Google's Live session stays "open" but stops answering. If the person spoke
  // and no reply (audio/text/turn end) arrived for WD_STALL ms, or a new session never
  // finished its setup, close the socket so BLIP's own reconnect logic starts a fresh one.
  var WD_STALL = 12000, WD_SETUP = 15000, WD_COOLDOWN = 30000;
  var wd = { pend: false, inAt: 0, last: 0, resets: 0 };
  function watch(ws, t) {
    try {
      if ((t.indexOf('groundingMetadata') >= 0 || t.indexOf('webSearchQueries') >= 0) && Date.now() - lastSearchNote > 3000) {
        lastSearchNote = Date.now();
        var q = /"webSearchQueries"\s*:\s*\[([^\]]{0,100})/.exec(t);
        note('SEARCH USED' + (q ? ': ' + q[1] : ''));
      }
      if (t.indexOf('setupComplete') >= 0) { ws.__setup = true; if (ws.__model === curModel) modelFails = 0; if (ws.__mode === 'gs') searchFails = 0; if (ws.__mode === 'fn') fnFails = 0; }
      if (/"inputTranscription"\s*:\s*\{\s*"text"\s*:\s*"(?:\\.|\s*[^"\s\\])/.test(t)) { wd.pend = true; wd.inAt = Date.now(); }
      if (wd.pend && t.indexOf('"inlineData"') >= 0) { note('reply in ' + ((Date.now() - wd.inAt) / 1000).toFixed(1) + 's after you stopped' + (turnLookupMs ? ' (lookup ' + (turnLookupMs / 1000).toFixed(1) + 's)' : '')); turnLookupMs = 0; }
      if (t.indexOf('"inlineData"') >= 0 || t.indexOf('"outputTranscription"') >= 0 || t.indexOf('turnComplete') >= 0 || t.indexOf('"interrupted"') >= 0) wd.pend = false;
    } catch (e) {}
  }
  function wdKick(ws, why) {
    wd.last = Date.now(); wd.pend = false; wd.resets++;
    log('WATCHDOG: ' + why + ' - restarting voice session (#' + wd.resets + ')');
    try { ws.close(4000, 'blip watchdog'); } catch (e) {}
  }
  function wdTick() {
    if (killed) return;
    var now = Date.now();
    if (now - wd.last < WD_COOLDOWN) return;
    live = live.filter(function (x) { return x.readyState <= 1; });
    var cur = live[live.length - 1];
    if (!cur) { wd.pend = false; return; }
    if (!cur.__setup && now - cur.__born > WD_SETUP) return wdKick(cur, 'session never became ready');
    if (document.hidden) return;
    if (wd.pend && cur.readyState === 1 && now - wd.inAt > (cur.__search ? 30000 : WD_STALL)) wdKick(cur, 'no reply for ' + Math.round((now - wd.inAt) / 1000) + 's');
  }
  setInterval(wdTick, 2000);
  window.__blipWd = { tick: wdTick, state: wd };

  // ---- AudioContext state ----
  ['AudioContext', 'webkitAudioContext'].forEach(function (k) {
    var A = window[k]; if (!A) return;
    var AC = function () {
      var c = arguments.length ? new A(arguments[0]) : new A();
      var n = stat.ctxs.push(c);
      log('Audio#' + n + ' created ' + c.state + ' ' + c.sampleRate + 'Hz');
      try { c.addEventListener('statechange', function () { log('Audio#' + n + ' ' + c.state); }); } catch (e) {}
      return c;
    };
    AC.prototype = A.prototype;
    window[k] = AC;
  });

  // ---- Microphone ----
  try {
    var md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      var g = md.getUserMedia.bind(md);
      md.getUserMedia = function (c) {
        if (killed) return Promise.reject(new DOMException('License locked', 'NotAllowedError'));
        return g(c).then(function (s) { streams.push(s); log('mic/cam granted: ' + (c && c.video ? 'video ' : '') + (c && c.audio ? 'audio' : '')); return s; },
          function (e) { log('mic/cam DENIED ' + (e && e.name)); throw e; });
      };
    }
  } catch (e) {}

  // ---- Hard stop, used by the license guard when a license fails ----
  window.__blipStopAll = function () {
    killed = true;
    log('STOPPED by license guard');
    live.forEach(function (w) { try { w.close(1000, 'license'); } catch (e) {} });
    streams.forEach(function (s) { try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} });
    stat.ctxs.forEach(function (c) { try { c.close(); } catch (e) {} });
    try {
      var ss = window.speechSynthesis;
      if (ss) { ss.cancel(); var sp = ss.speak.bind(ss); ss.speak = function (u) { if (!killed) return sp(u); }; }
    } catch (e) {}
  };

  // ---- JS errors ----
  window.addEventListener('error', function (e) { log('JS error: ' + String(e.message).slice(0, 100)); });
  window.addEventListener('unhandledrejection', function (e) { log('Promise error: ' + String((e.reason && e.reason.message) || e.reason).slice(0, 100)); });

  // ---- Panel ----
  function statusLine() {
    var s = 'audio chunks: ' + stat.audioMsgs + (stat.lastAudio ? ' (last ' + ((Date.now() - stat.lastAudio) / 1000).toFixed(0) + 's ago)' : '');
    s = 'mic sent: ' + stat.sentAudio + (stat.lastSent ? ' (last ' + ((Date.now() - stat.lastSent) / 1000).toFixed(0) + 's ago)' : '') + ' | cam frames sent: ' + stat.sentVideo + '\n' + s;
    s += ' | ctx: ' + (stat.ctxs.map(function (c) { return c.state; }).join(',') || 'none');
    if (wd.resets) s += ' | auto-restarts: ' + wd.resets;
    try {
      var b = window.BLIP && window.BLIP.getGeminiBudgetStatus && window.BLIP.getGeminiBudgetStatus();
      if (b) s += ' | calls today: ' + b.callsToday + (b.rateLimited ? ' | RATE-LIMITED ' + b.cooldownSecondsLeft + 's' : ' | not limited');
    } catch (e) {}
    return s;
  }
  function render() {
    if (!box) return;
    box.textContent = statusLine() + '\nKEY: ' + keep.slice(-7).join('\n') + '\nHEARD: ' + (stat.heard || '-') + '\nSAID: ' + (stat.said || '-') + '\n' + logs.slice(-3).join('\n');
  }
  function show(v) {
    on = v;
    if (v) {
      if (!box) {
        box = document.createElement('pre');
        box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;margin:0;padding:6px 8px;max-height:42vh;overflow:hidden;background:rgba(0,0,0,.82);color:#9fe870;font:10px/1.3 monospace;white-space:pre-wrap;pointer-events:none;';
        (document.body || document.documentElement).appendChild(box);
      }
      box.style.display = 'block'; render();
    } else if (box) box.style.display = 'none';
  }
  setInterval(function () { if (on) render(); }, 1000);

  var taps = [];
  document.addEventListener('pointerdown', function (e) {
    if (e.clientX > 70 || e.clientY > 70) return;
    var now = Date.now(); taps.push(now);
    taps = taps.filter(function (t) { return now - t < 3000; });
    if (taps.length >= 5) { taps = []; show(!on); }
  }, true);
  note(VER + ' loaded');
  try {
    var hits = [];
    for (var qi = 0; qi < localStorage.length; qi++) {
      var qk = localStorage.key(qi);
      if (/name|user|profile|memory|remember|person/i.test(qk) && !/^blip_(license_state|device_id|gs_blocked_until|model_pref)$/.test(qk)) hits.push(qk + '=' + String(localStorage.getItem(qk)).slice(0, 28));
    }
    note(hits.length ? 'saved on phone: ' + hits.join(' | ').slice(0, 130) : 'no saved name/profile keys on this phone');
  } catch (e) {} log('diagnostics ready');
})();
