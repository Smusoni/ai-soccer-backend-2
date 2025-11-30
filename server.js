// -------------------- Part 1: Training Clip Analyze (button) --------------------
/**
 * This is the core of Part 1:
 * - Takes profile + what skill they’re working on + a training clip URL
 * - Calls OpenAI to generate a JSON report
 * - Saves a copy into the Library
 * - Returns the report + the new analysisId
 */
async function runTextAnalysisForTraining({ profile, user, videoUrl, skill }) {
  if (!openai) {
    // Fallback if API key missing
    const genericSummary = `Quick training analysis for ${profile.position || 'your role'}. Continue focusing on your technique and decision making.`;
    return {
      summary: genericSummary,
      focus: [
        'Technical repetition',
        'Decision making under light pressure',
        'Consistent body shape on the ball'
      ],
      drills: [
        { title: 'Wall passes with tight touch', url: 'https://youtu.be/ZNk6NIxPkb0' },
        { title: '1v1 change-of-direction drill', url: 'https://youtu.be/0W2bXg2NaqE' },
        { title: 'First-touch receiving patterns', url: 'https://youtu.be/x7Jr8OZnS7U' }
      ],
      comps: [] // kept for future, but frontend doesn't show it
    };
  }

  const age = profile.age ?? user?.age ?? null;
  const isYouth = age != null ? Number(age) < 18 : false;
  const heightIn = profile.height || null;
  const weightLb = profile.weight || null;

  const sys = `You are a soccer performance trainer working 1:1 with players.
Return STRICT JSON ONLY with fields:

{
  "summary": string,
  "focus": string[3..6],
  "drills": [
    { "title": string, "url": string }
  ],
  "comps": string[2..4]
}

Guidelines:
- Tailor everything to THIS specific player (age, position, foot, skill).
- Assume the attached clip shows them working on that skill in a realistic training setting.
- If they’re youth, keep language simple and supportive.
- Be specific about HOW to execute and fix technique, not just "work harder".
- Do NOT mention JSON, keys, or that you are an AI. Just output valid JSON.`;

  const context = {
    name: user?.name || null,
    age,
    isYouth,
    position: profile.position || 'Unknown',
    dominantFoot: profile.foot || 'Unknown',
    heightIn,
    weightLb,
    skillWorkingOn: skill || profile.skill || null,
    videoUrl
  };

  const userText = `
Player context: ${JSON.stringify(context, null, 2)}

Assume the clip is them working on that specific skill in training.
Give coaching feedback as if you watched the clip and want them to get better for their next session.`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    messages: [
      { role: 'system', content: sys },
      { role: 'user',   content: userText }
    ]
  });

  const rawContent = resp.choices?.[0]?.message?.content || '{}';
  const jsonText   = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);

  let data = {};
  try {
    data = JSON.parse(jsonText);
  } catch {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) data = JSON.parse(m[0]);
  }

  return {
    summary: data.summary || 'Training analysis complete.',
    focus: Array.isArray(data.focus) ? data.focus.slice(0, 6) : [],
    drills: Array.isArray(data.drills) ? data.drills.slice(0, 6) : [],
    comps: Array.isArray(data.comps) ? data.comps.slice(0, 4) : [],
    raw: data
  };
}

app.post('/api/analyze', auth, async (req, res) => {
  try {
    const {
      height, heightFeet, heightInches,
      weight, foot, position,
      videoUrl, publicId,
      skill
    } = req.body || {};

    if (!videoUrl) {
      return res.status(400).json({ ok: false, error: 'Video URL required' });
    }

    // Update + enrich profile before analysis
    const profilePatch = {
      height,
      heightFeet,
      heightInches,
      weight,
      foot,
      position,
      skill
    };
    upsertProfile(req.userId, profilePatch);
    saveDB();

    const profile = db.profiles[req.userId] || {};
    const user    = findUserById(req.userId) || {};

    const result = await runTextAnalysisForTraining({
      profile,
      user,
      videoUrl,
      skill: skill || profile.skill || null
    });

    // Save into Library (single source of truth)
    if (!Array.isArray(db.analysesByUser[req.userId])) db.analysesByUser[req.userId] = [];
    const item = {
      id: uuidv4(),
      summary: result.summary,
      focus: result.focus,
      drills: result.drills,
      comps: result.comps,
      video_url: videoUrl,
      public_id: publicId || null,
      skill: skill || profile.skill || null,
      raw: result.raw,
      created_at: Date.now()
    };
    db.analysesByUser[req.userId].unshift(item);
    saveDB();

    // Return both the report and the analysisId so the frontend
    // can link straight to this specific report.
    res.json({
      ok: true,
      analysisId: item.id,
      summary: result.summary,
      focus: result.focus,
      drills: result.drills,
      comps: result.comps,
      videoUrl,
      publicId,
      skill: item.skill
    });
  } catch (e) {
    console.error('[BK] analyze', e);
    res.status(500).json({ ok: false, error: 'Analysis failed' });
  }
});
