export interface FitnessAiContext {
  gender?: string;
  weightKg?: number;
  heightCm?: number;
  age?: number;
  activityLevel?: number;
  goal?: string;
  dietPreference?: string;
  selectedGainer?: string;
  takingCreatine?: boolean;
  takingPreworkout?: boolean;
  targetCalories?: number;
  proteinGrams?: number;
  carbsGrams?: number;
  fatGrams?: number;
  waterLiters?: number;
}

export type AiLanguage = 'en' | 'ur';

export interface AiChatPayload {
  message: string;
  /** The app's language toggle. Absent from older clients, which got Roman
   *  Urdu, so that stays the default. */
  lang?: AiLanguage;
  context?: FitnessAiContext;
  apiKey?: string;
  /** The member's logged weigh-ins, already written as prompt lines. Built on
   *  the server from their own records, never taken from the request body. */
  progress?: string;
}

const systemPrompt = (lang: AiLanguage): string => `You are "GymPro AI", an elite Certified Sports Nutritionist, Strength Coach, and Master Bodybuilding Trainer.
You have deep expertise in bodybuilding nutrition, calorie/macro science (TDEE, BMR, deficit, surplus), Pakistani & Desi foods (Roti, Daal, Chawal, Chicken Tikka, Dahi, Anday, Desi Ghee), modern supplements (Kevin Levrone Anabolic Mass, ON Serious Mass, MuscleMeds Carnivor Beef Mass, Whey Isolate, Creatine Monohydrate, Pre-workouts like C4, Psychotic), and strength training routines (Compound lifts, 5-day hypertrophy splits, sets, reps, progressive overload).

Tone & Language:
- ${lang === 'en'
    ? 'Respond only in clear, friendly English. Desi food names may stay as they are (roti, daal, dahi) with a short English gloss.'
    : 'Respond only in clear, friendly Roman Urdu (Urdu written in English letters, never Urdu script). Common gym and English words may stay in English.'}
- Be highly encouraging, practical, and scientifically accurate.
- Always emphasize clean eating, avoiding dirty belly fat during bulking, proper hydration (at least 3.5 - 4.5 Liters), and smart supplement timing.
- Structure answers with bullet points, bold headings, and clear dosages/timings so it's easy for gym lifters to read on mobile.`;

export async function askFitnessAi(payload: AiChatPayload): Promise<string> {
  const { message, context, apiKey: userKey, progress, lang = 'ur' } = payload;
  const SYSTEM_PROMPT = systemPrompt(lang);
  const geminiKey = userKey || process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const contextStr = context ? `
Current Lifter Profile:
- Gender: ${context.gender ?? 'male'}
- Body Weight: ${context.weightKg ?? 70} kg
- Height: ${context.heightCm ?? 175} cm
- Age: ${context.age ?? 25} years
- Fitness Goal: ${context.goal ?? 'bulk_lean'}
- Dietary Preference: ${context.dietPreference ?? 'pakistani_desi'}
- Mass Gainer / Supplement: ${context.selectedGainer ?? 'anabolic_mass'}
- Creatine Monohydrate: ${context.takingCreatine ? 'Yes (5g daily)' : 'No'}
- Pre-Workout: ${context.takingPreworkout ? 'Yes' : 'No'}
- Calculated Daily Calories: ${context.targetCalories ?? 2500} kcal
- Required Daily Protein: ${context.proteinGrams ?? 140} grams
- Target Daily Water: ${context.waterLiters ?? 4.0} Liters
` : '';

  const progressStr = progress ? `
Logged Body Measurements (oldest to newest):
${progress}
Use this trend when judging whether the current plan is working.
` : '';

  const fullPrompt = `${SYSTEM_PROMPT}

${contextStr}
${progressStr}

User Question / Request:
"${message}"

Please provide a detailed, actionable, and structured recommendation for this lifter:`;

  // 1. Try Google Gemini API if key is present
  if (geminiKey) {
    const models = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'];
    for (const model of models) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: fullPrompt }] }],
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 1200,
              },
            }),
          }
        );

        if (response.ok) {
          const data = (await response.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) return text;
        } else {
          const errText = await response.text();
          console.warn(`Gemini (${model}) returned status ${response.status}:`, errText);
        }
      } catch (err) {
        console.warn(`Gemini (${model}) fetch failed:`, err);
      }
    }
  }

  // 2. Try OpenAI API if key is present
  if (openaiKey) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `${contextStr}\n\nQuestion: ${message}` },
          ],
          temperature: 0.7,
          max_tokens: 1200,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content;
        if (text) return text;
      }
    } catch (err) {
      console.warn('OpenAI fetch failed, falling back:', err);
    }
  }

  // 3. Built-in Smart Expert AI Engine (Zero-key fallback)
  return generateExpertFallbackResponse(message, lang, context);
}

function generateExpertFallbackResponse(
  message: string,
  lang: AiLanguage,
  context?: FitnessAiContext,
): string {
  const en = lang === 'en';
  const q = message.toLowerCase();
  const weight = context?.weightKg || 70;
  const calories = context?.targetCalories || 2400;
  const protein = context?.proteinGrams || 140;
  const gainer = context?.selectedGainer || 'anabolic_mass';
  const water = context?.waterLiters || 4.0;

  if (q.includes('plan') || q.includes('diet') || q.includes('full') || q.includes('chart') || q.includes('menu')) {
    if (en) return `### 🏋️‍♂️ AI Custom Diet & Nutrition Plan (${weight}kg Bodyweight)

**Daily Targets:**
- 🔥 **Total Calories:** ${calories} kcal
- 🥩 **Target Protein:** ${protein}g (${(protein / weight).toFixed(1)}g per kg bodyweight)
- 💧 **Water Intake:** ${water} Liters

---

### 🍽️ Meal-by-Meal Schedule:

1. **🌅 Breakfast (8:30 AM):**
   - 4 boiled eggs (1 whole egg + 3 egg whites).
   - 1 plain roti, or 1 cup oats cooked in 200ml milk.
   - 6 almonds + 1 cup green tea.
   - *Protein: ~28g | Calories: ~450 kcal*

2. **🥤 Mid-Morning Shake (11:30 AM):**
   - 1 scoop **${gainer.replace('_', ' ').toUpperCase()}** in 350ml water or skim milk.
   - *Protein: ~25g | Calories: ~400 kcal*

3. **☀️ Lunch (2:00 PM):**
   - 150g chicken breast (tikka style or a low-ghee curry) / 1 cup white chickpeas.
   - 1 cup boiled rice or 1-2 plain rotis.
   - 1 bowl fresh yogurt + cucumber and tomato salad.
   - *Protein: ~38g | Calories: ~550 kcal*

4. **⚡ Pre-Workout Fuel (5:00 PM - 30 min before the gym):**
   - 1 banana + 1 cup black coffee (no sugar) or 1 scoop C4/Psychotic.
   - *Energy: quick glycogen refill & focus.*

5. **🥤 Post-Workout Recovery (6:45 PM - Anabolic Window):**
   - 1 scoop Mass Gainer / Whey + **5g Creatine Monohydrate** in cold water.
   - *Protein: ~25g | Creatine pulls water straight into muscle cells.*

6. **🌙 Dinner (9:00 PM):**
   - 120g fish or chicken kebab / moong daal.
   - 1 roti + a few drops of olive oil on the salad.
   - *Protein: ~30g | Calories: ~450 kcal*

---

💡 **AI Coach Pro Tip:** While on creatine and a mass gainer, drink at least **${water} liters of water** every day so you don't bloat and digestion stays smooth!`;
    return `### 🏋️‍♂️ AI Custom Diet & Nutrition Plan (${weight}kg Bodyweight)

**Daily Targets:**
- 🔥 **Total Calories:** ${calories} kcal
- 🥩 **Target Protein:** ${protein}g (${(protein / weight).toFixed(1)}g per kg bodyweight)
- 💧 **Water Intake:** ${water} Liters

---

### 🍽️ Meal-by-Meal Schedule:

1. **🌅 Subah Nashta (Breakfast - 8:30 AM):**
   - 4 Ublay anday (1 poora anda + 3 andon ki safedi).
   - 1 Saadi roti ya 1 cup oats (daliya) 200ml doodh me paka kar.
   - 6 Badam (almonds) + 1 cup sabz chai (green tea).
   - *Protein: ~28g | Calories: ~450 kcal*

2. **🥤 Mid-Morning Shake (11:30 AM):**
   - 1 Scoop **${gainer.replace('_', ' ').toUpperCase()}** 350ml paani ya skim doodh me.
   - *Protein: ~25g | Calories: ~400 kcal*

3. **☀️ Dopeher Ka Khana (Lunch - 2:00 PM):**
   - 150g Chicken breast (tikka style ya kam ghee wala salan) / 1 cup Safaid Chana.
   - 1 Cup ublay chawal ya 1-2 saadi roti.
   - 1 Katori taaza dahi (curd) + fresh cucumber aur tamatar salaad.
   - *Protein: ~38g | Calories: ~550 kcal*

4. **⚡ Pre-Workout Fuel (5:00 PM - Gym se 30 min pehle):**
   - 1 Kela (Banana) + 1 cup Black Coffee (bina cheeni) ya 1 scoop C4/Psychotic.
   - *Energy: Quick glycogen refill & focus.*

5. **🥤 Post-Workout Recovery (6:45 PM - Anabolic Window):**
   - 1 Scoop Mass Gainer / Whey + **5g Creatine Monohydrate** thanday paani me.
   - *Protein: ~25g | Creatine pulls water straight into muscle cells.*

6. **🌙 Raat Ka Khana (Dinner - 9:00 PM):**
   - 120g Machli (Fish) ya Chicken kabab / Daal moong.
   - 1 Roti + zaitoon ke tail ke chann qatre salaad par.
   - *Protein: ~30g | Calories: ~450 kcal*

---

💡 **AI Coach Pro Tip:** Creatine aur Mass gainer ke dauran rozana kam az kam **${water} Liter paani** zaroor piyein taake pait na phoolay aur digestion perfect rahay!`;
  }

  if (q.includes('creatine') || q.includes('createne')) {
    if (en) return `### ⚡ Creatine Monohydrate Protocol

1. **Dosage:** **5 grams** a day (1 teaspoon). A loading phase (20g) is not needed at all.
2. **Best Timing:** Take it right after your workout with your post-workout shake or mass gainer. With carbs, creatine absorbs about 60% faster.
3. **Rest Days:** Mix it in water and drink it after breakfast.
4. **Water Rule:** Creatine draws water into the muscles, so **4.0 liters of water** a day is a must, or you may get cramps or headaches.`;
    return `### ⚡ Creatine Monohydrate Protocol

1. **Dosage:** Rozana **5 gram** (1 tea spoon). Loading phase (20g) ki bilkul zaroorat nahi ha.
2. **Best Timing:** Workout ke foran baad apne post-workout shake ya Mass Gainer ke sath len. Carbs ke sath Creatine 60% zyada tez absorb hoti ha.
3. **Rest Days:** Rest day par subah nashtay ke baad paani me ghol kar pee lein.
4. **Water Rule:** Creatine muscles me hydration lata ha, isliye rozana **4.0 Liters paani** laazmi ha warna cramps ya sar dard ho sakta ha.`;
  }

  if (q.includes('preworkout') || q.includes('pre workout') || q.includes('c4') || q.includes('caffeine')) {
    if (en) return `### ⚡ Pre-Workout (C4 / Psychotic) Guide

1. **Timing:** Take 1 scoop in 200ml cold water **20 to 25 minutes before** you start training.
2. **Food:** Don't take it straight after a meal; leave at least 1.5 hours for full blood flow and pump.
3. **Precaution:** Training after 8 PM? Take half a scoop so the caffeine doesn't ruin your sleep.
4. **Tolerance:** Train 1-2 days a week without pre-workout so your body doesn't get used to caffeine.`;
    return `### ⚡ Pre-Workout (C4 / Psychotic) Guide

1. **Timing:** Gym start karne se **20 se 25 minute pehle** 200ml thanday paani me 1 scoop len.
2. **Khana:** Khana khane ke foran baad na len; kam az kam 1.5 ghantay ka fasla rakhein taake full blood flow aur pump miley.
3. **Precaution:** Raat ko 8 baje ke baad workout ho to half scoop len taake caffeine ki wajah se neend kharab na ho.
4. **Tolerance:** Hafte me 1-2 din bina pre-workout training karein taake body caffeine ki aadi na ho.`;
  }

  if (q.includes('anabolic') || q.includes('serious mass') || q.includes('carnivor') || q.includes('gainer') || q.includes('pet') || q.includes('belly')) {
    if (en) return `### 🥩 Mass Gainer (Anabolic Mass / Serious Mass / Carnivor) Guide

1. **How to Avoid Belly Fat:**
   - A mass gainer has 1000+ calories. Never start with 2 full scoops!
   - Take a **half serving (1 scoop = ~500-600 kcal)** for the first 2-3 weeks.
   - Keep the rest of your home food clean (dry roti, boiled rice, no fried parathas).
2. **Carnivor Beef Mass vs Anabolic Mass:**
   - **Carnivor:** 100% beef isolate (0% lactose). If milk gives you gas or an upset stomach, Carnivor is the best choice.
   - **Anabolic Mass:** Kevin Levrone's high-calorie gainer with DAA and test boosters, excellent for hardgainers.
3. **Workout Intensity:** Pair the gainer with heavy compound lifts (bench, squats, deadlifts) so the calories become muscle instead of fat!`;
    return `### 🥩 Mass Gainer (Anabolic Mass / Serious Mass / Carnivor) Guide

1. **Pet (Belly Fat) Se Bachne Ka Tareeqa:**
   - Mass Gainer me 1000+ calories hoti hain. Kabhi bhi shuru me 2 full scoops na lein!
   - Pehle 2-3 hafte **Half Serving (1 Scoop = ~500-600 kcal)** lein.
   - Ghar ka baqi khana bilkul clean rakhein (sukhi roti, ublay chawal, no fried parathas).
2. **Carnivor Beef Mass vs Anabolic Mass:**
   - **Carnivor:** 100% Beef Isolate ha (0% Lactose). Agar doodh se gas ya pait kharab hota ho to Carnivor best ha.
   - **Anabolic Mass:** Kevin Levrone ka high-calorie gainer ha jisme DAA aur test boosters hotay hain, hardgainers ke liye behtareen ha.
3. **Workout Intensity:** Gainer ke sath gym me heavy compound exercises (Bench, Squats, Deadlifts) karein taake calories charbi ke bajaye muscle me convert hon!`;
  }

  if (en) return `### 💡 GymPro AI Coach Recommendation (${weight}kg Bodyweight)

Based on your question:
- **Daily Target:** ${calories} calories and ${protein}g protein.
- **Goal Strategy:** Control your portions for ${context?.goal?.replace('_', ' ').toUpperCase() || 'FITNESS'}.
- **Hydration:** Drinking **${water} liters of water** a day is a must.
- **Workout:** Train 5 days a week, 5 exercises a day, 3-4 sets of 8-10 heavy reps each.

*You can ask something more specific (e.g. Mass Gainer, Creatine, Pre-workout, or a Full Diet Plan)!*`;
  return `### 💡 GymPro AI Coach Recommendation (${weight}kg Bodyweight)

Aap ke sawal ke mutabiq:
- **Daily Target:** ${calories} Calories aur ${protein}g Protein ha.
- **Goal Strategy:** ${context?.goal?.replace('_', ' ').toUpperCase() || 'FITNESS'} ke mutabiq apne portions control karein.
- **Hydration:** Rozana **${water} Liters paani** peena laazmi ha.
- **Workout:** Hafte me 5 din 5-5 games (exercises) lagayein, har exercise ke 3-4 sets aur 8-10 heavy reps karein.

*Aap mazeed koi specific sawal (e.g. Mass Gainer, Creatine, Pre-workout, ya Full Diet Plan) pooch saktay hain!*`;
}
