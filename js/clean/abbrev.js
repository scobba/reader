/* Turning written medical prose into something worth listening to.
 *
 * These rules run on the *speech* string only. The text on screen keeps its
 * original wording, so what you see still matches the paper you are citing —
 * only what you hear is expanded.
 *
 * The bar for including a rule: a synthesiser gets it audibly wrong without
 * help. "mg/dL" is read as "mg slash dL"; "95% CI" as "ninety-five percent
 * see eye". Acronyms a synthesiser already spells out acceptably (HIV, DNA,
 * MRI) are left alone, and genuinely ambiguous ones (PE, ED, MI, AF, and a
 * bare HR or OR) are left alone too, because guessing wrong changes the
 * clinical meaning of the sentence.
 */

const µ = '[µμ]';

/* ────────────────────────────────────── compound units and rates ────── */
const UNITS = [
  [/\bmg\s*\/\s*d[lL]\b/g,            'milligrams per deciliter'],
  [/\bg\s*\/\s*d[lL]\b/g,             'grams per deciliter'],
  [/\bmg\s*\/\s*m[lL]\b/g,            'milligrams per milliliter'],
  [/\bng\s*\/\s*m[lL]\b/g,            'nanograms per milliliter'],
  [/\bpg\s*\/\s*m[lL]\b/g,            'picograms per milliliter'],
  [new RegExp(`\\b${µ}g\\s*/\\s*m[lL]\\b`, 'g'), 'micrograms per milliliter'],
  [/\bmcg\s*\/\s*m[lL]\b/g,           'micrograms per milliliter'],
  [/\bmmol\s*\/\s*[lL]\b/g,           'millimoles per liter'],
  [new RegExp(`\\b${µ}mol\\s*/\\s*[lL]\\b`, 'g'), 'micromoles per liter'],
  [/\bnmol\s*\/\s*[lL]\b/g,           'nanomoles per liter'],
  [/\bmEq\s*\/\s*[lL]\b/gi,           'milliequivalents per liter'],
  [/\bI?U\s*\/\s*[lL]\b/g,            'units per liter'],
  [/\bmg\s*\/\s*kg\b/g,               'milligrams per kilogram'],
  [/\bmg\s*\/\s*m2\b/g,               'milligrams per square meter'],
  [/\bkg\s*\/\s*m\s*2\b/g,            'kilograms per square meter'],
  [/\bm[lL]\s*\/\s*min\b/g,           'milliliters per minute'],
  [/\b[lL]\s*\/\s*min\b/g,            'liters per minute'],
  [/\bbeats\s*\/\s*min\b/gi,          'beats per minute'],
  [/\bmmHg\b/g,                       'millimeters of mercury'],
  [/\bcmH2?O\b/gi,                    'centimeters of water'],
  [/\b°\s*C\b/g,                      ' degrees Celsius'],
  [/\b°\s*F\b/g,                      ' degrees Fahrenheit'],
  [/\bH2O\b/g,                        'water'],
  [/\bCO2\b/g,                        'carbon dioxide'],
  [/\bO2\b/g,                         'oxygen'],
  [/\bNaCl\b/g,                       'sodium chloride'],

  // Bare units, only directly after a number so ordinary words are untouched.
  [/(\d)\s*kg\b/g,                    '$1 kilograms'],
  [/(\d)\s*mg\b/g,                    '$1 milligrams'],
  [new RegExp(`(\\d)\\s*${µ}g\\b`, 'g'), '$1 micrograms'],
  [/(\d)\s*mcg\b/g,                   '$1 micrograms'],
  [/(\d)\s*m[lL]\b/g,                 '$1 milliliters'],
  [/(\d)\s*d[lL]\b/g,                 '$1 deciliters'],
  [/(\d)\s*mm\b/g,                    '$1 millimeters'],
  [/(\d)\s*cm\b/g,                    '$1 centimeters'],
  [new RegExp(`(\\d)\\s*${µ}m\\b`, 'g'), '$1 micrometers'],
  [/(\d)\s*nm\b/g,                    '$1 nanometers'],
  [/(\d)\s*kDa\b/g,                   '$1 kilodaltons'],
  [/(\d)\s*IU\b/g,                    '$1 international units'],
  [/(\d)\s*hr?s?\b/g,                 '$1 hours'],
  [/(\d)\s*min\b/g,                   '$1 minutes'],
  [/(\d)\s*sec\b/g,                   '$1 seconds'],
  [/(\d)\s*wks?\b/g,                  '$1 weeks'],
  [/(\d)\s*mos?\b/g,                  '$1 months'],
  [/(\d)\s*yrs?\b/g,                  '$1 years'],
];

/* ─────────────────────────────────────────── statistics reporting ───── */
const STATS = [
  [/\b(\d{2,3})\s*%\s*(?:confidence\s+interval|CI)\b/gi, '$1 percent confidence interval'],
  [/\bCIs\b/g,                        'confidence intervals'],
  [/\bCI\b(?=\s*[:=,]|\s*\d|\s*\()/g, 'confidence interval'],
  [/\ba?OR\s*=/g,                     'odds ratio ='],
  [/\ba?HR\s*=/g,                     'hazard ratio ='],
  [/\ba?RR\s*=/g,                     'relative risk ='],
  [/\bIRR\s*=/g,                      'incidence rate ratio ='],
  [/\bSMD\b/g,                        'standardised mean difference'],
  [/\bSD\b/g,                         'standard deviation'],
  [/\bSEM\b/g,                        'standard error of the mean'],
  [/\bIQR\b/g,                        'interquartile range'],
  [/\bNNT\b/g,                        'number needed to treat'],
  [/\bNNH\b/g,                        'number needed to harm'],
  [/\bITT\b/g,                        'intention to treat'],
  [/\bAUC\b/g,                        'area under the curve'],
  [/\bROC\b/g,                        'receiver operating characteristic'],
  [/\bdf\s*=/g,                       'degrees of freedom ='],

  [/\bp\s*<\s*/gi,                    'p less than '],
  [/\bp\s*>\s*/gi,                    'p greater than '],
  [/\bp\s*≤\s*/gi,                    'p less than or equal to '],
  [/\bp\s*≥\s*/gi,                    'p greater than or equal to '],
  [/\bp\s*=\s*/gi,                    'p equals '],
  [/\bn\s*=\s*/g,                     'n equals '],
];

/* ──────────────────────────────────────────────────────── symbols ───── */
const SYMBOLS = [
  // Ranges. Digit-to-digit only, so "COVID-19" and "5-year" are untouched.
  [/(\d)\s*[–—]\s*(?=\d)/g,           '$1 to '],
  [/(\d)\s*-\s*(?=\d)/g,              '$1 to '],

  [/±/g,                              ' plus or minus '],
  [/≥/g,                              ' greater than or equal to '],
  [/≤/g,                              ' less than or equal to '],
  [/≈|≃|~(?=\s*\d)/g,                 ' approximately '],
  [/≠/g,                              ' not equal to '],
  // "112×112" and "3×3" are dimensions; "8× deeper" is a multiplier. The
  // difference is whether a number follows.
  [/(\d)\s*×\s*(?=\d)/g,              '$1 by '],
  [/(\d)\s*×/g,                       '$1 times '],
  [/×/g,                              ' by '],
  [/(\d)\s*%/g,                       '$1 percent'],
  [/\s<\s/g,                          ' less than '],
  [/\s>\s/g,                          ' greater than '],
  [/\band\s*\/\s*or\b/gi,             'and or'],
  // A run of slashed alternatives ("low/mid/high") reads as a list; a single
  // slash reads as "or". Real units are already gone by this point.
  [/\b(\w+)\/(\w+)\/(\w+)\b/g,        '$1 $2 $3'],
  [/\b(\w+)\/(\w+)\b/g,               '$1 or $2'],
  [/\s*\/\s*/g,                       ' or '],
  [/\bα/g, 'alpha'], [/\bβ/g, 'beta'], [/\bγ/g, 'gamma'],
  [/\bΔ|∆/g, 'change in '], [/\bκ/g, 'kappa'], [/\bχ2|χ²/g, 'chi squared'],
  [/\bμ(?![a-z])/g, 'mu'],
];

/* ───────────────────────────────────────── everyday abbreviations ───── */
const GENERAL = [
  [/\bet\s+al\.?/gi,                  'and colleagues'],
  [/\be\.\s?g\.,?/gi,                 'for example,'],
  [/\bi\.\s?e\.,?/gi,                 'that is,'],
  [/\bvs\.?\b/gi,                     'versus'],
  [/\bcf\.\s?/gi,                     'compare '],
  // The trailing \b matters: without it "approx" matches inside
  // "approximately" and yields "approximately imately".
  [/\betc\b\.?/gi,                    'and so on'],
  [/\bviz\b\.?\s?/gi,                 'namely '],
  [/\bca\.\s*(?=\d)/gi,               'approximately '],
  [/\bapprox\b\.?\s?/gi,              'approximately '],
  [/\bFigs?\.\s*(?=\d)/g,             'Figure '],
  [/\bTabs?\.\s*(?=\d)/g,             'Table '],
  [/\bEqs?\.\s*(?=\d)/g,              'Equation '],
  [/\bRefs?\.\s*(?=\d)/g,             'Reference '],
  [/\bSuppl(ementary)?\.\s?/gi,       'Supplementary '],
  [/\bNo\.\s*(?=\d)/g,                'number '],
  [/\bpp?\.\s*(?=\d)/g,               'page '],
  [/\bSect(ion)?\.\s*(?=\d)/gi,       'Section '],
  [/\bDr\.\s?/g, 'Doctor '], [/\bProf\.\s?/g, 'Professor '],
  [/\bU\.?S\.?A?\.(?=\s|$)/g, 'United States'],
  [/\bU\.?K\.(?=\s|$)/g, 'United Kingdom'],
];

/* ──────────────────────────────────── medical terms worth expanding ─── */
const MEDICAL = [
  [/\bRCTs\b/g, 'randomised controlled trials'],
  [/\bRCT\b/g,  'randomised controlled trial'],
  [/\bNSAIDs\b/g, 'nonsteroidal anti-inflammatory drugs'],
  [/\bNSAID\b/g,  'nonsteroidal anti-inflammatory drug'],
  [/\bHbA1c\b/gi, 'hemoglobin A one C'],
  [/\beGFR\b/g,   'estimated G F R'],
  [/\bBMI\b/g,    'body mass index'],
  [/\bCABG\b/g,   'coronary artery bypass grafting'],
  [/\bCOPD\b/g,   'C O P D'],
  [/\bCHF\b/g,    'congestive heart failure'],
  [/\bCKD\b/g,    'chronic kidney disease'],
  [/\bCAD\b/g,    'coronary artery disease'],
  [/\bDVT\b/g,    'deep vein thrombosis'],
  [/\bSTEMI\b/g,  'ST elevation myocardial infarction'],
  [/\bNSTEMI\b/g, 'non ST elevation myocardial infarction'],
  [/\bACS\b/g,    'acute coronary syndrome'],
  [/\bICU\b/g,    'intensive care unit'],
  [/\bLOS\b/g,    'length of stay'],
  [/\bOS\b(?=\s*(?:was|rate|at|of|\())/g, 'overall survival'],
  [/\bPFS\b/g,    'progression free survival'],
  [/\bQoL\b/gi,   'quality of life'],
  [/\bLDL\b/g,    'L D L'],
  [/\bHDL\b/g,    'H D L'],
  [/\bCRP\b/g,    'C reactive protein'],
  [/\bESR\b/g,    'erythrocyte sedimentation rate'],
  [/\bTNF\b/g,    'tumour necrosis factor'],
  [/\bIL-(\d+)\b/g, 'interleukin $1'],
  [/\bBID\b/g, 'twice daily'], [/\bTID\b/g, 'three times daily'],
  [/\bQID\b/g, 'four times daily'], [/\bQD\b/g, 'once daily'],
  [/\bPRN\b/g, 'as needed'], [/\bPO\b(?=\s)/g, 'by mouth'],
  [/\bIV\b(?=\s+(?:infusion|administration|dose|fluids?|access|therapy))/g, 'intravenous'],
];

/* ────────────────────────────────────────────── roman numerals ──────── */
const ROMAN = { i: 'one', ii: 'two', iii: 'three', iv: 'four', v: 'five',
                vi: 'six', vii: 'seven', viii: 'eight', ix: 'nine', x: 'ten' };

function romanise(s) {
  return s.replace(
    /\b(phase|grade|class|stage|type|factor|trial)\s+(I{1,3}|IV|VI{0,3}|IX|X|V)\b/g,
    (m, word, num) => `${word} ${ROMAN[num.toLowerCase()] || num}`);
}

/* ═════════════════════════════════════════════════════════ entry ═════ */

const ALL = [...UNITS, ...STATS, ...MEDICAL, ...GENERAL, ...SYMBOLS];

/**
 * Rewrite a sentence for the synthesiser.
 * @param {string} s
 * @param {boolean} full  false = only the always-safe fixes (symbols, ranges)
 */
export function expandForSpeech(s, full = true) {
  if (!s) return '';
  let t = s;

  if (full) {
    for (const [re, rep] of ALL) t = t.replace(re, rep);
    t = romanise(t);
  } else {
    for (const [re, rep] of SYMBOLS) t = t.replace(re, rep);
  }

  return t
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;:.!?])/g, '$1')
    .trim();
}

/** A block of only capitals and digits ("AUC ROC PFS OS") is a table header
 *  rather than prose; reading it aloud is never useful. */
export function isAcronymSoup(s) {
  const words = s.split(/\s+/).filter(w => /\w/.test(w));
  if (words.length < 3) return false;
  const shouty = words.filter(w => /^[A-Z0-9][A-Z0-9.%-]{1,6}$/.test(w));
  return shouty.length / words.length > 0.7;
}
