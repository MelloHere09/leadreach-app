// Ported from screen() in ig_lead_qualifier.py / filter_leads.pl. Verdicts
// are kept distinct (not collapsed to a single pass/fail) so a run can show
// *why* leads were cut, same as the reference pipeline's summary sheet.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{followers: number|null, isPrivate: boolean, lastPostAt: Date|null}} profile
 * @param {{minFollowers: number, maxFollowers: number, activeWithinDays: number}} filters
 * @returns {{verdict: string, qualified: boolean}}
 */
function qualifyLead(profile, filters) {
  const { minFollowers, maxFollowers, activeWithinDays } = filters;

  if (typeof profile.followers !== 'number') return { verdict: 'no_follows', qualified: false };
  if (profile.followers < minFollowers) return { verdict: 'too_small', qualified: false };
  if (profile.followers > maxFollowers) return { verdict: 'too_big', qualified: false };
  if (profile.isPrivate) return { verdict: 'private', qualified: false };

  if (!profile.lastPostAt) return { verdict: 'unknown', qualified: false };

  const ageDays = (Date.now() - profile.lastPostAt.getTime()) / DAY_MS;
  if (ageDays <= activeWithinDays) return { verdict: 'fresh', qualified: true };
  return { verdict: 'stale', qualified: false };
}

module.exports = { qualifyLead };
