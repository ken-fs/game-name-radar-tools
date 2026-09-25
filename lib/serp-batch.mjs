// 批量 SERP 查询（Tavily REST）——绕过 MCP 输出截断
// 用法: node lib/serp-batch.mjs "query1" "query2" ...
const KEY = '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';

async function search(q) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query: q, max_results: 10, search_depth: 'basic' }),
  });
  const d = await r.json();
  if (!r.ok) return { q, err: d?.detail?.error || d?.detail || r.status };
  return { q, results: (d.results || []).map((x) => ({ t: x.title, u: x.url })) };
}

const out = [];
for (const q of process.argv.slice(2)) {
  out.push(await search(q));
  await new Promise((r) => setTimeout(r, 500));
}
for (const r of out) {
  console.log(`\n── ${r.q}`);
  if (r.err) { console.log('   ERR', r.err); continue; }
  for (const x of r.results) console.log(`   ${x.t}  |  ${x.u}`);
}
