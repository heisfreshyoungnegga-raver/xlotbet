const { sql, msql, readBody, send, guard, requireAdmin, isCustomMatch, customMatchState, settleMatch } = require('../../_lib');

// Settle a finished match manually: resolve the final score (given,
// stored, or a featured match's scheduled score), stamp it on the
// match, then run the shared settlement. Routine settlement is
// automatic — maybeAutoSettle in api/_lib.js runs it from the match
// list once the feeds mark a match finished — so this endpoint is
// the operator's override/correction path.
module.exports = guard(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const auth = requireAdmin(req, res);
  if (!auth) return;
  const { match_id, score_home, score_away } = await readBody(req);
  let home = Number(score_home), away = Number(score_away);
  if (!match_id) return send(res, 400, { error: 'match_required' });
  if (Number.isNaN(home) || Number.isNaN(away)) {
    const stored = await msql('select score_home, score_away, external_ref, goal_events, starts_at, status from matches where id = $1', [match_id]);
    if (!stored.length) return send(res, 404, { error: 'match_not_found' });
    if (isCustomMatch(stored[0])) {
      // Featured matches settle on their scheduled final score.
      const st = customMatchState(stored[0]);
      home = st.final_home; away = st.final_away;
    } else {
      home = Number(stored[0].score_home); away = Number(stored[0].score_away);
    }
  }

  await msql("update matches set status = 'finished', score_home = $2, score_away = $3 where id = $1", [match_id, home, away]);

  const out = await settleMatch(match_id, home, away);
  send(res, 200, { ok: true, ...out });
});
