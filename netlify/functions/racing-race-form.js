// Fetches runner-level form data for one specific race, called on demand when the
// user taps into a race (not auto-fetched for every race, to conserve the free quota).

function escapeHtmlLite(str) {
  return String(str == null ? '' : str);
}

// Matches today's race condition text (e.g. "Good 4", "Heavy 10") to one of
// FormFav's condition buckets (good/soft/heavy/firm/synthetic).
function matchConditionStats(conditions, conditionLabel) {
  if (!conditions || !conditionLabel) return null;
  const label = conditionLabel.toLowerCase();
  const key = ['good', 'soft', 'heavy', 'firm', 'synthetic'].find(k => label.includes(k));
  return key ? conditions[key] : null;
}

// Builds a short, factual sentence from real career stats — no predictions or tips,
// just a plain-English summary of numbers FormFav already gave us.
function buildWriteup({ form, overall, track, distance, conditionStats, conditionLabel }) {
  const parts = [];

  if (overall && overall.starts) {
    parts.push(`\( {overall.wins || 0} win \){overall.wins === 1 ? '' : 's'} from \( {overall.starts} start \){overall.starts === 1 ? '' : 's'}` +
      (overall.winPercent != null ? ` (${Math.round(overall.winPercent * 100)}% win rate)` : ''));
  }

  if (track && track.starts) {
    parts.push(`${track.wins || 0} from ${track.starts} at this track`);
  }

  if (distance && distance.starts) {
    parts.push(`${distance.wins || 0} from ${distance.starts} at this distance`);
  }

  if (conditionStats && conditionStats.starts && conditionLabel) {
    parts.push(`${conditionStats.wins || 0} from ${conditionStats.starts} on ${conditionLabel.toLowerCase()} tracks`);
  }

  if (form) {
    parts.push(`recent form: ${form}`);
  }

  if (parts.length === 0) return 'No career stats available for this runner yet.';

  // Join as a readable sentence, capitalizing the first part.
  const joined = parts.join('; ');
  return joined.charAt(0).toUpperCase() + joined.slice(1) + '.';
}

export default async function (request) {
  const apiKey = process.env.FORMFAV_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'FORMFAV_API_KEY not configured.' }), {
      status: 500,
    });
  }

  const url = new URL(request.url);
  const track = url.searchParams.get("track");
  const race = url.searchParams.get("race");
  const date = url.searchParams.get("date");

  if (!track || !race) {
    return new Response(JSON.stringify({ error: 'track and race query params are required.' }), {
      status: 400,
    });
  }
  const raceDate = date || new Date().toISOString().slice(0, 10);

  const apiUrl = `https://api.formfav.com/v1/form?track=\( {encodeURIComponent(track)}&race= \){encodeURIComponent(race)}&date=${raceDate}`;

  try {
    const res = await fetch(apiUrl, { headers: { 'X-API-Key': apiKey } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`FormFav responded ${res.status}: ${text}`);
    }
    const data = await res.json();

    const runners = (data.runners || []).map(r => {
      const stats = r.stats || {};
      const overall = stats.overall || {};
      const trackStats = stats.track || {};
      const distance = stats.distance || {};
      const conditionStats = matchConditionStats(stats.conditions, data.condition);

      return {
        number: r.number,
        name: r.name,
        jockey: r.jockey,
        trainer: r.trainer,
        barrier: r.barrier,
        weight: r.weight,
        age: r.age,
        sex: r.sex,
        form: r.form,
        careerPrizeMoney: r.careerPrizeMoney,
        starts: overall.starts,
        wins: overall.wins,
        places: overall.places,
        winPercent: overall.winPercent,
        placePercent: overall.placePercent,
        writeup: buildWriteup({ form: r.form, overall, track: trackStats, distance, conditionStats, conditionLabel: data.condition })
      };
    });

    // A factual "best win-rate" runner, since no live odds are available to determine
    // a true market favourite — sorted by career win percentage among runners with a
    // meaningful sample size (3+ starts) to avoid a 1-start 100% outlier topping the list.
    const eligible = runners.filter(r => (r.starts || 0) >= 3);
    const bestWinRate = eligible.length
      ? eligible.reduce((best, r) => (r.winPercent > (best.winPercent || 0) ? r : best), eligible[0])
      : null;

    return new Response(JSON.stringify({
      track: data.track,
      raceNumber: data.raceNumber,
      raceName: data.raceName,
      raceClass: data.raceClass,
      distance: data.distance,
      condition: data.condition,
      startTime: data.startTime,
      runners,
      bestWinRateRunner: bestWinRate ? bestWinRate.name : null
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
    });
  }
} 
