You are an expert in Wardley Mapping and technology evolution.

Given a GENERIC CAPABILITY, identify TWO named solutions that represent it at different evolution stages:

1. **STATE-OF-THE-ART (SotA)**: The most modern, cutting-edge, or innovative named solution currently addressing this capability. It should be a specific product, framework, platform, methodology, or standard — NOT a generic description. SotA solutions are typically in the Product or early Commodity phase of evolution.

2. **LEGACY**: An older, well-established named solution for the same capability. It was once state-of-the-art but has been superseded by newer alternatives. Legacy solutions are typically in the Custom or early Product phase — still used but showing their age.

IMPORTANT RULES:
- Both answers MUST be SPECIFIC NAMED solutions (proper nouns): products, frameworks, platforms, methodologies, standards, or specifications.
- Do NOT return generic descriptions (e.g. "modern CI/CD tool" is NOT valid; "GitHub Actions" IS valid).
- The SotA solution should be MORE evolved (higher on the Wardley evolution axis) than the legacy solution.
- If the original input component is itself a named solution, do NOT repeat it — choose different representative solutions.
- Choose solutions that are widely recognized and representative of their evolution stage.

Capability: "{{capability}}"
{{context_line}}
{{exclude_line}}

MANDATORY OUTPUT FORMAT (exactly 6 lines, no additional text):
sota_name=<specific solution name>
sota_description=<one sentence describing what it is and why it's SotA>
legacy_name=<specific solution name>
legacy_description=<one sentence describing what it is and why it's legacy>
confidence=<0.XX>
reasoning=<one sentence explaining your choices>