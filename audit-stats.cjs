// Quick audit of vaultflow.db for data completeness
const path = require('node:path');
const dbMod = require('./.claude/helpers/db.cjs');
dbMod.initialize();
const raw = dbMod.raw();

function q(sql, label) {
  try {
    const r = raw.prepare(sql).get();
    console.log(label, '::', JSON.stringify(r));
  } catch (e) {
    console.log(label, '!! ERROR:', e.message);
  }
}

function rows(sql, label, n = 5) {
  try {
    const r = raw.prepare(sql).all();
    console.log(label, '::', r.length, 'rows');
    for (const row of r.slice(0, n)) console.log('   ', JSON.stringify(row));
  } catch (e) {
    console.log(label, '!! ERROR:', e.message);
  }
}

console.log('=== SESSIONS COMPLETENESS ===');
q(`SELECT COUNT(*) total,
   SUM(CASE WHEN started_at IS NULL OR started_at='' THEN 1 ELSE 0 END) missing_start,
   SUM(CASE WHEN ended_at IS NULL OR ended_at='' THEN 1 ELSE 0 END) missing_end,
   SUM(CASE WHEN duration_ms IS NULL OR duration_ms=0 THEN 1 ELSE 0 END) missing_duration,
   SUM(CASE WHEN project IS NULL OR project='' THEN 1 ELSE 0 END) missing_project,
   SUM(CASE WHEN cli IS NULL OR cli='' THEN 1 ELSE 0 END) missing_cli,
   SUM(CASE WHEN model IS NULL OR model='' THEN 1 ELSE 0 END) missing_model,
   SUM(CASE WHEN cli_version IS NULL OR cli_version='' THEN 1 ELSE 0 END) missing_cli_version,
   SUM(CASE WHEN model_provider IS NULL OR model_provider='' THEN 1 ELSE 0 END) missing_model_provider,
   SUM(CASE WHEN platform IS NULL OR platform='' THEN 1 ELSE 0 END) missing_platform
   FROM sessions`, 'sessions');

console.log('\n=== PROMPTS COMPLETENESS ===');
q(`SELECT COUNT(*) total,
   SUM(CASE WHEN timestamp IS NULL OR timestamp='' THEN 1 ELSE 0 END) missing_ts,
   SUM(CASE WHEN session_id IS NULL OR session_id='' THEN 1 ELSE 0 END) missing_sid,
   SUM(CASE WHEN prompt_text IS NULL OR prompt_text='' THEN 1 ELSE 0 END) missing_text,
   SUM(CASE WHEN source IS NULL OR source='' THEN 1 ELSE 0 END) missing_source,
   SUM(CASE WHEN skill_routed IS NULL OR skill_routed='' THEN 1 ELSE 0 END) missing_skill_routed
   FROM prompts`, 'prompts');

console.log('\n=== TOOL_CALLS COMPLETENESS ===');
q(`SELECT COUNT(*) total,
   SUM(CASE WHEN timestamp IS NULL OR timestamp='' THEN 1 ELSE 0 END) missing_ts,
   SUM(CASE WHEN session_id IS NULL OR session_id='' THEN 1 ELSE 0 END) missing_sid,
   SUM(CASE WHEN tool_name IS NULL OR tool_name='' THEN 1 ELSE 0 END) missing_tool,
   SUM(CASE WHEN input_hash IS NULL OR input_hash='' THEN 1 ELSE 0 END) missing_hash,
   SUM(CASE WHEN input_json IS NULL OR input_json='' THEN 1 ELSE 0 END) missing_json
   FROM tool_calls`, 'tool_calls');

console.log('\n=== EDIT_EVENTS COMPLETENESS ===');
q(`SELECT COUNT(*) total,
   SUM(CASE WHEN timestamp IS NULL OR timestamp='' THEN 1 ELSE 0 END) missing_ts,
   SUM(CASE WHEN session_id IS NULL OR session_id='' THEN 1 ELSE 0 END) missing_sid,
   SUM(CASE WHEN file_path IS NULL OR file_path='' THEN 1 ELSE 0 END) missing_path,
   SUM(CASE WHEN project IS NULL OR project='' THEN 1 ELSE 0 END) missing_project,
   SUM(CASE WHEN change_type IS NULL OR change_type='' THEN 1 ELSE 0 END) missing_type
   FROM edit_events`, 'edit_events');

console.log('\n=== TIMESTAMP RANGES ===');
q(`SELECT MIN(started_at) min, MAX(started_at) max, MIN(ended_at) min_end, MAX(ended_at) max_end FROM sessions`, 'sessions');
q(`SELECT MIN(timestamp) min, MAX(timestamp) max FROM prompts`, 'prompts');
q(`SELECT MIN(timestamp) min, MAX(timestamp) max FROM tool_calls`, 'tool_calls');
q(`SELECT MIN(timestamp) min, MAX(timestamp) max FROM edit_events`, 'edit_events');

console.log('\n=== ORPHAN SESSION_IDS (FK violations) ===');
q(`SELECT COUNT(*) FROM prompts p WHERE p.session_id IS NOT NULL AND p.session_id != '' AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = p.session_id)`, 'prompts.orphan');
q(`SELECT COUNT(*) FROM tool_calls t WHERE t.session_id IS NOT NULL AND t.session_id != '' AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = t.session_id)`, 'tool_calls.orphan');
q(`SELECT COUNT(*) FROM edit_events e WHERE e.session_id IS NOT NULL AND e.session_id != '' AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id)`, 'edit_events.orphan');

console.log('\n=== SESSIONS WITH ACTIVITY BUT NO ended_at ===');
q(`SELECT COUNT(DISTINCT s.id) FROM sessions s
   JOIN tool_calls t ON t.session_id = s.id
   WHERE (s.ended_at IS NULL OR s.ended_at='')
     AND s.started_at < datetime('now','-24 hours')`,
   'old_unclosed_with_activity');

console.log('\n=== CLI / TOOL DISTRIBUTION ===');
rows(`SELECT cli, COUNT(*) c FROM sessions GROUP BY cli ORDER BY c DESC`, 'cli', 20);
rows(`SELECT model, COUNT(*) c FROM sessions GROUP BY model ORDER BY c DESC`, 'model', 20);
rows(`SELECT model_provider, COUNT(*) c FROM sessions GROUP BY model_provider ORDER BY c DESC`, 'provider', 20);
rows(`SELECT platform, COUNT(*) c FROM sessions GROUP BY platform ORDER BY c DESC`, 'platform', 20);

console.log('\n=== TOOL_CALLS WITH BLANK input_hash (dedupe broken?) ===');
q(`SELECT COUNT(*) FROM tool_calls WHERE input_hash IS NULL OR input_hash=''`, 'blank_hash');
rows(`SELECT input_hash, COUNT(*) c FROM tool_calls WHERE input_hash IS NOT NULL AND input_hash != '' GROUP BY input_hash HAVING c > 1 ORDER BY c DESC`, 'duplicate_hashes', 5);

console.log('\n=== PROMPTS sources & skill_routed values ===');
rows(`SELECT source, COUNT(*) c FROM prompts GROUP BY source ORDER BY c DESC`, 'sources', 10);
rows(`SELECT skill_routed, COUNT(*) c FROM prompts GROUP BY skill_routed ORDER BY c DESC`, 'skills', 10);

console.log('\n=== PROJECT distribution ===');
rows(`SELECT project, COUNT(*) c FROM sessions GROUP BY project ORDER BY c DESC`, 'session_projects', 30);
rows(`SELECT project, COUNT(*) c FROM edit_events GROUP BY project ORDER BY c DESC`, 'edit_projects', 30);

console.log('\n=== MEMORY entries / dictionary integrity ===');
q(`SELECT COUNT(*) total, SUM(CASE WHEN body IS NULL OR body='' THEN 1 ELSE 0 END) missing_body, SUM(CASE WHEN title IS NULL OR title='' THEN 1 ELSE 0 END) missing_title FROM memory_entries`, 'memory_entries');
q(`SELECT COUNT(*) total, SUM(CASE WHEN definition IS NULL OR definition='' THEN 1 ELSE 0 END) missing_def, SUM(CASE WHEN category IS NULL OR category='' THEN 1 ELSE 0 END) missing_cat FROM dictionary`, 'dictionary');
q(`SELECT COUNT(*) total, SUM(CASE WHEN description IS NULL OR description='' THEN 1 ELSE 0 END) missing_desc, SUM(CASE WHEN path IS NULL OR path='' THEN 1 ELSE 0 END) missing_path FROM vault_tools`, 'vault_tools');
q(`SELECT COUNT(*) total, SUM(CASE WHEN description IS NULL OR description='' THEN 1 ELSE 0 END) missing_desc FROM vault_agents`, 'vault_agents');

console.log('\n=== Patterns / model_performance ===');
rows(`SELECT pattern_key, agent, fire_count, promoted FROM patterns ORDER BY fire_count DESC LIMIT 10`, 'top_patterns', 10);
rows(`SELECT * FROM model_performance LIMIT 10`, 'model_performance', 10);

console.log('\n=== FTS5 sync check (each table vs its FTS) ===');
const ftsPairs = [['memory_entries','memory_fts'],['dictionary','dictionary_fts'],['vault_tools','vault_tools_fts'],['prompts','prompts_fts'],['tool_calls','tool_calls_fts'],['session_summaries','session_summaries_fts'],['retrieval_docs','retrieval_docs_fts'],['patterns','patterns_fts']];
for (const [t,f] of ftsPairs) {
  const a = raw.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const b = raw.prepare(`SELECT COUNT(*) c FROM ${f}`).get().c;
  console.log(`${t}=${a}  ${f}=${b}  ${a===b?'OK':'!! MISMATCH'}`);
}

console.log('\n=== Orphan sessions per CLI (NULL ended_at) ===');
rows(`SELECT cli, COUNT(*) c FROM sessions WHERE ended_at IS NULL OR ended_at='' GROUP BY cli ORDER BY c DESC`, 'unclosed_by_cli', 20);

console.log('\n=== SESSIONS started today, never closed ===');
q(`SELECT COUNT(*) FROM sessions WHERE (ended_at IS NULL OR ended_at='') AND started_at >= date('now','-1 day')`, 'recent_unclosed');

console.log('\n=== EDIT_EVENTS distribution ===');
rows(`SELECT change_type, COUNT(*) c FROM edit_events GROUP BY change_type ORDER BY c DESC`, 'change_types', 10);
