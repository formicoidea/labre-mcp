// Tests for language detection and localized progress messages
//
// Run: node src/lib/language-detect.test.mjs

import { detectLanguage, extractUserText, detectLanguageFromArgs } from './language-detect.mjs';
import { createMessageResolver, createMessageResolverFromArgs, MESSAGE_CATALOG } from './progress-messages.mjs';

let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${description}`);
  } else {
    failed++;
    console.log(`  ✗ ${description}`);
  }
}

function assertEqual(actual, expected, description) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${description}`);
  } else {
    failed++;
    console.log(`  ✗ ${description}: expected "${expected}", got "${actual}"`);
  }
}

// ─── Language Detection Tests ──────────────────────────────────────────────

console.log('\n=== Language Detection ===\n');

console.log('--- English ---');
assertEqual(detectLanguage('Enterprise resource planning for large corporations'), 'en', 'English business text → en');
assertEqual(detectLanguage('ERP'), 'en', 'Short English acronym → en (fallback)');
assertEqual(detectLanguage('A component used in web applications'), 'en', 'Generic English → en');

console.log('\n--- French ---');
assertEqual(detectLanguage('Logiciel de gestion pour les entreprises'), 'fr', 'French business text → fr');
assertEqual(detectLanguage('Un composant utilisé dans le contexte de la vente en ligne'), 'fr', 'French with articles → fr');
assertEqual(detectLanguage("L'électricité pour les foyers français"), 'fr', 'French with accents and apostrophe → fr');
assertEqual(detectLanguage('Carte de valeur pour une entreprise de thé'), 'fr', 'French Wardley context → fr');
assertEqual(detectLanguage('Évaluer l\'évolution de ce composant dans le marché'), 'fr', 'French evaluation request → fr');

console.log('\n--- Spanish ---');
assertEqual(detectLanguage('Software de gestión para las empresas'), 'es', 'Spanish business text → es');
assertEqual(detectLanguage('Un componente utilizado en el comercio electrónico'), 'es', 'Spanish with articles → es');
assertEqual(detectLanguage('¿Cuál es la evolución del componente?'), 'es', 'Spanish question → es');

console.log('\n--- German ---');
assertEqual(detectLanguage('Software für die Verwaltung der Unternehmen'), 'de', 'German business text → de');
assertEqual(detectLanguage('Eine Komponente für das Unternehmen'), 'de', 'German with articles → de');
assertEqual(detectLanguage('Wie hoch ist die Reife dieser Komponente?'), 'de', 'German question → de');

console.log('\n--- Portuguese ---');
assertEqual(detectLanguage('Software de gestão para as empresas do Brasil'), 'pt', 'Portuguese business text → pt');
assertEqual(detectLanguage('Um componente utilizado na cadeia de valor'), 'pt', 'Portuguese value chain → pt');

console.log('\n--- Italian ---');
assertEqual(detectLanguage('Software di gestione per le aziende della catena del valore'), 'it', 'Italian business text → it');

console.log('\n--- Japanese ---');
assertEqual(detectLanguage('企業のためのソフトウェア管理'), 'ja', 'Japanese text → ja');
assertEqual(detectLanguage('コンポーネントの進化を評価する'), 'ja', 'Japanese katakana → ja');

console.log('\n--- Chinese ---');
assertEqual(detectLanguage('企业资源规划软件'), 'zh', 'Chinese text → zh');

console.log('\n--- Korean ---');
assertEqual(detectLanguage('기업 자원 관리 소프트웨어'), 'ko', 'Korean text → ko');

console.log('\n--- Edge cases ---');
assertEqual(detectLanguage(''), 'en', 'Empty string → en');
assertEqual(detectLanguage(null), 'en', 'null → en');
assertEqual(detectLanguage(undefined), 'en', 'undefined → en');
assertEqual(detectLanguage(42), 'en', 'Number → en');
assertEqual(detectLanguage('   '), 'en', 'Whitespace → en');
assertEqual(detectLanguage('ERP CRM SaaS'), 'en', 'Acronyms only → en (fallback)');

// ─── extractUserText Tests ─────────────────────────────────────────────────

console.log('\n=== extractUserText ===\n');

assertEqual(
  extractUserText({ name: 'ERP', context: 'Enterprise planning', description: 'Large corp' }),
  'Enterprise planning Large corp ERP',
  'Extracts name + context + description'
);

assertEqual(
  extractUserText({ name: 'ERP' }),
  'ERP',
  'Extracts name only when others absent'
);

assertEqual(extractUserText(null), '', 'null args → empty');
assertEqual(extractUserText({}), '', 'empty args → empty');

// ─── detectLanguageFromArgs Tests ──────────────────────────────────────────

console.log('\n=== detectLanguageFromArgs ===\n');

assertEqual(
  detectLanguageFromArgs({ name: 'ERP', context: 'Logiciel de gestion pour les entreprises' }),
  'fr',
  'French context args → fr'
);

assertEqual(
  detectLanguageFromArgs({ name: 'ERP', context: 'Enterprise resource planning' }),
  'en',
  'English context args → en'
);

assertEqual(
  detectLanguageFromArgs({ name: 'Electricidad', description: 'Suministro eléctrico para las empresas españolas' }),
  'es',
  'Spanish description args → es'
);

// ─── Message Resolver Tests ────────────────────────────────────────────────

console.log('\n=== Message Resolver ===\n');

console.log('--- English messages ---');
const enMsg = createMessageResolver('en');
assertEqual(
  enMsg('tool.start', { tool: 'estimateEvolution', component: 'ERP' }),
  'Starting estimateEvolution for component "ERP"…',
  'English tool.start message'
);
assertEqual(
  enMsg('tool.end', { tool: 'estimateEvolution', component: 'ERP', duration: 1234 }),
  'estimateEvolution completed for "ERP" (1234ms)',
  'English tool.end message'
);

console.log('\n--- French messages ---');
const frMsg = createMessageResolver('fr');
assertEqual(
  frMsg('tool.start', { tool: 'estimateEvolution', component: 'ERP' }),
  'Démarrage de estimateEvolution pour le composant « ERP »…',
  'French tool.start message'
);
assertEqual(
  frMsg('step.classification', { component: 'ERP', space: 'economic' }),
  'Classification de « ERP » → economic',
  'French classification message'
);
assertEqual(
  frMsg('error.llm.timeout', { duration: 30000, model: 'kimi-k2.5' }),
  'Appel LLM expiré après 30000 ms (modèle : kimi-k2.5)',
  'French timeout error message'
);

console.log('\n--- Spanish messages ---');
const esMsg = createMessageResolver('es');
assertEqual(
  esMsg('tool.start', { tool: 'estimateEvolution', component: 'ERP' }),
  'Iniciando estimateEvolution para el componente "ERP"…',
  'Spanish tool.start message'
);

console.log('\n--- German messages ---');
const deMsg = createMessageResolver('de');
assertEqual(
  deMsg('tool.start', { tool: 'estimateEvolution', component: 'ERP' }),
  'Starte estimateEvolution für Komponente „ERP"…',
  'German tool.start message'
);

console.log('\n--- Japanese messages ---');
const jaMsg = createMessageResolver('ja');
assertEqual(
  jaMsg('tool.start', { tool: 'estimateEvolution', component: 'ERP' }),
  'estimateEvolution を開始: コンポーネント「ERP」…',
  'Japanese tool.start message'
);

console.log('\n--- Chinese messages ---');
const zhMsg = createMessageResolver('zh');
assertEqual(
  zhMsg('step.strategy', { strategy: 'write:capacity:s-curve', component: 'ERP' }),
  '正在运行策略「s-curve」:「ERP」…',
  'Chinese strategy message'
);

console.log('\n--- Korean messages ---');
const koMsg = createMessageResolver('ko');
assertEqual(
  koMsg('error.llm.api', { status: 500, message: 'Internal Server Error' }),
  'LLM API 오류 (500): Internal Server Error',
  'Korean API error message'
);

// ─── Fallback Tests ────────────────────────────────────────────────────────

console.log('\n=== Fallback Behavior ===\n');

const unknownMsg = createMessageResolver('xx');
assertEqual(
  unknownMsg('tool.start', { tool: 'estimateEvolution', component: 'ERP' }),
  'Starting estimateEvolution for component "ERP"…',
  'Unknown language falls back to English'
);

assertEqual(
  enMsg('nonexistent.message.id', { param: 'value' }),
  'nonexistent.message.id',
  'Unknown message ID returns the ID itself'
);

// ─── createMessageResolverFromArgs Tests ───────────────────────────────────

console.log('\n=== createMessageResolverFromArgs ===\n');

const { msg: frAutoMsg, lang: frAutoLang } = createMessageResolverFromArgs({
  name: 'ERP',
  context: 'Logiciel de gestion pour les entreprises françaises',
});
assertEqual(frAutoLang, 'fr', 'Auto-detected French from args');
assertEqual(
  frAutoMsg('tool.start', { tool: 'estimateEvolution', component: 'ERP' }),
  'Démarrage de estimateEvolution pour le composant « ERP »…',
  'Auto French resolver produces French message'
);

const { msg: enAutoMsg, lang: enAutoLang } = createMessageResolverFromArgs({
  name: 'ERP',
  context: 'Enterprise resource planning software',
});
assertEqual(enAutoLang, 'en', 'Auto-detected English from args');
assertEqual(
  enAutoMsg('tool.start', { tool: 'estimateEvolution', component: 'ERP' }),
  'Starting estimateEvolution for component "ERP"…',
  'Auto English resolver produces English message'
);

// ─── Catalog Completeness Check ────────────────────────────────────────────

console.log('\n=== Catalog Completeness ===\n');

const REQUIRED_LANGUAGES = ['en', 'fr', 'es', 'de', 'pt', 'it', 'nl', 'ja', 'zh', 'ko'];
let catalogComplete = true;

for (const [msgId, translations] of Object.entries(MESSAGE_CATALOG)) {
  for (const lang of REQUIRED_LANGUAGES) {
    if (!translations[lang]) {
      console.log(`  ✗ Missing translation: ${msgId} → ${lang}`);
      catalogComplete = false;
      failed++;
    }
  }
}

if (catalogComplete) {
  passed++;
  console.log(`  ✓ All ${Object.keys(MESSAGE_CATALOG).length} messages have all ${REQUIRED_LANGUAGES.length} translations`);
}

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
