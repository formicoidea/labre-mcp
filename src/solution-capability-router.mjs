// Solution vs Capability Router
//
// Detects whether a Wardley Map component is a concrete named solution
// (e.g. "Kubernetes", "Salesforce", "SAP ERP") or an abstract capability
// (e.g. "container orchestration", "CRM", "manage customer relationships").
//
// Detection strategy (ordered by priority):
//   1. Naming convention heuristics with confidence score (fast, no LLM)
//   2. When confidence < 90%, the caller should use LLM + web search fallback
//      (implemented separately in the routing dispatch layer)
//
// Routing is exclusive by default (env: WARDLEY_EVAL_MODE=exclusive|parallel):
//   - exclusive: routes to solution-strategies OR capability strategies, not both
//   - parallel: routes to both, returns combined results
//
// The router does NOT modify existing strategy files or the capability pipeline.
// It sits AFTER the classification gate and BEFORE strategy dispatch.

import { loadSolutionStrategies } from './solution-strategies/registry.mjs';
import { assembleSolutionResult } from './solution-strategies/assemble-result.mjs';
import { logDebug } from './mcp-notifications.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Detection result types */
export const COMPONENT_TYPE = {
  SOLUTION: 'solution',
  CAPABILITY: 'capability',
};

/** Routing modes */
export const EVAL_MODES = {
  EXCLUSIVE: 'exclusive',
  PARALLEL: 'parallel',
};

/** Confidence threshold: below this, the caller should invoke LLM fallback */
export const CONFIDENCE_THRESHOLD = 0.90;

// ─── Known Solutions Dictionary ───────────────────────────────────────────────
//
// Curated list of well-known solutions, products, and platforms.
// Each entry maps a normalized form to metadata about the solution.
// This enables fast, high-confidence detection without LLM calls.

const KNOWN_SOLUTIONS = new Map([
  // Cloud platforms
  ['aws', { canonical: 'AWS', vendor: 'Amazon', category: 'cloud platform' }],
  ['amazon web services', { canonical: 'AWS', vendor: 'Amazon', category: 'cloud platform' }],
  ['azure', { canonical: 'Azure', vendor: 'Microsoft', category: 'cloud platform' }],
  ['microsoft azure', { canonical: 'Azure', vendor: 'Microsoft', category: 'cloud platform' }],
  ['gcp', { canonical: 'GCP', vendor: 'Google', category: 'cloud platform' }],
  ['google cloud', { canonical: 'GCP', vendor: 'Google', category: 'cloud platform' }],
  ['google cloud platform', { canonical: 'GCP', vendor: 'Google', category: 'cloud platform' }],

  // Container & orchestration
  ['kubernetes', { canonical: 'Kubernetes', vendor: 'CNCF', category: 'container orchestration' }],
  ['k8s', { canonical: 'Kubernetes', vendor: 'CNCF', category: 'container orchestration' }],
  ['docker', { canonical: 'Docker', vendor: 'Docker Inc', category: 'containerization' }],
  ['openshift', { canonical: 'OpenShift', vendor: 'Red Hat', category: 'container platform' }],

  // CRM & sales
  ['salesforce', { canonical: 'Salesforce', vendor: 'Salesforce', category: 'CRM' }],
  ['hubspot', { canonical: 'HubSpot', vendor: 'HubSpot', category: 'CRM & marketing' }],
  ['dynamics 365', { canonical: 'Dynamics 365', vendor: 'Microsoft', category: 'CRM & ERP' }],
  ['microsoft dynamics', { canonical: 'Dynamics 365', vendor: 'Microsoft', category: 'CRM & ERP' }],

  // ERP & business management
  ['sap', { canonical: 'SAP', vendor: 'SAP SE', category: 'ERP' }],
  ['sap erp', { canonical: 'SAP ERP', vendor: 'SAP SE', category: 'ERP' }],
  ['sap s/4hana', { canonical: 'SAP S/4HANA', vendor: 'SAP SE', category: 'ERP' }],
  ['s/4hana', { canonical: 'SAP S/4HANA', vendor: 'SAP SE', category: 'ERP' }],
  ['oracle erp', { canonical: 'Oracle ERP Cloud', vendor: 'Oracle', category: 'ERP' }],
  ['netsuite', { canonical: 'NetSuite', vendor: 'Oracle', category: 'ERP' }],
  ['workday', { canonical: 'Workday', vendor: 'Workday', category: 'HCM & finance' }],

  // Databases
  ['postgresql', { canonical: 'PostgreSQL', vendor: 'PostgreSQL Global', category: 'relational database' }],
  ['postgres', { canonical: 'PostgreSQL', vendor: 'PostgreSQL Global', category: 'relational database' }],
  ['mysql', { canonical: 'MySQL', vendor: 'Oracle', category: 'relational database' }],
  ['mongodb', { canonical: 'MongoDB', vendor: 'MongoDB Inc', category: 'document database' }],
  ['redis', { canonical: 'Redis', vendor: 'Redis Ltd', category: 'in-memory data store' }],
  ['elasticsearch', { canonical: 'Elasticsearch', vendor: 'Elastic', category: 'search engine' }],
  ['oracle database', { canonical: 'Oracle Database', vendor: 'Oracle', category: 'relational database' }],
  ['sql server', { canonical: 'SQL Server', vendor: 'Microsoft', category: 'relational database' }],
  ['microsoft sql server', { canonical: 'SQL Server', vendor: 'Microsoft', category: 'relational database' }],
  ['dynamodb', { canonical: 'DynamoDB', vendor: 'Amazon', category: 'NoSQL database' }],
  ['cassandra', { canonical: 'Cassandra', vendor: 'Apache', category: 'distributed database' }],
  ['snowflake', { canonical: 'Snowflake', vendor: 'Snowflake', category: 'data warehouse' }],

  // DevOps & CI/CD
  ['jenkins', { canonical: 'Jenkins', vendor: 'Jenkins', category: 'CI/CD' }],
  ['github actions', { canonical: 'GitHub Actions', vendor: 'GitHub', category: 'CI/CD' }],
  ['gitlab', { canonical: 'GitLab', vendor: 'GitLab', category: 'DevOps platform' }],
  ['terraform', { canonical: 'Terraform', vendor: 'HashiCorp', category: 'infrastructure as code' }],
  ['ansible', { canonical: 'Ansible', vendor: 'Red Hat', category: 'configuration management' }],
  ['puppet', { canonical: 'Puppet', vendor: 'Puppet', category: 'configuration management' }],
  ['chef', { canonical: 'Chef', vendor: 'Progress', category: 'configuration management' }],
  ['circleci', { canonical: 'CircleCI', vendor: 'CircleCI', category: 'CI/CD' }],
  ['argocd', { canonical: 'ArgoCD', vendor: 'Argo Project', category: 'GitOps' }],

  // Monitoring & observability
  ['datadog', { canonical: 'Datadog', vendor: 'Datadog', category: 'observability' }],
  ['grafana', { canonical: 'Grafana', vendor: 'Grafana Labs', category: 'observability' }],
  ['prometheus', { canonical: 'Prometheus', vendor: 'CNCF', category: 'monitoring' }],
  ['splunk', { canonical: 'Splunk', vendor: 'Cisco', category: 'log management' }],
  ['new relic', { canonical: 'New Relic', vendor: 'New Relic', category: 'APM' }],
  ['pagerduty', { canonical: 'PagerDuty', vendor: 'PagerDuty', category: 'incident management' }],

  // Communication & collaboration
  ['slack', { canonical: 'Slack', vendor: 'Salesforce', category: 'team messaging' }],
  ['microsoft teams', { canonical: 'Microsoft Teams', vendor: 'Microsoft', category: 'collaboration' }],
  ['teams', { canonical: 'Microsoft Teams', vendor: 'Microsoft', category: 'collaboration' }],
  ['zoom', { canonical: 'Zoom', vendor: 'Zoom', category: 'video conferencing' }],
  ['jira', { canonical: 'Jira', vendor: 'Atlassian', category: 'project management' }],
  ['confluence', { canonical: 'Confluence', vendor: 'Atlassian', category: 'knowledge management' }],
  ['notion', { canonical: 'Notion', vendor: 'Notion Labs', category: 'workspace' }],
  ['asana', { canonical: 'Asana', vendor: 'Asana', category: 'project management' }],
  ['trello', { canonical: 'Trello', vendor: 'Atlassian', category: 'project management' }],

  // AI/ML platforms
  ['openai', { canonical: 'OpenAI', vendor: 'OpenAI', category: 'AI platform' }],
  ['chatgpt', { canonical: 'ChatGPT', vendor: 'OpenAI', category: 'conversational AI' }],
  ['claude', { canonical: 'Claude', vendor: 'Anthropic', category: 'AI assistant' }],
  ['tensorflow', { canonical: 'TensorFlow', vendor: 'Google', category: 'ML framework' }],
  ['pytorch', { canonical: 'PyTorch', vendor: 'Meta', category: 'ML framework' }],
  ['sagemaker', { canonical: 'SageMaker', vendor: 'Amazon', category: 'ML platform' }],
  ['vertex ai', { canonical: 'Vertex AI', vendor: 'Google', category: 'ML platform' }],
  ['hugging face', { canonical: 'Hugging Face', vendor: 'Hugging Face', category: 'ML hub' }],

  // Security
  ['crowdstrike', { canonical: 'CrowdStrike', vendor: 'CrowdStrike', category: 'endpoint security' }],
  ['okta', { canonical: 'Okta', vendor: 'Okta', category: 'identity management' }],
  ['auth0', { canonical: 'Auth0', vendor: 'Okta', category: 'authentication' }],
  ['palo alto networks', { canonical: 'Palo Alto Networks', vendor: 'Palo Alto', category: 'network security' }],
  ['cloudflare', { canonical: 'Cloudflare', vendor: 'Cloudflare', category: 'CDN & security' }],
  ['hashicorp vault', { canonical: 'Vault', vendor: 'HashiCorp', category: 'secrets management' }],
  ['vault', { canonical: 'Vault', vendor: 'HashiCorp', category: 'secrets management' }],

  // Messaging & streaming
  ['kafka', { canonical: 'Apache Kafka', vendor: 'Apache/Confluent', category: 'event streaming' }],
  ['apache kafka', { canonical: 'Apache Kafka', vendor: 'Apache/Confluent', category: 'event streaming' }],
  ['rabbitmq', { canonical: 'RabbitMQ', vendor: 'VMware', category: 'message broker' }],
  ['pulsar', { canonical: 'Apache Pulsar', vendor: 'Apache', category: 'messaging' }],

  // Specific products / platforms
  ['shopify', { canonical: 'Shopify', vendor: 'Shopify', category: 'e-commerce platform' }],
  ['stripe', { canonical: 'Stripe', vendor: 'Stripe', category: 'payment processing' }],
  ['twilio', { canonical: 'Twilio', vendor: 'Twilio', category: 'communications API' }],
  ['sendgrid', { canonical: 'SendGrid', vendor: 'Twilio', category: 'email delivery' }],
  ['mailchimp', { canonical: 'Mailchimp', vendor: 'Intuit', category: 'email marketing' }],
  ['wordpress', { canonical: 'WordPress', vendor: 'Automattic', category: 'CMS' }],
  ['contentful', { canonical: 'Contentful', vendor: 'Contentful', category: 'headless CMS' }],
  ['tableau', { canonical: 'Tableau', vendor: 'Salesforce', category: 'data visualization' }],
  ['power bi', { canonical: 'Power BI', vendor: 'Microsoft', category: 'business intelligence' }],
  ['looker', { canonical: 'Looker', vendor: 'Google', category: 'business intelligence' }],
  ['airflow', { canonical: 'Apache Airflow', vendor: 'Apache', category: 'workflow orchestration' }],
  ['apache airflow', { canonical: 'Apache Airflow', vendor: 'Apache', category: 'workflow orchestration' }],
  ['vercel', { canonical: 'Vercel', vendor: 'Vercel', category: 'frontend platform' }],
  ['netlify', { canonical: 'Netlify', vendor: 'Netlify', category: 'web deployment' }],
  ['heroku', { canonical: 'Heroku', vendor: 'Salesforce', category: 'PaaS' }],
  ['supabase', { canonical: 'Supabase', vendor: 'Supabase', category: 'backend as a service' }],
  ['firebase', { canonical: 'Firebase', vendor: 'Google', category: 'mobile backend' }],

  // Traditional / legacy
  ['sap hana', { canonical: 'SAP HANA', vendor: 'SAP SE', category: 'in-memory database' }],
  ['ibm mainframe', { canonical: 'IBM Mainframe', vendor: 'IBM', category: 'mainframe computing' }],
  ['vmware', { canonical: 'VMware', vendor: 'Broadcom', category: 'virtualization' }],
  ['vmware vsphere', { canonical: 'VMware vSphere', vendor: 'Broadcom', category: 'virtualization' }],
  ['citrix', { canonical: 'Citrix', vendor: 'Cloud Software Group', category: 'virtualization' }],

  // Networking
  ['nginx', { canonical: 'NGINX', vendor: 'F5', category: 'web server / reverse proxy' }],
  ['apache http', { canonical: 'Apache HTTP Server', vendor: 'Apache', category: 'web server' }],
  ['envoy', { canonical: 'Envoy', vendor: 'CNCF', category: 'service proxy' }],
  ['istio', { canonical: 'Istio', vendor: 'Google/IBM', category: 'service mesh' }],
  ['consul', { canonical: 'Consul', vendor: 'HashiCorp', category: 'service discovery' }],

  // Programming languages as solutions (when used as component labels)
  ['java', { canonical: 'Java', vendor: 'Oracle', category: 'programming language' }],
  ['python', { canonical: 'Python', vendor: 'PSF', category: 'programming language' }],
  ['node.js', { canonical: 'Node.js', vendor: 'OpenJS', category: 'runtime' }],
  ['nodejs', { canonical: 'Node.js', vendor: 'OpenJS', category: 'runtime' }],
  ['go', { canonical: 'Go', vendor: 'Google', category: 'programming language' }],
  ['golang', { canonical: 'Go', vendor: 'Google', category: 'programming language' }],
  ['rust', { canonical: 'Rust', vendor: 'Rust Foundation', category: 'programming language' }],
  ['.net', { canonical: '.NET', vendor: 'Microsoft', category: 'runtime' }],
  ['dotnet', { canonical: '.NET', vendor: 'Microsoft', category: 'runtime' }],

  // Operating systems
  ['linux', { canonical: 'Linux', vendor: 'Linux Foundation', category: 'operating system' }],
  ['windows', { canonical: 'Windows', vendor: 'Microsoft', category: 'operating system' }],
  ['windows server', { canonical: 'Windows Server', vendor: 'Microsoft', category: 'server OS' }],
  ['ubuntu', { canonical: 'Ubuntu', vendor: 'Canonical', category: 'Linux distribution' }],
  ['red hat', { canonical: 'Red Hat Enterprise Linux', vendor: 'Red Hat', category: 'Linux distribution' }],
  ['rhel', { canonical: 'Red Hat Enterprise Linux', vendor: 'Red Hat', category: 'Linux distribution' }],
]);

// ─── Known Capabilities Dictionary ────────────────────────────────────────────
//
// Abstract capabilities that should route to the capability pipeline.
// Includes both full phrases and common abbreviations.

const KNOWN_CAPABILITIES = new Map([
  // Abbreviations commonly used for capabilities (these override solution detection)
  ['crm', { canonical: 'Customer Relationship Management', nature: 'activity' }],
  ['erp', { canonical: 'Enterprise Resource Planning', nature: 'activity' }],
  ['scm', { canonical: 'Supply Chain Management', nature: 'activity' }],
  ['hrm', { canonical: 'Human Resource Management', nature: 'activity' }],
  ['hcm', { canonical: 'Human Capital Management', nature: 'activity' }],
  ['bi', { canonical: 'Business Intelligence', nature: 'activity' }],
  ['etl', { canonical: 'Extract Transform Load', nature: 'activity' }],
  ['ci/cd', { canonical: 'Continuous Integration / Continuous Delivery', nature: 'practice' }],
  ['iam', { canonical: 'Identity and Access Management', nature: 'activity' }],
  ['cdn', { canonical: 'Content Delivery Network', nature: 'activity' }],
  ['vpn', { canonical: 'Virtual Private Network', nature: 'activity' }],
  ['dns', { canonical: 'Domain Name System', nature: 'activity' }],
  ['api', { canonical: 'Application Programming Interface', nature: 'practice' }],
  ['rpa', { canonical: 'Robotic Process Automation', nature: 'activity' }],
  ['mlops', { canonical: 'Machine Learning Operations', nature: 'practice' }],
  ['devops', { canonical: 'DevOps', nature: 'practice' }],
  ['devsecops', { canonical: 'DevSecOps', nature: 'practice' }],
  ['llm', { canonical: 'Large Language Model', nature: 'knowledge' }],
  ['genai', { canonical: 'Generative AI', nature: 'knowledge' }],

  // Full-phrase capabilities (activity-style)
  ['container orchestration', { canonical: 'Orchestrate containers', nature: 'activity' }],
  ['customer relationship management', { canonical: 'Manage customer relationships', nature: 'activity' }],
  ['enterprise resource planning', { canonical: 'Plan enterprise resources', nature: 'activity' }],
  ['supply chain management', { canonical: 'Manage supply chain', nature: 'activity' }],
  ['identity management', { canonical: 'Manage identities', nature: 'activity' }],
  ['access management', { canonical: 'Manage access controls', nature: 'activity' }],
  ['data storage', { canonical: 'Store data', nature: 'activity' }],
  ['data warehousing', { canonical: 'Warehouse business data', nature: 'activity' }],
  ['payment processing', { canonical: 'Process payments', nature: 'activity' }],
  ['email delivery', { canonical: 'Deliver email messages', nature: 'activity' }],
  ['content management', { canonical: 'Manage content', nature: 'activity' }],
  ['project management', { canonical: 'Manage projects', nature: 'activity' }],
  ['incident management', { canonical: 'Manage incidents', nature: 'activity' }],
  ['log management', { canonical: 'Manage logs', nature: 'activity' }],
  ['configuration management', { canonical: 'Manage configurations', nature: 'activity' }],
  ['secrets management', { canonical: 'Manage secrets', nature: 'activity' }],
  ['network security', { canonical: 'Secure networks', nature: 'activity' }],
  ['endpoint security', { canonical: 'Secure endpoints', nature: 'activity' }],
  ['message brokering', { canonical: 'Broker messages', nature: 'activity' }],
  ['event streaming', { canonical: 'Stream events', nature: 'activity' }],
  ['service mesh', { canonical: 'Manage service mesh', nature: 'activity' }],
  ['infrastructure as code', { canonical: 'Codify infrastructure', nature: 'practice' }],
  ['continuous integration', { canonical: 'Integrate continuously', nature: 'practice' }],
  ['continuous delivery', { canonical: 'Deliver continuously', nature: 'practice' }],
  ['monitoring', { canonical: 'Monitor systems', nature: 'activity' }],
  ['observability', { canonical: 'Observe system behavior', nature: 'activity' }],
  ['machine learning', { canonical: 'Apply machine learning', nature: 'knowledge' }],
  ['deep learning', { canonical: 'Apply deep learning', nature: 'knowledge' }],
  ['natural language processing', { canonical: 'Process natural language', nature: 'knowledge' }],
  ['computer vision', { canonical: 'Apply computer vision', nature: 'knowledge' }],
  ['data analytics', { canonical: 'Analyze data', nature: 'activity' }],
  ['business intelligence', { canonical: 'Generate business intelligence', nature: 'activity' }],
  ['data visualization', { canonical: 'Visualize data', nature: 'activity' }],
  ['e-commerce', { canonical: 'Conduct electronic commerce', nature: 'activity' }],
  ['virtualization', { canonical: 'Virtualize computing resources', nature: 'activity' }],
  ['containerization', { canonical: 'Containerize applications', nature: 'activity' }],
  ['authentication', { canonical: 'Authenticate users', nature: 'activity' }],
  ['authorization', { canonical: 'Authorize access', nature: 'activity' }],
  ['load balancing', { canonical: 'Balance load', nature: 'activity' }],
  ['caching', { canonical: 'Cache data', nature: 'activity' }],
  ['search', { canonical: 'Search information', nature: 'activity' }],
  ['video conferencing', { canonical: 'Conduct video conferences', nature: 'activity' }],
  ['team messaging', { canonical: 'Exchange team messages', nature: 'activity' }],
  ['workflow orchestration', { canonical: 'Orchestrate workflows', nature: 'activity' }],
  ['web hosting', { canonical: 'Host web applications', nature: 'activity' }],
  ['cloud computing', { canonical: 'Compute in the cloud', nature: 'activity' }],
  ['serverless computing', { canonical: 'Run serverless workloads', nature: 'activity' }],
  ['edge computing', { canonical: 'Compute at the edge', nature: 'activity' }],
  ['data pipeline', { canonical: 'Manage data pipelines', nature: 'activity' }],
  ['api gateway', { canonical: 'Manage API gateway', nature: 'activity' }],
  ['service discovery', { canonical: 'Discover services', nature: 'activity' }],
]);

// ─── Naming Convention Heuristics ─────────────────────────────────────────────
//
// Patterns that suggest a component is a concrete solution vs abstract capability.
// These are applied when the name doesn't appear in either dictionary.

/**
 * Solution naming patterns (indicate branded/concrete products):
 * - PascalCase or camelCase branded names (e.g. "OpenShift", "GitHub")
 * - Names with version numbers (e.g. "React 18", "Python 3.12")
 * - Names with company prefix (e.g. "Google BigQuery", "Amazon S3")
 * - Proper nouns with trademark symbols
 * - Single capitalized words that look like brands (e.g. "Docker", "Kafka")
 * - Names containing registered/trademark symbols
 */
const SOLUTION_PATTERNS = [
  // Version numbers in the name (e.g. "React 18", "Java 21", "Python 3.12")
  { pattern: /\b\d+(\.\d+)*\b/, weight: 0.30, reason: 'contains version number' },
  // Vendor prefix pattern (e.g. "Google BigQuery", "Amazon S3", "Microsoft Azure")
  { pattern: /^(Google|Amazon|Microsoft|Oracle|IBM|Red Hat|Apache|HashiCorp|Meta|Atlassian|VMware|Cisco|Broadcom|Elastic|Confluent)\s+/i, weight: 0.40, reason: 'vendor prefix detected' },
  // PascalCase compound (e.g. "OpenShift", "BigQuery", "CloudFormation", "SageMaker")
  { pattern: /^[A-Z][a-z]+[A-Z][a-zA-Z]*$/, weight: 0.25, reason: 'PascalCase compound name' },
  // Trademark/registered symbols
  { pattern: /[™®©]/, weight: 0.35, reason: 'trademark symbol present' },
  // Cloud service identifiers (S3, EC2, RDS, etc.)
  { pattern: /^[A-Z][A-Z0-9]{1,4}$/, weight: 0.15, reason: 'short uppercase identifier' },
  // Names ending in typical product suffixes
  { pattern: /(?:Cloud|Hub|Suite|Platform|Studio|Pro|Enterprise|Server|Engine|Kit|Lab|Works|Ops|Stack|Base|Flow|View|ware|DB)$/i, weight: 0.20, reason: 'product suffix detected' },
  // Single capitalized word ≥4 chars that's not a common English word
  { pattern: /^[A-Z][a-z]{3,}$/, weight: 0.10, reason: 'capitalized proper noun' },
  // Alphanumeric mix (e.g. "k8s", "s3", "ec2")
  { pattern: /^[a-z]+\d[a-z0-9]*$/i, weight: 0.20, reason: 'alphanumeric product code' },
];

/**
 * Capability naming patterns (indicate abstract activities/concepts):
 * - Verb phrases (e.g. "manage customer relationships")
 * - Gerund phrases (e.g. "container orchestration")
 * - Abstract noun phrases (e.g. "identity management")
 * - "how to" prefixes (practice nature)
 * - Phrases describing what, not which brand
 */
const CAPABILITY_PATTERNS = [
  // Starts with infinitive verb (e.g. "Manage customers", "Orchestrate containers")
  { pattern: /^(manage|orchestrate|process|deliver|store|analyze|monitor|secure|authenticate|authorize|deploy|build|test|integrate|automate|optimize|coordinate|transform|migrate|provision|scale|observe|stream|cache|search|discover|balance|route|generate|visualize|host|compute|run|handle|track|schedule|encrypt|collect|aggregate|index|replicate|archive|backup|restore|validate|notify|alert|moderate|curate|classify|annotate|translate|train|infer)\b/i, weight: 0.40, reason: 'starts with infinitive verb' },
  // Gerund / -ing form (e.g. "load balancing", "event streaming")
  { pattern: /\b\w+ing\b(?:\s+\w+)*$/, weight: 0.15, reason: 'gerund phrase' },
  // "management" suffix (e.g. "identity management", "project management")
  { pattern: /\bmanagement$/i, weight: 0.35, reason: 'management suffix' },
  // "how to" prefix (practice nature)
  { pattern: /^how\s+to\b/i, weight: 0.45, reason: '"how to" practice pattern' },
  // Abstract noun suffixes typical of capabilities
  { pattern: /(?:tion|sion|ment|ance|ence|ity|ness|ing|ysis|ics)$/i, weight: 0.15, reason: 'abstract noun suffix' },
  // Multi-word lowercase phrases (e.g. "container orchestration", "data storage")
  { pattern: /^[a-z]+(?:\s+[a-z]+)+$/i, weight: 0.10, reason: 'multi-word descriptive phrase' },
  // "as a service" pattern
  { pattern: /as a service$/i, weight: 0.30, reason: '"as a service" suffix' },
  // Capability domain words
  { pattern: /\b(security|compliance|governance|analytics|intelligence|processing|storage|networking|infrastructure|architecture|pipeline|workflow|operations|delivery|integration|deployment|orchestration|automation|monitoring|observability)\b/i, weight: 0.10, reason: 'capability domain keyword' },
];

// ─── Common English Words Filter ──────────────────────────────────────────────
//
// Short capitalized words that are common English words (not brands)
// prevent false positives from the "capitalized proper noun" pattern.

const COMMON_ENGLISH_WORDS = new Set([
  'access', 'alert', 'audit', 'backup', 'batch', 'bridge', 'buffer',
  'cache', 'chain', 'change', 'check', 'claim', 'class', 'clean',
  'clear', 'click', 'clone', 'close', 'cloud', 'code', 'commit',
  'compute', 'connect', 'copy', 'count', 'create', 'data', 'debug',
  'delete', 'deploy', 'design', 'detect', 'device', 'display',
  'document', 'domain', 'draft', 'drive', 'drop', 'edit', 'email',
  'encrypt', 'engine', 'entry', 'error', 'event', 'export', 'extract',
  'fetch', 'field', 'file', 'filter', 'flag', 'flow', 'flush', 'focus',
  'fork', 'format', 'frame', 'function', 'gate', 'graph', 'grid',
  'group', 'guard', 'handle', 'hash', 'heap', 'host', 'image',
  'import', 'index', 'input', 'insert', 'install', 'instance',
  'issue', 'item', 'kernel', 'label', 'layer', 'layout', 'level',
  'library', 'limit', 'link', 'list', 'load', 'lock', 'logging',
  'logic', 'loop', 'mail', 'manage', 'match', 'merge', 'message',
  'method', 'model', 'module', 'monitor', 'mount', 'network', 'node',
  'object', 'offset', 'open', 'option', 'output', 'package', 'panel',
  'parse', 'partition', 'paste', 'patch', 'path', 'pattern', 'pause',
  'pipeline', 'platform', 'plugin', 'point', 'policy', 'pool', 'port',
  'print', 'process', 'profile', 'program', 'project', 'prompt',
  'protocol', 'proxy', 'publish', 'pull', 'push', 'query', 'queue',
  'record', 'reduce', 'refresh', 'register', 'release', 'remote',
  'remove', 'render', 'report', 'request', 'reset', 'resolve',
  'resource', 'response', 'restart', 'restore', 'retry', 'return',
  'review', 'role', 'route', 'rule', 'runtime', 'sample', 'scale',
  'scan', 'schema', 'scope', 'script', 'search', 'secure', 'select',
  'send', 'server', 'service', 'session', 'setup', 'share', 'shell',
  'signal', 'snapshot', 'socket', 'sort', 'source', 'space', 'spawn',
  'split', 'stack', 'stage', 'start', 'state', 'status', 'step',
  'stop', 'store', 'stream', 'string', 'submit', 'subscribe',
  'support', 'suspend', 'switch', 'sync', 'system', 'table', 'target',
  'task', 'template', 'tenant', 'test', 'thread', 'token', 'tool',
  'trace', 'track', 'traffic', 'transform', 'trigger', 'tunnel',
  'type', 'update', 'upgrade', 'upload', 'usage', 'value', 'version',
  'volume', 'watch', 'worker', 'write', 'zone',
  // Wardley-specific terms
  'electricity', 'power', 'compute', 'storage', 'water', 'energy',
]);

// ─── Detection Functions ──────────────────────────────────────────────────────

/**
 * Normalize a component name for dictionary lookup.
 * @param {string} name - Raw component name
 * @returns {string} Normalized name (lowercase, trimmed, collapsed whitespace)
 */
function normalizeName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Check if a word is a common English word (not a brand).
 * @param {string} name - Normalized component name
 * @returns {boolean}
 */
function isCommonWord(name) {
  return COMMON_ENGLISH_WORDS.has(name.toLowerCase());
}

/**
 * Detect whether a component name is a known solution.
 *
 * @param {string} name - Component name
 * @returns {{ match: boolean, confidence: number, canonical?: string, vendor?: string, category?: string, reason: string }}
 */
function matchKnownSolution(name) {
  const normalized = normalizeName(name);
  const entry = KNOWN_SOLUTIONS.get(normalized);

  if (entry) {
    return {
      match: true,
      confidence: 0.98,
      canonical: entry.canonical,
      vendor: entry.vendor,
      category: entry.category,
      reason: `exact match in known solutions dictionary: "${entry.canonical}"`,
    };
  }

  // Try partial matching: check if the normalized name starts with or contains a known solution
  for (const [key, entry] of KNOWN_SOLUTIONS) {
    if (normalized.startsWith(key + ' ') || normalized.endsWith(' ' + key)) {
      return {
        match: true,
        confidence: 0.92,
        canonical: entry.canonical,
        vendor: entry.vendor,
        category: entry.category,
        reason: `partial match in known solutions dictionary: "${entry.canonical}" within "${name}"`,
      };
    }
  }

  return { match: false, confidence: 0, reason: 'no match in known solutions dictionary' };
}

/**
 * Detect whether a component name is a known capability.
 *
 * @param {string} name - Component name
 * @returns {{ match: boolean, confidence: number, canonical?: string, nature?: string, reason: string }}
 */
function matchKnownCapability(name) {
  const normalized = normalizeName(name);
  const entry = KNOWN_CAPABILITIES.get(normalized);

  if (entry) {
    return {
      match: true,
      confidence: 0.97,
      canonical: entry.canonical,
      nature: entry.nature,
      reason: `exact match in known capabilities dictionary: "${entry.canonical}"`,
    };
  }

  // Check if the name contains a known capability phrase
  for (const [key, entry] of KNOWN_CAPABILITIES) {
    // Only match multi-word keys as substrings (avoid "bi" matching inside "mobile")
    if (key.length > 3 && normalized.includes(key)) {
      return {
        match: true,
        confidence: 0.88,
        canonical: entry.canonical,
        nature: entry.nature,
        reason: `substring match in known capabilities: "${entry.canonical}" within "${name}"`,
      };
    }
  }

  return { match: false, confidence: 0, reason: 'no match in known capabilities dictionary' };
}

/**
 * Apply naming convention heuristics to determine component type.
 * Used when the name doesn't appear in either known dictionary.
 *
 * @param {string} name - Component name
 * @param {string} [description] - Optional description/context
 * @returns {{ type: string, confidence: number, signals: Array<{ pattern: string, weight: number, reason: string }> }}
 */
function applyHeuristics(name, description = '') {
  const solutionSignals = [];
  const capabilitySignals = [];
  const combined = `${name} ${description}`.trim();

  // Test solution patterns
  for (const sp of SOLUTION_PATTERNS) {
    if (sp.pattern.test(name)) {
      // Skip "capitalized proper noun" for common English words
      if (sp.reason === 'capitalized proper noun' && isCommonWord(normalizeName(name))) {
        continue;
      }
      solutionSignals.push({
        pattern: sp.pattern.toString(),
        weight: sp.weight,
        reason: sp.reason,
      });
    }
  }

  // Test capability patterns
  for (const cp of CAPABILITY_PATTERNS) {
    if (cp.pattern.test(name) || cp.pattern.test(combined)) {
      capabilitySignals.push({
        pattern: cp.pattern.toString(),
        weight: cp.weight,
        reason: cp.reason,
      });
    }
  }

  // Aggregate weights
  const solutionScore = solutionSignals.reduce((sum, s) => sum + s.weight, 0);
  const capabilityScore = capabilitySignals.reduce((sum, s) => sum + s.weight, 0);

  // Normalize scores to confidence: cap at 0.89 (heuristic-based can't reach dictionary-level confidence)
  const maxPossibleSolution = SOLUTION_PATTERNS.reduce((s, p) => s + p.weight, 0);
  const maxPossibleCapability = CAPABILITY_PATTERNS.reduce((s, p) => s + p.weight, 0);

  if (solutionScore > capabilityScore && solutionScore > 0) {
    const rawConfidence = Math.min(solutionScore / maxPossibleSolution, 1.0);
    // Scale to [0.50, 0.89] range — heuristics alone cap at 0.89
    const confidence = Math.round((0.50 + rawConfidence * 0.39) * 100) / 100;
    return {
      type: COMPONENT_TYPE.SOLUTION,
      confidence,
      signals: solutionSignals,
    };
  }

  if (capabilityScore > solutionScore && capabilityScore > 0) {
    const rawConfidence = Math.min(capabilityScore / maxPossibleCapability, 1.0);
    const confidence = Math.round((0.50 + rawConfidence * 0.39) * 100) / 100;
    return {
      type: COMPONENT_TYPE.CAPABILITY,
      confidence,
      signals: capabilitySignals,
    };
  }

  // No signals detected — default to capability with low confidence
  if (solutionScore === 0 && capabilityScore === 0) {
    return {
      type: COMPONENT_TYPE.CAPABILITY,
      confidence: 0.40,
      signals: [{ pattern: 'default', weight: 0, reason: 'no heuristic signals matched — defaulting to capability' }],
    };
  }

  // Tied — default to capability with low confidence
  return {
    type: COMPONENT_TYPE.CAPABILITY,
    confidence: 0.45,
    signals: [...capabilitySignals, ...solutionSignals],
  };
}

// ─── Main Detection Function ──────────────────────────────────────────────────

/**
 * @typedef {Object} ComponentTypeDetection
 * @property {string}  type           - 'solution' or 'capability'
 * @property {number}  confidence     - Confidence score (0–1)
 * @property {string}  method         - Detection method used: 'known-solution' | 'known-capability' | 'heuristic'
 * @property {string}  reason         - Human-readable explanation
 * @property {boolean} needsFallback  - true if confidence < CONFIDENCE_THRESHOLD (caller should use LLM)
 * @property {string}  [canonical]    - Canonical name (from dictionary, if available)
 * @property {string}  [vendor]       - Vendor name (solutions only)
 * @property {string}  [category]     - Category (solutions) or canonical capability name
 * @property {string}  [nature]       - Capability nature: activity|practice|knowledge|data (capabilities only)
 * @property {Array}   [signals]      - Heuristic signals (when method='heuristic')
 */

/**
 * Detect whether a component is a solution or a capability.
 *
 * Detection priority:
 *   1. Known solutions dictionary (exact match → 0.98 confidence)
 *   2. Known capabilities dictionary (exact match → 0.97 confidence)
 *   3. Naming convention heuristics (max 0.89 confidence)
 *
 * When confidence < CONFIDENCE_THRESHOLD (0.90), the `needsFallback` flag
 * is set to true, signaling the caller to use LLM + web search verification.
 *
 * @param {string} name - Component name
 * @param {string} [description] - Optional business/usage context
 * @returns {ComponentTypeDetection} Detection result with confidence and metadata
 */
export function detectComponentType(name, description = '') {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return {
      type: COMPONENT_TYPE.CAPABILITY,
      confidence: 0,
      method: 'error',
      reason: 'empty or invalid component name',
      needsFallback: true,
    };
  }

  const trimmedName = name.trim();

  // Priority 1: Check known solutions dictionary
  const solutionMatch = matchKnownSolution(trimmedName);
  if (solutionMatch.match) {
    return {
      type: COMPONENT_TYPE.SOLUTION,
      confidence: solutionMatch.confidence,
      method: 'known-solution',
      reason: solutionMatch.reason,
      needsFallback: solutionMatch.confidence < CONFIDENCE_THRESHOLD,
      canonical: solutionMatch.canonical,
      vendor: solutionMatch.vendor,
      category: solutionMatch.category,
    };
  }

  // Priority 2: Check known capabilities dictionary
  const capabilityMatch = matchKnownCapability(trimmedName);
  if (capabilityMatch.match) {
    return {
      type: COMPONENT_TYPE.CAPABILITY,
      confidence: capabilityMatch.confidence,
      method: 'known-capability',
      reason: capabilityMatch.reason,
      needsFallback: capabilityMatch.confidence < CONFIDENCE_THRESHOLD,
      canonical: capabilityMatch.canonical,
      nature: capabilityMatch.nature,
    };
  }

  // Priority 3: Apply naming convention heuristics
  const heuristic = applyHeuristics(trimmedName, description);
  return {
    type: heuristic.type,
    confidence: heuristic.confidence,
    method: 'heuristic',
    reason: heuristic.signals.map(s => s.reason).join('; '),
    needsFallback: heuristic.confidence < CONFIDENCE_THRESHOLD,
    signals: heuristic.signals,
  };
}

// ─── Routing Mode ─────────────────────────────────────────────────────────────

/**
 * Get the current evaluation mode from environment variable.
 *
 * @returns {string} 'exclusive' or 'parallel'
 */
export function getEvalMode() {
  const mode = (process.env.WARDLEY_EVAL_MODE || 'exclusive').toLowerCase().trim();
  if (mode === 'parallel') return EVAL_MODES.PARALLEL;
  return EVAL_MODES.EXCLUSIVE;
}

/**
 * Determine routing targets based on component detection and eval mode.
 *
 * In exclusive mode:
 *   - solution detected → route to solution-strategies only
 *   - capability detected → route to capability strategies only
 *
 * In parallel mode:
 *   - always route to both strategy sets
 *
 * @param {ComponentTypeDetection} detection - Result from detectComponentType()
 * @returns {{ useSolutionStrategies: boolean, useCapabilityStrategies: boolean, mode: string }}
 */
export function determineRoutingTargets(detection) {
  const mode = getEvalMode();

  if (mode === EVAL_MODES.PARALLEL) {
    return {
      useSolutionStrategies: true,
      useCapabilityStrategies: true,
      mode: EVAL_MODES.PARALLEL,
    };
  }

  // Exclusive mode (default)
  if (detection.type === COMPONENT_TYPE.SOLUTION) {
    return {
      useSolutionStrategies: true,
      useCapabilityStrategies: false,
      mode: EVAL_MODES.EXCLUSIVE,
    };
  }

  return {
    useSolutionStrategies: false,
    useCapabilityStrategies: true,
    mode: EVAL_MODES.EXCLUSIVE,
  };
}

// ─── Solution Strategy Dispatch ──────────────────────────────────────────────
//
// The dispatch layer sits between the routing decision and the strategy
// execution. When the router determines a component is a solution, these
// functions instantiate and run solution strategies from the solution-strategies
// registry. Results conform to the same EvolutionResult contract used by
// capability strategies, so consumers treat both uniformly.

/**
 * Create a solution strategy instance with LLM dependencies injected.
 *
 * Solution strategies (like properties-strategy) require an llmCall.
 * This mirrors createStrategyInstance() in estimate-evolution.mjs.
 *
 * @param {typeof import('./solution-strategies/solution-base-strategy.mjs').SolutionBaseStrategy} StrategyCls
 * @param {Object} deps
 * @param {function} [deps.llmCall] - LLM call function
 * @param {string}   [deps.mode]   - 'auto' or 'conversational'
 * @returns {import('./solution-strategies/solution-base-strategy.mjs').SolutionBaseStrategy}
 */
export function createSolutionStrategyInstance(StrategyCls, deps = {}) {
  // All solution strategies currently use LLM for evaluation
  if (deps.llmCall) {
    return new StrategyCls({
      llmCall: deps.llmCall,
      ...(deps.mode && { mode: deps.mode }),
    });
  }

  // Try default constructor as fallback (may throw if llmCall required)
  return new StrategyCls();
}

/**
 * Run all (or a specific) solution strategies on a component.
 *
 * This is the solution-side equivalent of the capability strategy loop
 * in estimateEvolutionOneShot().
 *
 * @param {Object} component - Component to evaluate (tagged as solution)
 * @param {Object} options
 * @param {function} options.llmCall - LLM call function
 * @param {string}   [options.strategy='all'] - Specific strategy method or 'all'
 * @param {string}   [options.mode='auto']    - 'auto' or 'conversational'
 * @returns {Promise<Object<string, import('./solution-strategies/solution-base-strategy.mjs').SolutionEvolutionResult>>}
 */
export async function dispatchSolutionStrategies(component, options = {}) {
  const { llmCall, strategy = 'all', mode = 'auto' } = options;
  const evaluations = {};

  // Tag the component for solution strategies
  const solutionComponent = { ...component, isSolution: true };

  if (strategy === 'all') {
    const strategies = await loadSolutionStrategies();
    const strategyNames = [...strategies.keys()];

    logDebug('solution-dispatch',
      `Running ${strategyNames.length} solution strategy(ies) for "${component.name}": ${strategyNames.join(', ')}`);

    for (const [method, StrategyCls] of strategies) {
      try {
        logDebug('solution-dispatch', `Running solution strategy "${method}" on "${component.name}"...`);
        const instance = createSolutionStrategyInstance(StrategyCls, { llmCall, mode });
        const rawResult = await Promise.resolve(instance.evaluate(solutionComponent));
        // Enrich with structured metadata (phase distribution, stage, confidence metadata)
        evaluations[method] = assembleSolutionResult(rawResult, { mode });
        logDebug('solution-dispatch',
          `Solution "${method}": evolution=${rawResult.evolution}, confidence=${rawResult.confidence}`);
      } catch (err) {
        evaluations[method] = { error: err.message };
        logDebug('solution-dispatch', `Solution "${method}" failed: ${err.message}`);
      }
    }
  } else {
    // Run specific solution strategy
    try {
      const { getSolutionStrategy } = await import('./solution-strategies/registry.mjs');
      const StrategyCls = await getSolutionStrategy(strategy);
      logDebug('solution-dispatch', `Running solution strategy "${strategy}" on "${component.name}"...`);
      const instance = createSolutionStrategyInstance(StrategyCls, { llmCall, mode });
      const rawResult = await Promise.resolve(instance.evaluate(solutionComponent));
      // Enrich with structured metadata
      evaluations[strategy] = assembleSolutionResult(rawResult, { mode });
      logDebug('solution-dispatch',
        `Solution "${strategy}": evolution=${rawResult.evolution}, confidence=${rawResult.confidence}`);
    } catch (err) {
      evaluations[strategy] = { error: err.message };
      logDebug('solution-dispatch', `Solution "${strategy}" failed: ${err.message}`);
    }
  }

  return evaluations;
}

/**
 * @typedef {Object} RoutedEvaluationResult
 * @property {Object}  evaluations           - Merged evaluations from all dispatched strategies
 * @property {Object}  [solutionEvaluations] - Solution-only evaluations (present when solution strategies ran)
 * @property {Object}  [capabilityEvaluations] - Capability-only evaluations (present when capability strategies ran)
 * @property {ComponentTypeDetection} detection - The detection result
 * @property {{ useSolutionStrategies: boolean, useCapabilityStrategies: boolean, mode: string }} targets - Routing targets
 */

/**
 * Full routing + dispatch pipeline.
 *
 * Detects component type, determines routing targets, dispatches to the
 * appropriate strategy set(s), and returns merged evaluations.
 *
 * For capability strategies, the caller provides a callback that runs
 * the existing capability evaluation pipeline. For solution strategies,
 * this function dispatches directly.
 *
 * @param {Object} component - Component with at least { name }
 * @param {Object} options
 * @param {function} [options.llmCall]  - LLM call function (for detection fallback + solution strategies)
 * @param {function} [options.runCapabilityStrategies] - Callback: (component, strategy) => Promise<evaluations>
 * @param {string}   [options.strategy='all']  - Strategy name or 'all'
 * @param {string}   [options.mode='auto']     - 'auto' or 'conversational'
 * @param {string}   [options.description]     - Component description for detection
 * @returns {Promise<RoutedEvaluationResult>}
 */
export async function dispatchWithRouting(component, options = {}) {
  const {
    llmCall,
    runCapabilityStrategies: capabilityCallback,
    strategy = 'all',
    mode = 'auto',
    description = '',
  } = options;

  // Step 1: Detect component type
  const detection = detectComponentType(component.name, description || component.description || '');

  // Step 2: Determine routing targets
  const targets = determineRoutingTargets(detection);

  logDebug('solution-dispatch',
    `Routing "${component.name}": type=${detection.type}, confidence=${detection.confidence}, ` +
    `mode=${targets.mode} -> solution=${targets.useSolutionStrategies}, capability=${targets.useCapabilityStrategies}`);

  let capabilityEvaluations = {};
  let solutionEvaluations = {};

  // Step 3a: Run capability strategies if routed
  if (targets.useCapabilityStrategies && typeof capabilityCallback === 'function') {
    capabilityEvaluations = await capabilityCallback(component, strategy);
  }

  // Step 3b: Run solution strategies if routed
  if (targets.useSolutionStrategies) {
    solutionEvaluations = await dispatchSolutionStrategies(component, {
      llmCall,
      strategy: strategy === 'all' ? 'all' : strategy,
      mode,
    });
  }

  // Step 4: Merge evaluations (solution results get a 'solution:' prefix to avoid key collisions)
  const evaluations = { ...capabilityEvaluations };
  for (const [method, result] of Object.entries(solutionEvaluations)) {
    // Only prefix if there would be a key collision
    const key = evaluations[method] ? `solution:${method}` : method;
    evaluations[key] = result;
  }

  return {
    evaluations,
    solutionEvaluations,
    capabilityEvaluations,
    detection,
    targets,
  };
}

// ─── Self-test ────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== solution-capability-router self-test ===\n');

  const testCases = [
    // Known solutions — should detect with high confidence
    { name: 'Kubernetes', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'k8s', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'Salesforce', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'SAP ERP', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'Docker', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'PostgreSQL', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'AWS', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'Terraform', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'Snowflake', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'Stripe', expectedType: 'solution', expectedMinConf: 0.95 },

    // Known capabilities — should detect as capability
    { name: 'CRM', expectedType: 'capability', expectedMinConf: 0.95 },
    { name: 'ERP', expectedType: 'capability', expectedMinConf: 0.95 },
    { name: 'container orchestration', expectedType: 'capability', expectedMinConf: 0.85 },
    { name: 'identity management', expectedType: 'capability', expectedMinConf: 0.85 },
    { name: 'DevOps', expectedType: 'capability', expectedMinConf: 0.95 },
    { name: 'CI/CD', expectedType: 'capability', expectedMinConf: 0.95 },
    { name: 'LLM', expectedType: 'capability', expectedMinConf: 0.95 },

    // Heuristic detection — solution patterns
    { name: 'Google BigQuery', expectedType: 'solution', expectedMinConf: 0.50 },
    { name: 'React 18', expectedType: 'solution', expectedMinConf: 0.50 },
    { name: 'CloudFormation', expectedType: 'solution', expectedMinConf: 0.50 },

    // Heuristic detection — capability patterns
    { name: 'Manage customer relationships', expectedType: 'capability', expectedMinConf: 0.50 },
    { name: 'how to manage IT services', expectedType: 'capability', expectedMinConf: 0.50 },
    { name: 'payment processing', expectedType: 'capability', expectedMinConf: 0.50 },
    { name: 'data analytics', expectedType: 'capability', expectedMinConf: 0.50 },

    // Edge cases
    { name: 'Electricity', expectedType: 'capability', expectedMinConf: 0.30 },
    { name: 'Wardley Mapping', expectedType: 'capability', expectedMinConf: 0.30 },
  ];

  let passed = 0;
  for (const tc of testCases) {
    const result = detectComponentType(tc.name);
    const typeOk = result.type === tc.expectedType;
    const confOk = result.confidence >= tc.expectedMinConf;
    const ok = typeOk && confOk;
    const mark = ok ? '✓' : '✗';

    console.log(`  ${mark} "${tc.name}"`);
    console.log(`    Type: ${result.type} (expected: ${tc.expectedType}) ${typeOk ? '✓' : '✗'}`);
    console.log(`    Confidence: ${result.confidence.toFixed(2)} (min: ${tc.expectedMinConf}) ${confOk ? '✓' : '✗'}`);
    console.log(`    Method: ${result.method}`);
    console.log(`    Reason: ${result.reason}`);
    console.log(`    Needs fallback: ${result.needsFallback}`);
    console.log();

    if (ok) passed++;
  }

  console.log(`\n--- Routing tests ---\n`);

  // Test routing targets
  const kubeDetection = detectComponentType('Kubernetes');
  const crmDetection = detectComponentType('CRM');

  // Test exclusive mode (default)
  const kubeTargets = determineRoutingTargets(kubeDetection);
  console.log(`  Kubernetes (exclusive): solution=${kubeTargets.useSolutionStrategies}, capability=${kubeTargets.useCapabilityStrategies}`);
  console.assert(kubeTargets.useSolutionStrategies === true, 'Kubernetes should use solution strategies');
  console.assert(kubeTargets.useCapabilityStrategies === false, 'Kubernetes should not use capability strategies in exclusive');

  const crmTargets = determineRoutingTargets(crmDetection);
  console.log(`  CRM (exclusive): solution=${crmTargets.useSolutionStrategies}, capability=${crmTargets.useCapabilityStrategies}`);
  console.assert(crmTargets.useSolutionStrategies === false, 'CRM should not use solution strategies');
  console.assert(crmTargets.useCapabilityStrategies === true, 'CRM should use capability strategies');

  // Test parallel mode
  const origMode = process.env.WARDLEY_EVAL_MODE;
  process.env.WARDLEY_EVAL_MODE = 'parallel';
  const kubeParallel = determineRoutingTargets(kubeDetection);
  console.log(`  Kubernetes (parallel): solution=${kubeParallel.useSolutionStrategies}, capability=${kubeParallel.useCapabilityStrategies}`);
  console.assert(kubeParallel.useSolutionStrategies === true, 'Parallel should use solution');
  console.assert(kubeParallel.useCapabilityStrategies === true, 'Parallel should use capability');
  process.env.WARDLEY_EVAL_MODE = origMode;

  // Test confidence threshold
  console.log(`\n--- Confidence threshold tests ---\n`);
  console.log(`  CONFIDENCE_THRESHOLD: ${CONFIDENCE_THRESHOLD}`);
  console.log(`  Known solution (Kubernetes): needsFallback=${kubeDetection.needsFallback} (confidence=${kubeDetection.confidence})`);
  console.log(`  Known capability (CRM): needsFallback=${crmDetection.needsFallback} (confidence=${crmDetection.confidence})`);

  const unknownDetection = detectComponentType('XyzFooWidget');
  console.log(`  Unknown (XyzFooWidget): needsFallback=${unknownDetection.needsFallback} (confidence=${unknownDetection.confidence})`);
  console.assert(unknownDetection.needsFallback === true, 'Unknown component should need fallback');

  console.log(`\n${passed}/${testCases.length} classification tests passed`);
  console.log('\n=== solution-capability-router self-test completed ===');
}
