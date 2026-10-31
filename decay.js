// @ts-check
/**
 * MostPopular.com — dual-timescale exponential vote decay.
 *
 *   S(t) = α · Σ wᵢ·e^(−λf (t − tᵢ))  +  (1 − α) · Σ wᵢ·e^(−λs (t − tᵢ))
 *   λ = ln 2 / half-life
 *
 * - Fast term (default 3-day half-life) lets a spike surface quickly and fade.
 * - Slow term (default 45-day half-life) preserves sustained prestige.
 *
 * Efficiency trick: S(t) = e^(−λt) · Σ wᵢ·e^(λ tᵢ), and e^(−λt) is a common
 * factor for every figure. So we store only L = ln Σ wᵢ·e^(λ(tᵢ − t0)) per
 * component. A vote is one logaddexp (O(1)); ordering by L equals ordering by
 * decayed score, so no periodic decay job is ever required.
 *
 * Parameters mirror schema.sql (epoch 2026-01-01 UTC, α = 0.6, 3d / 45d).
 */

export const DAY_MS = 86_400_000;
export const EPOCH_MS = Date.UTC(2026, 0, 1);
/** Sentinel for "no votes" (finite, so it survives JSON). */
export const NO_VOTES = -1e9;

/**
 * @typedef {Object} DecayParams
 * @property {number} halfLifeFastDays
 * @property {number} halfLifeSlowDays
 * @property {number} mix  Weight α of the fast term, 0..1.
 */
/** @typedef {{ lf: number, ls: number }} ScoreState  Log-space accumulators. */
/** @typedef {{ t: number, w?: number }} VoteEvent    t = epoch ms. */

/** @type {Readonly<DecayParams>} */
export const DEFAULT_PARAMS = Object.freeze({
  halfLifeFastDays: 3,
  halfLifeSlowDays: 45,
  mix: 0.6,
});

/** @param {number} halfLifeDays */
const lambda = (halfLifeDays) => Math.LN2 / halfLifeDays;
/** @param {number} ms */
const days = (ms) => (ms - EPOCH_MS) / DAY_MS;

/**
 * Numerically stable ln(eᵃ + eᵇ).
 * @param {number} a @param {number} b
 */
export function logAddExp(a, b) {
  const hi = Math.max(a, b);
  return hi + Math.log1p(Math.exp(-Math.abs(a - b)));
}

/** @returns {ScoreState} */
export const emptyState = () => ({ lf: NO_VOTES, ls: NO_VOTES });

/**
 * Add one vote. Pure: returns a new state.
 * @param {ScoreState} state
 * @param {number} tMs Vote time (epoch ms).
 * @param {number} [weight=1] Must be > 0.
 * @param {DecayParams} [p]
 * @returns {ScoreState}
 */
export function applyVote(state, tMs, weight = 1, p = DEFAULT_PARAMS) {
  if (!(weight > 0)) throw new RangeError('weight must be > 0');
  const d = days(tMs);
  const lw = Math.log(weight);
  return {
    lf: logAddExp(state.lf, lw + lambda(p.halfLifeFastDays) * d),
    ls: logAddExp(state.ls, lw + lambda(p.halfLifeSlowDays) * d),
  };
}

/**
 * Rebuild a state from raw votes (offline / localStorage fallback).
 * @param {Iterable<VoteEvent>} votes
 * @param {DecayParams} [p]
 */
export function stateFromVotes(votes, p = DEFAULT_PARAMS) {
  let s = emptyState();
  for (const v of votes) s = applyVote(s, v.t, v.w ?? 1, p);
  return s;
}

/**
 * Current decayed score at `nowMs`.
 * @param {ScoreState} state
 * @param {number} [nowMs]
 * @param {DecayParams} [p]
 */
export function score(state, nowMs = Date.now(), p = DEFAULT_PARAMS) {
  const d = days(nowMs);
  const fast = Math.exp(state.lf - lambda(p.halfLifeFastDays) * d);
  const slow = Math.exp(state.ls - lambda(p.halfLifeSlowDays) * d);
  return p.mix * fast + (1 - p.mix) * slow;
}

/**
 * Friendly, compressed points for the UI (log keeps spikes from dwarfing everyone).
 * @param {number} s
 */
export const displayPoints = (s) => Math.round(100 * Math.log1p(s));

/**
 * What one vote is worth `ageDays` after it was cast (1.0 at age 0).
 * @param {number} ageDays @param {DecayParams} [p]
 */
export function voteValueAfter(ageDays, p = DEFAULT_PARAMS) {
  return (
    p.mix * Math.exp(-lambda(p.halfLifeFastDays) * ageDays) +
    (1 - p.mix) * Math.exp(-lambda(p.halfLifeSlowDays) * ageDays)
  );
}

/**
 * Rank figures (competition ranking: ties share a rank). O(n log n), scores computed once.
 * @template {{ lf: number, ls: number }} T
 * @param {T[]} figures
 * @param {number} [nowMs]
 * @param {DecayParams} [p]
 * @returns {(T & { score: number, rank: number })[]}
 */
export function rankFigures(figures, nowMs = Date.now(), p = DEFAULT_PARAMS) {
  const scored = figures.map((f) => ({ ...f, score: score(f, nowMs, p), rank: 0 }));
  scored.sort((a, b) => b.score - a.score);
  let prev = NaN;
  let rank = 0;
  for (let i = 0; i < scored.length; i++) {
    if (scored[i].score !== prev) {
      rank = i + 1;
      prev = scored[i].score;
    }
    scored[i].rank = rank;
  }
  return scored;
}

/*
 * Sanity check (α=0.6, 3d/45d): a vote is worth
 *   1.00 today · ≈0.68 at 3 days · ≈0.25 at 30 days · ≈0.10 at 90 days.
 */
