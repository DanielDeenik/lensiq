# CV tailoring and cover letter rules

These rules govern every CV and cover letter the agent produces from a pasted job spec.
The output is a draft for Dan. Nothing reaches the sender until Dan approves it in the console.

## Absolute limits
- Every claim must trace to `cv_master_md` or `fact_base` in app_config. If the spec asks for something Dan has not done, the CV does not claim it. Gaps are handled by leading with the nearest real experience, never by inventing.
- Never invent employers, dates, tools, certifications, metrics or outcomes. Never round a duration up.
- Never state a rate, a salary, a notice period or an availability date. Those are Dan's to say.
- Never include client project internals beyond what the master CV already states.
- Keep contact details exactly as the master CV has them.
- No em dashes. No arrow characters. Plain prose.

## Weigh the spec against depth, never against the first match

`skill_profile` in app_config is the judgement. Every area carries a tier, and the tier
decides what a match is worth:

- **primary**: what Dan is hired for. Front office and order management, IBOR and position
  keeping, SimCorp Dimension itself, compliance, risk in the platform sense, alternative
  investments, and data management, meaning security and static setup, valuations and
  pricing, data imports and their date handling, corporate actions and validation.
- **strong**: delivered repeatedly. Interfaces and connectivity, regulatory reporting and
  ESG, business analysis and delivery, extraction and SQL and Python, Aladdin and Front
  Arena, AI and machine learning.
- **working**: supports his delivery but is not the seat he takes. The Communication Server
  is the clearest case. He has a strong background using it as part of data integration
  work, and that is exactly how it must be described. Never write a CV or a fit report that
  reads as though he is a Communication Server specialist. Middle and back office sit here too.
- **adjacent**: next to his work, not inside it. Axioma and quantitative risk modelling
  belong here. He integrated the Axioma API at BNP Paribas. Building, calibrating or
  validating risk models is a different job and the report must say so, naming that the
  client wants someone with hands on Axioma modelling experience.
- **not_a_fit**: platforms and disciplines not on his CV, and permanent employment.

Rules that follow from this:

1. Score by weighted coverage, not by how many terms matched. A spec whose centre of
   gravity is a working or adjacent area scores low even when many terms are recognised.
2. Name the centre of gravity of the spec in the first two sentences of the fit report.
3. Where the spec's must-haves fall outside primary and strong, say it plainly and early.
   Being honest about the Axioma modelling gap is what makes the SimCorp claims credible.
4. What goes to the recruiter must lead with the front office, IBOR, integrations and
   data management evidence, because that is where the depth actually is.
5. Use each area's own `line` from skill_profile when you explain a match or a gap. Those
   sentences are Dan's framing of his own work, so do not rewrite them into something
   stronger or weaker than he said.

## What tailoring means
1. Read the spec and extract: role title, company, seniority, must-have skills, nice-to-have skills, the systems named, the regulations named, the domain, the location and working pattern, and the three things the spec repeats or puts first.
2. Rewrite the SUMMARY so the first sentence answers the spec's top requirement with Dan's matching real experience, named and dated.
3. Reorder the EXPERIENCE bullets inside each role so the ones that match the spec come first. Keep every role and every date. Do not delete roles.
4. Rewrite bullets to use the spec's own vocabulary where the underlying work is genuinely the same. If the spec says "regulatory reporting" and the master says "regulatory data extractions", use the spec's phrase and keep the specific detail.
5. Promote the CORE COMPETENCIES and SKILLS lines that the spec names; demote the rest. Do not add a skill that is not in the master.
6. Trim the CV to fit two pages of content. Cut the oldest, least relevant detail first.
7. Keep CERTIFICATIONS, EDUCATION and LANGUAGES intact.

## Cover letter
- Between 180 and 280 words. Four paragraphs.
- Paragraph one: the role and the single strongest reason Dan fits, with a named engagement.
- Paragraph two: the two or three must-haves from the spec, each answered with a specific engagement, system and date range.
- Paragraph three: one honest note on anything the spec asks for that Dan has adjacent rather than direct experience in, framed as how he would close it fast. Only include this if such a gap exists.
- Paragraph four: what he would want to understand in a first conversation, then a plain sign off.
- Address the recruiter by name if known, otherwise "Hello".
- No flattery about the company. No claims about enthusiasm. Specifics only.

## Fit report, for Dan and for the recruiter reply
- Score out of 100 with the arithmetic shown: must-haves matched, nice-to-haves matched, and anything missing.
- List every requirement with matched or not matched, and the engagement and dates that prove each match.
- State plainly what Dan does not have. That is what makes the rest credible.
