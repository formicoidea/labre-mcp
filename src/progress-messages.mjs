// Localized progress messages for MCP log notifications
//
// Provides a message catalog with translations for all progress notifications
// emitted during tool execution. Messages are keyed by a message ID and
// support parameter interpolation via {{param}} placeholders.
//
// Supported languages: en, fr, es, de, pt, it, nl, ja, zh, ko
// Fallback: 'en' for any unsupported language
//
// Usage:
//   import { createMessageResolver } from './progress-messages.mjs';
//   const msg = createMessageResolver('fr');
//   msg('tool.start', { tool: 'estimateEvolution', component: 'ERP' })
//   // → "Démarrage de estimateEvolution pour le composant « ERP »…"

import { detectLanguageFromArgs } from './language-detect.mjs';

// ─── Message Catalog ───────────────────────────────────────────────────────
// Each key is a message ID used in progress notifications.
// Values are objects mapping language code → template string.
// Templates use {{param}} for interpolation.

const MESSAGE_CATALOG = {
  // ── Tool lifecycle (info level) ──────────────────────────────────────
  'tool.start': {
    en: 'Starting {{tool}} for component "{{component}}"…',
    fr: 'Démarrage de {{tool}} pour le composant « {{component}} »…',
    es: 'Iniciando {{tool}} para el componente "{{component}}"…',
    de: 'Starte {{tool}} für Komponente „{{component}}"…',
    pt: 'Iniciando {{tool}} para o componente "{{component}}"…',
    it: 'Avvio di {{tool}} per il componente "{{component}}"…',
    nl: 'Start {{tool}} voor component "{{component}}"…',
    ja: '{{tool}} を開始: コンポーネント「{{component}}」…',
    zh: '正在启动 {{tool}}: 组件「{{component}}」…',
    ko: '{{tool}} 시작: 컴포넌트 "{{component}}"…',
  },

  'tool.end': {
    en: '{{tool}} completed for "{{component}}" ({{duration}}ms)',
    fr: '{{tool}} terminé pour « {{component}} » ({{duration}} ms)',
    es: '{{tool}} completado para "{{component}}" ({{duration}} ms)',
    de: '{{tool}} abgeschlossen für „{{component}}" ({{duration}} ms)',
    pt: '{{tool}} concluído para "{{component}}" ({{duration}} ms)',
    it: '{{tool}} completato per "{{component}}" ({{duration}} ms)',
    nl: '{{tool}} voltooid voor "{{component}}" ({{duration}} ms)',
    ja: '{{tool}} 完了:「{{component}}」({{duration}} ms)',
    zh: '{{tool}} 已完成:「{{component}}」({{duration}} ms)',
    ko: '{{tool}} 완료: "{{component}}" ({{duration}}ms)',
  },

  'tool.start.map': {
    en: 'Starting {{tool}} for map "{{filePath}}"…',
    fr: 'Démarrage de {{tool}} pour la carte « {{filePath}} »…',
    es: 'Iniciando {{tool}} para el mapa "{{filePath}}"…',
    de: 'Starte {{tool}} für Karte „{{filePath}}"…',
    pt: 'Iniciando {{tool}} para o mapa "{{filePath}}"…',
    it: 'Avvio di {{tool}} per la mappa "{{filePath}}"…',
    nl: 'Start {{tool}} voor kaart "{{filePath}}"…',
    ja: '{{tool}} を開始: マップ「{{filePath}}」…',
    zh: '正在启动 {{tool}}: 地图「{{filePath}}」…',
    ko: '{{tool}} 시작: 맵 "{{filePath}}"…',
  },

  'tool.end.map': {
    en: '{{tool}} completed for map "{{filePath}}" — {{count}} components ({{duration}}ms)',
    fr: '{{tool}} terminé pour la carte « {{filePath}} » — {{count}} composants ({{duration}} ms)',
    es: '{{tool}} completado para el mapa "{{filePath}}" — {{count}} componentes ({{duration}} ms)',
    de: '{{tool}} abgeschlossen für Karte „{{filePath}}" — {{count}} Komponenten ({{duration}} ms)',
    pt: '{{tool}} concluído para o mapa "{{filePath}}" — {{count}} componentes ({{duration}} ms)',
    it: '{{tool}} completato per la mappa "{{filePath}}" — {{count}} componenti ({{duration}} ms)',
    nl: '{{tool}} voltooid voor kaart "{{filePath}}" — {{count}} componenten ({{duration}} ms)',
    ja: '{{tool}} 完了: マップ「{{filePath}}」— {{count}} コンポーネント ({{duration}} ms)',
    zh: '{{tool}} 已完成: 地图「{{filePath}}」— {{count}} 个组件 ({{duration}} ms)',
    ko: '{{tool}} 완료: 맵 "{{filePath}}" — {{count}}개 컴포넌트 ({{duration}}ms)',
  },

  'tool.start.valuechain': {
    en: 'Starting {{tool}}: generating value chain…',
    fr: 'Démarrage de {{tool}} : génération de la chaîne de valeur…',
    es: 'Iniciando {{tool}}: generando cadena de valor…',
    de: 'Starte {{tool}}: Wertschöpfungskette wird generiert…',
    pt: 'Iniciando {{tool}}: gerando cadeia de valor…',
    it: 'Avvio di {{tool}}: generazione della catena del valore…',
    nl: 'Start {{tool}}: waardeketen wordt gegenereerd…',
    ja: '{{tool}} を開始: バリューチェーン生成中…',
    zh: '正在启动 {{tool}}: 生成价值链…',
    ko: '{{tool}} 시작: 가치 사슬 생성 중…',
  },

  'tool.end.valuechain': {
    en: '{{tool}} completed: {{count}} components mapped ({{duration}}ms)',
    fr: '{{tool}} terminé : {{count}} composants cartographiés ({{duration}} ms)',
    es: '{{tool}} completado: {{count}} componentes mapeados ({{duration}} ms)',
    de: '{{tool}} abgeschlossen: {{count}} Komponenten kartiert ({{duration}} ms)',
    pt: '{{tool}} concluído: {{count}} componentes mapeados ({{duration}} ms)',
    it: '{{tool}} completato: {{count}} componenti mappati ({{duration}} ms)',
    nl: '{{tool}} voltooid: {{count}} componenten in kaart gebracht ({{duration}} ms)',
    ja: '{{tool}} 完了: {{count}} コンポーネントをマッピング ({{duration}} ms)',
    zh: '{{tool}} 已完成: 已映射 {{count}} 个组件 ({{duration}} ms)',
    ko: '{{tool}} 완료: {{count}}개 컴포넌트 매핑 ({{duration}}ms)',
  },

  // ── Intermediate steps (debug level) ─────────────────────────────────
  'step.classification': {
    en: 'Classifying "{{component}}" → {{space}}',
    fr: 'Classification de « {{component}} » → {{space}}',
    es: 'Clasificando "{{component}}" → {{space}}',
    de: 'Klassifizierung von „{{component}}" → {{space}}',
    pt: 'Classificando "{{component}}" → {{space}}',
    it: 'Classificazione di "{{component}}" → {{space}}',
    nl: 'Classificatie van "{{component}}" → {{space}}',
    ja: '「{{component}}」を分類中 → {{space}}',
    zh: '正在分类「{{component}}」→ {{space}}',
    ko: '"{{component}}" 분류 중 → {{space}}',
  },

  'step.strategy': {
    en: 'Running strategy "{{strategy}}" on "{{component}}"…',
    fr: 'Exécution de la stratégie « {{strategy}} » sur « {{component}} »…',
    es: 'Ejecutando estrategia "{{strategy}}" en "{{component}}"…',
    de: 'Strategie „{{strategy}}" wird auf „{{component}}" angewendet…',
    pt: 'Executando estratégia "{{strategy}}" em "{{component}}"…',
    it: 'Esecuzione della strategia "{{strategy}}" su "{{component}}"…',
    nl: 'Strategie "{{strategy}}" wordt uitgevoerd op "{{component}}"…',
    ja: 'ストラテジー「{{strategy}}」を実行中:「{{component}}」…',
    zh: '正在运行策略「{{strategy}}」:「{{component}}」…',
    ko: '"{{component}}"에 "{{strategy}}" 전략 실행 중…',
  },

  'step.strategy.result': {
    en: 'Strategy "{{strategy}}": evolution={{evolution}}, confidence={{confidence}}',
    fr: 'Stratégie « {{strategy}} » : évolution={{evolution}}, confiance={{confidence}}',
    es: 'Estrategia "{{strategy}}": evolución={{evolution}}, confianza={{confidence}}',
    de: 'Strategie „{{strategy}}": Evolution={{evolution}}, Konfidenz={{confidence}}',
    pt: 'Estratégia "{{strategy}}": evolução={{evolution}}, confiança={{confidence}}',
    it: 'Strategia "{{strategy}}": evoluzione={{evolution}}, confidenza={{confidence}}',
    nl: 'Strategie "{{strategy}}": evolutie={{evolution}}, betrouwbaarheid={{confidence}}',
    ja: 'ストラテジー「{{strategy}}」: evolution={{evolution}}, confidence={{confidence}}',
    zh: '策略「{{strategy}}」: evolution={{evolution}}, confidence={{confidence}}',
    ko: '전략 "{{strategy}}": evolution={{evolution}}, confidence={{confidence}}',
  },

  'step.strategy.error': {
    en: 'Strategy "{{strategy}}" failed: {{error}}',
    fr: 'Stratégie « {{strategy}} » échouée : {{error}}',
    es: 'Estrategia "{{strategy}}" falló: {{error}}',
    de: 'Strategie „{{strategy}}" fehlgeschlagen: {{error}}',
    pt: 'Estratégia "{{strategy}}" falhou: {{error}}',
    it: 'Strategia "{{strategy}}" fallita: {{error}}',
    nl: 'Strategie "{{strategy}}" mislukt: {{error}}',
    ja: 'ストラテジー「{{strategy}}」失敗: {{error}}',
    zh: '策略「{{strategy}}」失败: {{error}}',
    ko: '전략 "{{strategy}}" 실패: {{error}}',
  },

  'step.llm.call': {
    en: 'Calling LLM ({{model}})…',
    fr: 'Appel au LLM ({{model}})…',
    es: 'Llamando al LLM ({{model}})…',
    de: 'LLM-Aufruf ({{model}})…',
    pt: 'Chamando LLM ({{model}})…',
    it: 'Chiamata al LLM ({{model}})…',
    nl: 'LLM aanroepen ({{model}})…',
    ja: 'LLM 呼び出し中 ({{model}})…',
    zh: '正在调用 LLM ({{model}})…',
    ko: 'LLM 호출 중 ({{model}})…',
  },

  'step.llm.response': {
    en: 'LLM response received ({{tokens}} tokens, {{duration}}ms)',
    fr: 'Réponse du LLM reçue ({{tokens}} tokens, {{duration}} ms)',
    es: 'Respuesta del LLM recibida ({{tokens}} tokens, {{duration}} ms)',
    de: 'LLM-Antwort erhalten ({{tokens}} Tokens, {{duration}} ms)',
    pt: 'Resposta do LLM recebida ({{tokens}} tokens, {{duration}} ms)',
    it: 'Risposta del LLM ricevuta ({{tokens}} token, {{duration}} ms)',
    nl: 'LLM-antwoord ontvangen ({{tokens}} tokens, {{duration}} ms)',
    ja: 'LLM レスポンス受信 ({{tokens}} トークン, {{duration}} ms)',
    zh: 'LLM 响应已收到 ({{tokens}} tokens, {{duration}} ms)',
    ko: 'LLM 응답 수신 ({{tokens}} 토큰, {{duration}}ms)',
  },

  'step.parsing': {
    en: 'Parsing map file: {{count}} components found',
    fr: 'Analyse du fichier carte : {{count}} composants trouvés',
    es: 'Analizando archivo de mapa: {{count}} componentes encontrados',
    de: 'Kartendatei wird analysiert: {{count}} Komponenten gefunden',
    pt: 'Analisando arquivo do mapa: {{count}} componentes encontrados',
    it: 'Analisi del file mappa: {{count}} componenti trovati',
    nl: 'Kaartbestand wordt geparseerd: {{count}} componenten gevonden',
    ja: 'マップファイル解析中: {{count}} コンポーネント検出',
    zh: '正在解析地图文件: 找到 {{count}} 个组件',
    ko: '맵 파일 분석 중: {{count}}개 컴포넌트 발견',
  },

  'step.evaluation.progress': {
    en: 'Evaluating component {{current}}/{{total}}: "{{component}}"…',
    fr: 'Évaluation du composant {{current}}/{{total}} : « {{component}} »…',
    es: 'Evaluando componente {{current}}/{{total}}: "{{component}}"…',
    de: 'Bewertung Komponente {{current}}/{{total}}: „{{component}}"…',
    pt: 'Avaliando componente {{current}}/{{total}}: "{{component}}"…',
    it: 'Valutazione componente {{current}}/{{total}}: "{{component}}"…',
    nl: 'Component {{current}}/{{total}} evalueren: "{{component}}"…',
    ja: 'コンポーネント評価中 {{current}}/{{total}}: 「{{component}}」…',
    zh: '正在评估组件 {{current}}/{{total}}: 「{{component}}」…',
    ko: '컴포넌트 평가 중 {{current}}/{{total}}: "{{component}}"…',
  },

  'step.evaluation.bestpick': {
    en: 'Best evolution for "{{component}}": {{evolution}} (strategy: {{strategy}}, confidence: {{confidence}})',
    fr: 'Meilleure évolution pour « {{component}} » : {{evolution}} (stratégie : {{strategy}}, confiance : {{confidence}})',
    es: 'Mejor evolución para "{{component}}": {{evolution}} (estrategia: {{strategy}}, confianza: {{confidence}})',
    de: 'Beste Evolution für „{{component}}": {{evolution}} (Strategie: {{strategy}}, Konfidenz: {{confidence}})',
    pt: 'Melhor evolução para "{{component}}": {{evolution}} (estratégia: {{strategy}}, confiança: {{confidence}})',
    it: 'Migliore evoluzione per "{{component}}": {{evolution}} (strategia: {{strategy}}, confidenza: {{confidence}})',
    nl: 'Beste evolutie voor "{{component}}": {{evolution}} (strategie: {{strategy}}, betrouwbaarheid: {{confidence}})',
    ja: '「{{component}}」の最適進化値: {{evolution}} (ストラテジー: {{strategy}}, confidence: {{confidence}})',
    zh: '「{{component}}」最佳演化值: {{evolution}} (策略: {{strategy}}, confidence: {{confidence}})',
    ko: '"{{component}}" 최적 진화값: {{evolution}} (전략: {{strategy}}, confidence: {{confidence}})',
  },

  'step.file.update': {
    en: 'Updating .wm file with {{count}} evaluated components…',
    fr: 'Mise à jour du fichier .wm avec {{count}} composants évalués…',
    es: 'Actualizando archivo .wm con {{count}} componentes evaluados…',
    de: '.wm-Datei wird mit {{count}} bewerteten Komponenten aktualisiert…',
    pt: 'Atualizando arquivo .wm com {{count}} componentes avaliados…',
    it: 'Aggiornamento del file .wm con {{count}} componenti valutati…',
    nl: '.wm-bestand wordt bijgewerkt met {{count}} geëvalueerde componenten…',
    ja: '.wm ファイル更新中: {{count}} コンポーネント評価済み…',
    zh: '正在更新 .wm 文件: {{count}} 个已评估组件…',
    ko: '.wm 파일 업데이트 중: {{count}}개 평가된 컴포넌트…',
  },

  'step.evaluation.summary': {
    en: 'Evaluation summary: {{evaluated}} succeeded, {{skipped}} skipped out of {{total}} components',
    fr: 'Résumé de l\'évaluation : {{evaluated}} réussis, {{skipped}} ignorés sur {{total}} composants',
    es: 'Resumen de evaluación: {{evaluated}} exitosos, {{skipped}} omitidos de {{total}} componentes',
    de: 'Bewertungszusammenfassung: {{evaluated}} erfolgreich, {{skipped}} übersprungen von {{total}} Komponenten',
    pt: 'Resumo da avaliação: {{evaluated}} bem-sucedidos, {{skipped}} ignorados de {{total}} componentes',
    it: 'Riepilogo valutazione: {{evaluated}} riusciti, {{skipped}} saltati su {{total}} componenti',
    nl: 'Evaluatieoverzicht: {{evaluated}} geslaagd, {{skipped}} overgeslagen van {{total}} componenten',
    ja: '評価サマリー: {{evaluated}} 成功, {{skipped}} スキップ / 全 {{total}} コンポーネント',
    zh: '评估摘要: {{evaluated}} 成功, {{skipped}} 跳过 / 共 {{total}} 个组件',
    ko: '평가 요약: {{evaluated}}개 성공, {{skipped}}개 건너뜀 / 전체 {{total}}개 컴포넌트',
  },

  'step.evaluation.skipped': {
    en: 'Component "{{component}}" skipped ({{reason}})',
    fr: 'Composant « {{component}} » ignoré ({{reason}})',
    es: 'Componente "{{component}}" omitido ({{reason}})',
    de: 'Komponente „{{component}}" übersprungen ({{reason}})',
    pt: 'Componente "{{component}}" ignorado ({{reason}})',
    it: 'Componente "{{component}}" saltato ({{reason}})',
    nl: 'Component "{{component}}" overgeslagen ({{reason}})',
    ja: 'コンポーネント「{{component}}」スキップ ({{reason}})',
    zh: '组件「{{component}}」已跳过 ({{reason}})',
    ko: '컴포넌트 "{{component}}" 건너뜀 ({{reason}})',
  },

  'step.decomposition': {
    en: 'Decomposing business description into value chain…',
    fr: 'Décomposition de la description métier en chaîne de valeur…',
    es: 'Descomponiendo la descripción del negocio en cadena de valor…',
    de: 'Geschäftsbeschreibung wird in Wertschöpfungskette zerlegt…',
    pt: 'Decompondo a descrição do negócio em cadeia de valor…',
    it: 'Decomposizione della descrizione aziendale in catena del valore…',
    nl: 'Bedrijfsbeschrijving wordt ontleed in waardeketen…',
    ja: 'ビジネス記述をバリューチェーンに分解中…',
    zh: '正在将业务描述分解为价值链…',
    ko: '비즈니스 설명을 가치 사슬로 분해 중…',
  },

  'step.wm.generation': {
    en: 'Generating .wm file with {{count}} components…',
    fr: 'Génération du fichier .wm avec {{count}} composants…',
    es: 'Generando archivo .wm con {{count}} componentes…',
    de: '.wm-Datei wird mit {{count}} Komponenten generiert…',
    pt: 'Gerando arquivo .wm com {{count}} componentes…',
    it: 'Generazione del file .wm con {{count}} componenti…',
    nl: '.wm-bestand wordt gegenereerd met {{count}} componenten…',
    ja: '.wm ファイル生成中: {{count}} コンポーネント…',
    zh: '正在生成 .wm 文件: {{count}} 个组件…',
    ko: '.wm 파일 생성 중: {{count}}개 컴포넌트…',
  },

  // ── Error messages (error level) ─────────────────────────────────────
  'error.llm.timeout': {
    en: 'LLM call timed out after {{duration}}ms (model: {{model}})',
    fr: 'Appel LLM expiré après {{duration}} ms (modèle : {{model}})',
    es: 'Llamada al LLM expiró después de {{duration}} ms (modelo: {{model}})',
    de: 'LLM-Aufruf nach {{duration}} ms abgelaufen (Modell: {{model}})',
    pt: 'Chamada LLM expirou após {{duration}} ms (modelo: {{model}})',
    it: 'Chiamata LLM scaduta dopo {{duration}} ms (modello: {{model}})',
    nl: 'LLM-aanroep verlopen na {{duration}} ms (model: {{model}})',
    ja: 'LLM 呼び出しタイムアウト: {{duration}} ms (モデル: {{model}})',
    zh: 'LLM 调用超时: {{duration}} ms (模型: {{model}})',
    ko: 'LLM 호출 시간 초과: {{duration}}ms (모델: {{model}})',
  },

  'error.llm.ratelimit': {
    en: 'LLM rate limit exceeded (model: {{model}}). Retry after {{retryAfter}}s',
    fr: 'Limite de débit LLM dépassée (modèle : {{model}}). Réessayer dans {{retryAfter}}s',
    es: 'Límite de velocidad del LLM excedido (modelo: {{model}}). Reintentar en {{retryAfter}}s',
    de: 'LLM-Ratenlimit überschritten (Modell: {{model}}). Erneuter Versuch in {{retryAfter}}s',
    pt: 'Limite de taxa do LLM excedido (modelo: {{model}}). Tente novamente em {{retryAfter}}s',
    it: 'Limite di frequenza LLM superato (modello: {{model}}). Riprovare tra {{retryAfter}}s',
    nl: 'LLM-snelheidslimiet overschreden (model: {{model}}). Opnieuw proberen over {{retryAfter}}s',
    ja: 'LLM レートリミット超過 (モデル: {{model}})。{{retryAfter}}秒後にリトライ',
    zh: 'LLM 速率限制已超出 (模型: {{model}})。{{retryAfter}}秒后重试',
    ko: 'LLM 속도 제한 초과 (모델: {{model}}). {{retryAfter}}초 후 재시도',
  },

  'error.llm.api': {
    en: 'LLM API error ({{status}}): {{message}}',
    fr: 'Erreur API LLM ({{status}}) : {{message}}',
    es: 'Error de API del LLM ({{status}}): {{message}}',
    de: 'LLM-API-Fehler ({{status}}): {{message}}',
    pt: 'Erro na API do LLM ({{status}}): {{message}}',
    it: 'Errore API LLM ({{status}}): {{message}}',
    nl: 'LLM API-fout ({{status}}): {{message}}',
    ja: 'LLM API エラー ({{status}}): {{message}}',
    zh: 'LLM API 错误 ({{status}}): {{message}}',
    ko: 'LLM API 오류 ({{status}}): {{message}}',
  },

  'error.llm.auth': {
    en: 'LLM authentication failed ({{status}}): check API key configuration',
    fr: 'Authentification LLM échouée ({{status}}) : vérifiez la configuration de la clé API',
    es: 'Autenticación LLM fallida ({{status}}): verifique la configuración de la clave API',
    de: 'LLM-Authentifizierung fehlgeschlagen ({{status}}): API-Schlüssel-Konfiguration prüfen',
    pt: 'Autenticação LLM falhou ({{status}}): verifique a configuração da chave API',
    it: 'Autenticazione LLM fallita ({{status}}): controllare la configurazione della chiave API',
    nl: 'LLM-authenticatie mislukt ({{status}}): controleer de API-sleutelconfiguratie',
    ja: 'LLM 認証失敗 ({{status}}): APIキー設定を確認してください',
    zh: 'LLM 认证失败 ({{status}}): 请检查 API 密钥配置',
    ko: 'LLM 인증 실패 ({{status}}): API 키 설정을 확인하세요',
  },

  'error.llm.network': {
    en: 'LLM network error: {{message}}',
    fr: 'Erreur réseau LLM : {{message}}',
    es: 'Error de red del LLM: {{message}}',
    de: 'LLM-Netzwerkfehler: {{message}}',
    pt: 'Erro de rede do LLM: {{message}}',
    it: 'Errore di rete LLM: {{message}}',
    nl: 'LLM-netwerkfout: {{message}}',
    ja: 'LLM ネットワークエラー: {{message}}',
    zh: 'LLM 网络错误: {{message}}',
    ko: 'LLM 네트워크 오류: {{message}}',
  },

  'error.llm.empty': {
    en: 'LLM returned empty response (model: {{model}})',
    fr: 'Le LLM a renvoyé une réponse vide (modèle : {{model}})',
    es: 'El LLM devolvió una respuesta vacía (modelo: {{model}})',
    de: 'LLM lieferte leere Antwort (Modell: {{model}})',
    pt: 'O LLM retornou uma resposta vazia (modelo: {{model}})',
    it: 'Il LLM ha restituito una risposta vuota (modello: {{model}})',
    nl: 'LLM retourneerde een leeg antwoord (model: {{model}})',
    ja: 'LLM が空のレスポンスを返しました (モデル: {{model}})',
    zh: 'LLM 返回了空响应 (模型: {{model}})',
    ko: 'LLM이 빈 응답을 반환했습니다 (모델: {{model}})',
  },

  'error.parse': {
    en: 'Failed to parse map file: {{error}}',
    fr: 'Échec de l\'analyse du fichier carte : {{error}}',
    es: 'Error al analizar el archivo de mapa: {{error}}',
    de: 'Fehler beim Parsen der Kartendatei: {{error}}',
    pt: 'Falha ao analisar o arquivo do mapa: {{error}}',
    it: 'Errore nell\'analisi del file mappa: {{error}}',
    nl: 'Fout bij het parseren van het kaartbestand: {{error}}',
    ja: 'マップファイルの解析に失敗: {{error}}',
    zh: '地图文件解析失败: {{error}}',
    ko: '맵 파일 분석 실패: {{error}}',
  },

  'error.generic': {
    en: 'Error in {{tool}}: {{error}}',
    fr: 'Erreur dans {{tool}} : {{error}}',
    es: 'Error en {{tool}}: {{error}}',
    de: 'Fehler in {{tool}}: {{error}}',
    pt: 'Erro em {{tool}}: {{error}}',
    it: 'Errore in {{tool}}: {{error}}',
    nl: 'Fout in {{tool}}: {{error}}',
    ja: '{{tool}} エラー: {{error}}',
    zh: '{{tool}} 错误: {{error}}',
    ko: '{{tool}} 오류: {{error}}',
  },
};

// ─── Template Interpolation ────────────────────────────────────────────────

/**
 * Replace {{param}} placeholders in a template string.
 *
 * @param {string} template - Template with {{param}} placeholders
 * @param {Object} params - Key-value pairs to substitute
 * @returns {string} Interpolated string
 */
function interpolate(template, params = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return params[key] !== undefined ? String(params[key]) : match;
  });
}

// ─── Message Resolver ──────────────────────────────────────────────────────

/**
 * Create a message resolver bound to a specific language.
 *
 * Returns a function that resolves message IDs to localized, interpolated strings.
 * Falls back to English if the language or message ID is not found.
 *
 * @param {string} lang - ISO 639-1 language code (e.g. 'fr', 'en')
 * @returns {function(string, Object=): string} Message resolver function
 *
 * @example
 *   const msg = createMessageResolver('fr');
 *   msg('tool.start', { tool: 'estimateEvolution', component: 'ERP' })
 *   // → "Démarrage de estimateEvolution pour le composant « ERP »…"
 */
export function createMessageResolver(lang = 'en') {
  const effectiveLang = lang || 'en';

  return function resolve(messageId, params = {}) {
    const entry = MESSAGE_CATALOG[messageId];
    if (!entry) {
      // Unknown message ID — return the ID itself as fallback
      return interpolate(messageId, params);
    }

    // Try requested language, fall back to English
    const template = entry[effectiveLang] || entry['en'];
    if (!template) {
      return interpolate(messageId, params);
    }

    return interpolate(template, params);
  };
}

/**
 * Create a message resolver auto-detecting language from tool arguments.
 *
 * Convenience function that detects the language from args and returns
 * both the resolver and the detected language code.
 *
 * @param {Object} args - Tool arguments (name, context, description, etc.)
 * @returns {{ msg: function, lang: string }} Resolver + detected language
 */
export function createMessageResolverFromArgs(args) {
  const lang = detectLanguageFromArgs(args);
  return {
    msg: createMessageResolver(lang),
    lang,
  };
}

// ─── Exports ───────────────────────────────────────────────────────────────

export { MESSAGE_CATALOG, interpolate };
