export function calculatePoints(stats, rules) {
  const ruleResults = new Map();
  let total = 0;
  const breakdown = {};

  for (const rule of rules) {
    if (rule.type === 'multiplier') continue;

    let pts = 0;
    const val = parseFloat(stats[rule.stat] ?? 0) || 0;

    if (rule.type === 'per_unit') {
      pts = val * rule.points;
    } else if (rule.type === 'flat') {
      pts = val >= rule.min ? rule.points : 0;
    } else if (rule.type === 'flat_exact') {
      pts = val === rule.value ? rule.points : 0;
    } else if (rule.type === 'banded_computed') {
      const num = parseFloat(stats[rule.numerator] ?? 0) || 0;
      const den = parseFloat(stats[rule.denominator] ?? 0) || 0;
      if (den >= (rule.min_denominator ?? 0)) {
        const computed = (num / den) * (rule.scale ?? 1);
        for (const band of rule.bands) {
          const aboveMin = band.min === undefined || computed >= band.min;
          const belowMax = band.max === undefined || computed <= band.max;
          if (aboveMin && belowMax) { pts = band.points; break; }
        }
      }
    }

    ruleResults.set(rule.id, pts);
    if (pts !== 0) breakdown[rule.label] = pts;
    total += pts;
  }

  for (const rule of rules) {
    if (rule.type !== 'multiplier') continue;
    const val = parseFloat(stats[rule.stat] ?? 0) || 0;
    if (val >= rule.min && ruleResults.has(rule.target_rule)) {
      const basePts = ruleResults.get(rule.target_rule);
      const bonus = basePts * (rule.multiplier - 1);
      if (bonus !== 0) breakdown[rule.label] = Math.round(bonus * 10) / 10;
      total += bonus;
    }
  }

  return { total: Math.round(total * 10) / 10, breakdown };
}

export const SCORING_PRESETS = {
  cricket: {
    stats: [
      { key: 'runs', label: 'Runs' },
      { key: 'balls_faced', label: 'Balls Faced' },
      { key: 'fours', label: 'Fours' },
      { key: 'sixes', label: 'Sixes' },
      { key: 'duck', label: 'Duck (1=yes)' },
      { key: 'not_out', label: 'Not Out (1=yes)' },
      { key: 'wickets', label: 'Wickets' },
      { key: 'overs_bowled', label: 'Overs Bowled' },
      { key: 'runs_conceded', label: 'Runs Conceded' },
      { key: 'maidens', label: 'Maiden Overs' },
      { key: 'dot_balls', label: 'Dot Balls' },
      { key: 'catches', label: 'Catches' },
      { key: 'stumpings', label: 'Stumpings/Run Outs' },
      { key: 'mvp_rank', label: 'MVP Rank (1-3, 0=none)' }
    ],
    rules: [
      { id: 'r_runs', label: 'Per Run', type: 'per_unit', stat: 'runs', points: 0.5 },
      { id: 'r_fours', label: 'Fours Bonus', type: 'per_unit', stat: 'fours', points: 0.5 },
      { id: 'r_sixes', label: 'Sixes Bonus', type: 'per_unit', stat: 'sixes', points: 1 },
      { id: 'r_duck', label: 'Duck Penalty', type: 'flat', stat: 'duck', min: 1, points: -4 },
      { id: 'r_not_out', label: 'Not Out Bonus', type: 'flat', stat: 'not_out', min: 1, points: 5 },
      { id: 'r_fifty', label: 'Half Century (50+ runs)', type: 'flat', stat: 'runs', min: 50, points: 4 },
      { id: 'r_century', label: 'Century (100+ runs)', type: 'flat', stat: 'runs', min: 100, points: 8 },
      { id: 'r_sr', label: 'Strike Rate Bands', type: 'banded_computed', numerator: 'runs', denominator: 'balls_faced', min_denominator: 10, scale: 100, bands: [
        { max: 89.99, points: -4 },
        { min: 150, max: 199.99, points: 5 },
        { min: 200, points: 10 }
      ]},
      { id: 'r_wickets', label: 'Per Wicket', type: 'per_unit', stat: 'wickets', points: 10 },
      { id: 'r_wicket_bonus', label: 'Wicket Haul Bonus (2+)', type: 'multiplier', stat: 'wickets', min: 2, target_rule: 'r_wickets', multiplier: 2.5 },
      { id: 'r_economy', label: 'Economy Rate Bands', type: 'banded_computed', numerator: 'runs_conceded', denominator: 'overs_bowled', min_denominator: 0.1, scale: 1, bands: [
        { max: 6, points: 10 },
        { min: 6.01, max: 8, points: 5 },
        { min: 9.01, max: 12, points: -5 },
        { min: 12.01, points: -10 }
      ]},
      { id: 'r_maidens', label: 'Maiden Overs', type: 'per_unit', stat: 'maidens', points: 4 },
      { id: 'r_dots', label: 'Dot Balls', type: 'per_unit', stat: 'dot_balls', points: 1 },
      { id: 'r_catches', label: 'Catches', type: 'per_unit', stat: 'catches', points: 4 },
      { id: 'r_stumpings', label: 'Stumpings/Run Outs', type: 'per_unit', stat: 'stumpings', points: 6 },
      { id: 'r_mvp1', label: 'MVP 1', type: 'flat_exact', stat: 'mvp_rank', value: 1, points: 10 },
      { id: 'r_mvp2', label: 'MVP 2', type: 'flat_exact', stat: 'mvp_rank', value: 2, points: 5 },
      { id: 'r_mvp3', label: 'MVP 3', type: 'flat_exact', stat: 'mvp_rank', value: 3, points: 3 }
    ]
  },
  football: {
    stats: [
      { key: 'goals', label: 'Goals Scored' },
      { key: 'assists', label: 'Assists' },
      { key: 'clean_sheet', label: 'Clean Sheet (1=yes)' },
      { key: 'yellow_cards', label: 'Yellow Cards' },
      { key: 'red_card', label: 'Red Card (1=yes)' },
      { key: 'saves', label: 'Saves (GK)' },
      { key: 'minutes', label: 'Minutes Played' }
    ],
    rules: [
      { id: 'r_goals', label: 'Goal Scored', type: 'per_unit', stat: 'goals', points: 5 },
      { id: 'r_assists', label: 'Assist', type: 'per_unit', stat: 'assists', points: 3 },
      { id: 'r_cs', label: 'Clean Sheet', type: 'flat', stat: 'clean_sheet', min: 1, points: 4 },
      { id: 'r_yellow', label: 'Yellow Card', type: 'per_unit', stat: 'yellow_cards', points: -1 },
      { id: 'r_red', label: 'Red Card', type: 'flat', stat: 'red_card', min: 1, points: -3 },
      { id: 'r_saves', label: 'Save (GK)', type: 'per_unit', stat: 'saves', points: 1 },
      { id: 'r_played', label: 'Played 45+ min', type: 'flat', stat: 'minutes', min: 45, points: 2 }
    ]
  },
  basketball: {
    stats: [
      { key: 'points', label: 'Points Scored' },
      { key: 'rebounds', label: 'Rebounds' },
      { key: 'assists', label: 'Assists' },
      { key: 'steals', label: 'Steals' },
      { key: 'blocks', label: 'Blocks' },
      { key: 'turnovers', label: 'Turnovers' },
      { key: 'threes', label: '3-Pointers Made' }
    ],
    rules: [
      { id: 'r_pts', label: 'Points Scored', type: 'per_unit', stat: 'points', points: 1 },
      { id: 'r_reb', label: 'Rebound', type: 'per_unit', stat: 'rebounds', points: 1.2 },
      { id: 'r_ast', label: 'Assist', type: 'per_unit', stat: 'assists', points: 1.5 },
      { id: 'r_stl', label: 'Steal', type: 'per_unit', stat: 'steals', points: 3 },
      { id: 'r_blk', label: 'Block', type: 'per_unit', stat: 'blocks', points: 3 },
      { id: 'r_to', label: 'Turnover', type: 'per_unit', stat: 'turnovers', points: -1 },
      { id: 'r_3pt', label: '3-Pointer Bonus', type: 'per_unit', stat: 'threes', points: 0.5 }
    ]
  }
};
