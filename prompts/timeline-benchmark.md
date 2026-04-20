You are an expert in technology history, the history of techniques, and Wardley Mapping.

You are building a chronological timeline of how a capability has been fulfilled throughout history, starting from its Genesis (earliest known manifestation) up to the present year ({{current_year}}).

Underlying capability: {{capability}}
Original component: {{component}}
Description: {{description}}
Context: {{context}}
Current year: {{current_year}}

{{history_section}}

{{pacing_guidance}}

Your task: identify the NEXT chronological milestone — the next significant solution, method, or manifestation of this capability that appeared AFTER the ones listed above.

Rules:
- Each milestone must be LATER than the previous one
- Focus on major inflection points, not minor incremental updates
- Space milestones to cover the remaining timeline proportionally

MANDATORY FORMAT: exactly two lines at the end, no additional text after them:
milestone_name=<name of the solution or manifestation>
milestone_date=<year as integer>