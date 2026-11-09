/**
 * verbs.js: the words the working line uses while Claude thinks (Arthur,
 * 2026-10-10: "use claude's random thinking words when a session is
 * thinking"). The same playful gerunds Claude Code's spinner shows
 * ("Cogitating", "Noodling", "Percolating"...), one picked at random each
 * time a turn starts or Claude starts a new stretch of thinking. Writing and
 * running a tool keep their plain words, so the line still says what is
 * happening.
 */

export const THINKING_VERBS = Object.freeze([
  'Accomplishing', 'Actioning', 'Actualizing', 'Baking', 'Beaming', 'Befuddling', 'Billowing', 'Blanching',
  'Bloviating', 'Boogieing', 'Booping', 'Bootstrapping', 'Brewing', 'Burrowing', 'Calculating', 'Canoodling',
  'Caramelizing', 'Cascading', 'Catapulting', 'Cerebrating', 'Channeling', 'Choreographing', 'Churning',
  'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting',
  'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Crystallizing',
  'Cultivating', 'Deciphering', 'Deliberating', 'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing',
  'Doodling', 'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing', 'Enchanting', 'Envisioning',
  'Evaporating', 'Fermenting', 'Fiddle-faddling', 'Finagling', 'Flambéing', 'Flibbertigibbeting', 'Flowing',
  'Flummoxing', 'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting', 'Gallivanting', 'Galloping',
  'Garnishing', 'Generating', 'Germinating', 'Grooving', 'Gusting', 'Harmonizing', 'Hashing', 'Hatching',
  'Herding', 'Honking', 'Hullaballooing', 'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating',
  'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning', 'Kneading', 'Leavening', 'Levitating',
  'Lollygagging', 'Manifesting', 'Marinating', 'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking',
  'Moseying', 'Mulling', 'Mustering', 'Musing', 'Nebulizing', 'Nesting', 'Noodling', 'Nucleating', 'Orbiting',
  'Orchestrating', 'Osmosing', 'Perambulating', 'Percolating', 'Perusing', 'Philosophising',
  'Photosynthesizing', 'Pollinating', 'Pondering', 'Pontificating', 'Pouncing', 'Precipitating',
  'Prestidigitating', 'Processing', 'Proofing', 'Propagating', 'Puttering', 'Puzzling', 'Quantumizing',
  'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating', 'Sautéing',
  'Scampering', 'Schlepping', 'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying', 'Simmering',
  'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning', 'Sprouting',
  'Stewing', 'Sublimating', 'Swirling', 'Swooping', 'Symbioting', 'Synthesizing', 'Tempering', 'Thinking',
  'Thundering', 'Tinkering', 'Tomfoolering', 'Topsy-turvying', 'Transfiguring', 'Transmuting', 'Twisting',
  'Undulating', 'Unfurling', 'Unravelling', 'Vibing', 'Waddling', 'Wandering', 'Warping',
  'Whatchamacalliting', 'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling', 'Zesting',
  'Zigzagging',
]);

/** A random thinking word, never the same as `not` (so a new stretch of thinking reads as new). */
export function pickVerb(not = '') {
  let v = not;
  for (let i = 0; i < 4 && v === not; i++) v = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
  return v;
}
