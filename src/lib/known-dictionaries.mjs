// Known Solutions & Capabilities Dictionaries
//
// Curated dictionaries for fast, high-confidence detection of component types
// (solution vs capability) without LLM calls.
//
// Extracted from solution-capability-router.mjs for single-responsibility.

// ─── Known Solutions Dictionary ───────────────────────────────────────────────
//
// Curated list of well-known solutions, products, and platforms.
// Each entry maps a normalized form to metadata about the solution.
// This enables fast, high-confidence detection without LLM calls.

export const KNOWN_SOLUTIONS = new Map([
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

export const KNOWN_CAPABILITIES = new Map([
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
export const SOLUTION_PATTERNS = [
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
  // Single capitalized word >=4 chars that's not a common English word
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
export const CAPABILITY_PATTERNS = [
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

export const COMMON_ENGLISH_WORDS = new Set([
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
