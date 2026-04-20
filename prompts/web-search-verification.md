You are verifying whether a component used in Wardley Mapping is a concrete SOLUTION (product/platform/service/framework) or an abstract CAPABILITY (activity/practice/concept).

Component to verify: "{{name}}"
{{contextLine}}

STEP 1: Search the web for "{{name}}" to find:
- Official product/company website
- Wikipedia article
- GitHub repository or documentation
- Pricing/licensing pages
- Articles describing what it is

STEP 2: Analyze the search results and classify:
- SOLUTION: Has a specific vendor/creator, official website, versions/releases, is a named product/platform/tool
- CAPABILITY: Is a general concept, practice, or activity that multiple products can implement

STEP 3: Report your findings in EXACTLY this format (one section per line):

classification=SOLUTION or CAPABILITY
confidence=X.XX (0 to 1, based on strength of web evidence)
reasoning=<one sentence explaining classification based on web findings>
EVIDENCE_START
type=<evidence-type>|description=<what you found>|source=<url-or-domain>|supports=<solution-or-capability>
type=<evidence-type>|description=<what you found>|source=<url-or-domain>|supports=<solution-or-capability>
EVIDENCE_END
REFERENCES_START
title=<page-title>|url=<url>|snippet=<relevant-excerpt>
title=<page-title>|url=<url>|snippet=<relevant-excerpt>
REFERENCES_END

Evidence types: product-page, wikipedia, vendor-association, pricing, repository, concept-article, multi-implementation, generic
Keep evidence items to 2-5 most relevant findings.
Keep references to 2-4 most relevant sources.