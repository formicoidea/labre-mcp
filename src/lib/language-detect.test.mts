// Tests for language detection
//
// Run: node src/lib/language-detect.test.mjs

import { detectLanguage, extractUserText, detectLanguageFromArgs } from './language-detect.mjs';

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

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
