// Optional: real web search for BLIP (news, prices, anything current).
// Needs a free Tavily key (tavily.com) saved in Netlify as environment variable TAVILY_API_KEY.
// Without the key BLIP still works - it falls back to weather, exchange rates and Wikipedia.
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const q = ((event.queryStringParameters || {}).q || '').slice(0, 200).trim();
  const key = process.env.TAVILY_API_KEY;
  if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing q' }) };
  if (!key) return { statusCode: 501, headers, body: JSON.stringify({ error: 'TAVILY_API_KEY not set' }) };
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ query: q, max_results: 4, include_answer: true, search_depth: 'basic' })
    });
    if (!r.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: 'search provider ' + r.status }) };
    const j = await r.json();
    const out = {
      source: 'web search',
      answer: j.answer || '',
      results: (j.results || []).slice(0, 4).map((x) => ({ title: x.title, url: x.url, content: String(x.content || '').slice(0, 350) }))
    };
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'search failed' }) };
  }
};
